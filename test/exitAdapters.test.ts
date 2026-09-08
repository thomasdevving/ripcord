/**
 * THE ADAPTER ABSTRACTION — does it actually hold?
 *
 * The claim being tested is not "Comet still works" (test/exitRestrictionExecution
 * covers that). It is that the executor is genuinely protocol-agnostic: a second
 * protocol, shaped as differently from Comet as anything in scope, runs the whole
 * differential — control exit, snapshot isolation, clock matching, mutation,
 * re-exit, fail-closed composition — without the executor containing a single
 * branch that knows what it is.
 *
 * FiatToken is that second protocol precisely because it shares almost nothing
 * with Comet: no approve, no supply, no position to unwind, and a restriction
 * that is PER-ACCOUNT (`blacklist(holder)`) rather than a protocol-wide flag. If
 * the split were leaky, this is where it would show.
 *
 * The negative cases matter as much as the positive one. An adapter that has not
 * been validated on a chain must not decide a verdict there; an ineffective
 * mutation must not read as a clean exit; and a freeze that lands must produce a
 * zero-notice route exactly as Comet's pause does.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, toFunctionSelector, type Hex } from "viem";
import { EXIT_ADAPTERS, identifyAdapter, adapterById, supportsAssetScenarios } from "../src/fork/adapters/index.js";
import { FIAT_TOKEN_SELECTORS, fiatTokenAdapter } from "../src/fork/adapters/fiatToken.js";
import { COMET_SELECTORS, cometAdapter } from "../src/fork/adapters/comet.js";
import { whaleFor, TOKEN_WHALES } from "../src/fork/adapters/funding.js";
import { runExitRestrictionEngine } from "../src/fork/exitRestriction.js";
import { exitRestrictionSchema } from "../src/report/schema.js";

const h = vi.hoisted(() => ({ fork: null as any }));
vi.mock("../src/fork/anvil.js", () => ({ startAnvilFork: async () => h.fork }));
vi.mock("../src/fork/preflight.js", () => ({ checkAnvilAvailable: async () => ({ executable: "mock", available: true, version: "mock" }) }));

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const BLACKLISTER = "0x000000000000000000000000000000000000dEaD";
const HOLDER = "0x000000000000000000000000000000000000abc1";
const SINK = "0x000000000000000000000000000000000000abc2";
const COMPLETE = { complete: true as const, gaps: [], note: "complete" };

/** Encodes `Error(string)` exactly as a Solidity `require` with a message would. */
function errorString(message: string): Hex {
  return (toFunctionSelector("Error(string)") + encodeAbiParameters([{ type: "string" }], [message]).slice(2)) as Hex;
}
const BLACKLIST_REVERT = errorString("Blacklistable: account is blacklisted");

function capabilities(selectors: Hex[]) {
  return {
    taxonomyVersion: "0.2.0",
    selectorAnalyzer: { name: "evmole", version: "0.9.3" },
    dispatcherRecognized: true,
    scannedAddress: null,
    probedAddress: USDC,
    selectorsExtracted: selectors.length,
    unmatchedSelectors: selectors,
    findings: [],
    needsManualVerification: [],
    evidence: [],
  } as never;
}

const FIAT_FINGERPRINT = [
  FIAT_TOKEN_SELECTORS.transfer,
  FIAT_TOKEN_SELECTORS.blacklist,
  FIAT_TOKEN_SELECTORS.isBlacklisted,
  FIAT_TOKEN_SELECTORS.blacklister,
];

let config: { freezeNoop: boolean; freezeRevert: boolean; ignoreFreeze: boolean; unrelatedRevert: boolean; fundNoop: boolean; clockDrift: boolean };
let state: { holder: bigint; sink: bigint; frozen: boolean; mutated: boolean; block: bigint; timestamp: bigint };

const req = (chainId = 1) => ({
  chainId,
  rpcUrl: "http://unused.invalid",
  blockNumber: 25800000n,
  target: USDC as Hex,
  capabilities: capabilities(FIAT_FINGERPRINT),
  enumeration: COMPLETE,
  exitWindow: null,
  authorityResolution: null,
});

beforeEach(() => {
  config = { freezeNoop: false, freezeRevert: false, ignoreFreeze: false, unrelatedRevert: false, fundNoop: false, clockDrift: false };
  state = { holder: 0n, sink: 0n, frozen: false, mutated: false, block: 25800000n, timestamp: 1_000_000n };
  const snaps = new Map<Hex, typeof state>();
  let snapId = 0;
  h.fork = {
    client: {
      setBalance: vi.fn(async () => {}),
      impersonateAccount: vi.fn(async () => {}),
      getCode: vi.fn(async () => "0x"),
      getBlock: vi.fn(async () => ({ number: state.block, timestamp: state.timestamp })),
      readContract: vi.fn(async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
        switch (functionName) {
          case "blacklister": return BLACKLISTER;
          case "isBlacklisted": {
            const who = String(args?.[0]).toLowerCase();
            return who === HOLDER.toLowerCase() ? state.frozen : false;
          }
          case "balanceOf": {
            const who = String(args?.[0]).toLowerCase();
            if (who === HOLDER.toLowerCase()) return state.holder;
            if (who === SINK.toLowerCase()) return state.sink;
            return 0n;
          }
          default: throw new Error(`unsupported getter ${functionName}`);
        }
      }),
    },
    snapshot: vi.fn(async () => { const id = `0x${++snapId}` as Hex; snaps.set(id, { ...state }); return id; }),
    revert: vi.fn(async (id: Hex) => { state = { ...snaps.get(id)! }; if (config.clockDrift) state.timestamp += 10n; snaps.delete(id); }),
    stop: vi.fn(async () => {}),
    sendFrom: vi.fn(async (from: Hex, tx: { to: Hex; data?: Hex; gas: bigint }) => {
      state.block++; state.timestamp++;
      let status: "success" | "reverted" = "success";
      let revertData: Hex | null = null;
      const gasUsed = 40_000n;
      const sel = tx.data?.slice(0, 10);
      if (sel === FIAT_TOKEN_SELECTORS.blacklist) {
        if (config.freezeRevert) status = "reverted";
        else { state.mutated = true; state.frozen = !config.freezeNoop; }
      } else if (sel === FIAT_TOKEN_SELECTORS.transfer) {
        const fromHolder = from.toLowerCase() === HOLDER.toLowerCase();
        if (!fromHolder) {
          // The whale funding the holder.
          if (!config.fundNoop) state.holder += 100_000_000_000n;
        } else if (state.frozen && !config.ignoreFreeze) {
          status = "reverted";
          revertData = config.unrelatedRevert ? errorString("something else entirely") : BLACKLIST_REVERT;
        } else {
          state.sink += state.holder;
          state.holder = 0n;
        }
      }
      return { status, revertData, gasUsed, hash: ("0x" + "11".repeat(32)) as Hex,
        blockTimestamp: state.timestamp, baseFeePerGas: 1n, effectiveGasPrice: 1n,
        blockHash: ("0x" + "22".repeat(32)) as Hex, blockNumber: state.block, transactionIndex: 0 };
    }),
  };
});

describe("the registry", () => {
  it("registers both adapters and no two fingerprints collide", () => {
    expect(EXIT_ADAPTERS.map((a) => a.id).sort()).toEqual(["centre-fiat-token-holder", "compound-comet-base"]);
    // A double-match would make identification order-dependent, which is exactly
    // the ambiguity a fingerprint exists to remove.
    for (const a of EXIT_ADAPTERS) {
      for (const b of EXIT_ADAPTERS) {
        if (a.id === b.id) continue;
        expect(b.fingerprint.every((s) => a.fingerprint.includes(s))).toBe(false);
      }
    }
  });

  it("identifies each protocol from its own fingerprint and nothing else", () => {
    expect(identifyAdapter(FIAT_FINGERPRINT, 1)?.adapter.id).toBe("centre-fiat-token-holder");
    expect(identifyAdapter(cometAdapter.fingerprint, 1)?.adapter.id).toBe("compound-comet-base");
    // A partial fingerprint is not a match: `transfer` alone is every ERC20.
    expect(identifyAdapter([FIAT_TOKEN_SELECTORS.transfer], 1)).toBeNull();
    expect(identifyAdapter([FIAT_TOKEN_SELECTORS.transfer, FIAT_TOKEN_SELECTORS.blacklist], 1)).toBeNull();
  });

  it("reports validation per CHAIN, not per adapter", () => {
    expect(identifyAdapter(FIAT_FINGERPRINT, 1)?.validatedHere).toBe(true);
    expect(identifyAdapter(FIAT_FINGERPRINT, 8453)?.validatedHere).toBe(false);
  });

  it("routes asset-scenario support through the registry", () => {
    expect(supportsAssetScenarios("compound-comet-base")).toBe(true);
    expect(supportsAssetScenarios("centre-fiat-token-holder")).toBe(false);
    expect(supportsAssetScenarios(null)).toBe(false);
    expect(supportsAssetScenarios("something-nobody-registered")).toBe(false);
    expect(adapterById("compound-comet-base")).toBe(cometAdapter);
  });

  it("keys funding by (chain, token), so an address alone never answers", () => {
    expect(whaleFor(1, USDC)?.symbol).toBe("USDC");
    // The same address on another chain is a different contract, and a funding
    // table that answered here would seed a baseline from something unchecked.
    expect(whaleFor(8453, USDC)).toBeNull();
    for (const entry of Object.values(TOKEN_WHALES)) expect(entry.chainId).toBeGreaterThan(0);
  });
});

describe("a second protocol runs the whole differential through the same executor", () => {
  it("confirms a per-account freeze as a zero-notice exit restrictor", async () => {
    const result = await runExitRestrictionEngine(req() as never);
    const er = result.exitRestriction;
    expect(exitRestrictionSchema.safeParse(er).success).toBe(true);

    expect(er.exitAction.interfaceName).toBe("centre-fiat-token-holder");
    expect(er.exitAction.signature).toBe("transfer(address,uint256)");
    expect(er.baseline.status).toBe("established");
    expect(er.outcome).toBe("restrictor_found");
    expect(er.candidates[0]?.signature).toBe("blacklist(address)");
    expect(er.candidates[0]?.result).toBe("restrictor");
    expect(er.confirmationMethod).toBe("fork_confirmed");
    // The archetype and the extra ceiling items come from the ADAPTER, so this
    // report does not inherit Comet's description of what was tested.
    expect(er.archetype).toContain("FiatToken");
    expect(er.ceiling.join(" ")).toContain("plain token transfer");

    // A demonstrated restrictor with no delay becomes a zero-notice route.
    expect(result.restrictorRoute?.noticeSeconds).toBe("0");
    expect(result.restrictorRoute?.confirmationMethod).toBe("fork_confirmed");
    expect(result.restrictorRoute?.effectiveController?.toLowerCase()).toBe(BLACKLISTER.toLowerCase());
  });

  it("refuses to run at all on a chain where the adapter is not validated", async () => {
    const er = (await runExitRestrictionEngine(req(8453) as never)).exitRestriction;
    expect(er.outcome).toBe("no_candidates");
    expect(er.baseline.status).toBe("not_attempted");
    // Identified, but not exercised — and it says which chains it HAS been
    // validated on rather than implying it works everywhere.
    expect(er.exitAction.status).toBe("identified");
    expect(er.baseline.note).toContain("not been validated");
    expect(h.fork.sendFrom).not.toHaveBeenCalled();
  });

  it.each([
    ["freezeNoop", "the freeze executed but changed nothing"],
    ["unrelatedRevert", "the revert had another cause"],
    ["clockDrift", "the branches ran at different times"],
  ] as const)("never claims a restrictor when %s", async (mode) => {
    config[mode] = true;
    const er = (await runExitRestrictionEngine(req() as never)).exitRestriction;
    expect(er.candidates[0]?.result).not.toBe("restrictor");
    expect(er.outcome).toBe("evaluation_inconclusive");
    expect(er.confirmationMethod).toBe("not_confirmed");
  });

  it("reaches the WEAK positive tier when the freeze lands and the exit still works", async () => {
    // The only place in the suite where `no_direct_restriction_found` is
    // actually reachable, and it is worth pinning because the tier is the one
    // most likely to be widened by accident. Every precondition has to hold at
    // once: the exit action was identified, a baseline exit succeeded, the
    // mutation demonstrably transitioned, the identical exit still recovered
    // everything, and the aggregate enumeration was complete.
    //
    // Note what it is NOT called. This is not `can_exit_in_time` and never
    // becomes it: the claim is scoped to the one candidate evaluated, and the
    // ceiling shipped alongside says so.
    config.ignoreFreeze = true;
    const er = (await runExitRestrictionEngine(req() as never)).exitRestriction;
    expect(er.candidates[0]?.result).toBe("no_effect");
    expect(er.outcome).toBe("no_direct_restriction_found");
    expect(er.restrictionState).toBe("none_found");
    expect(er.coverage).toEqual({ guardedTotal: 1, evaluated: 1 });
    // Scope travels with the claim.
    expect(er.ceiling.length).toBeGreaterThan(3);
  });

  it("withholds the weak positive tier when enumeration is incomplete", async () => {
    config.ignoreFreeze = true;
    const er = (await runExitRestrictionEngine({
      ...req(),
      enumeration: { complete: false, gaps: [{ where: "target", site: { kind: "target", id: "" }, reason: "role set may be incomplete" }], note: "partial" },
    } as never)).exitRestriction;
    // Same fork behaviour, but an unseen route could hold another restrictor,
    // so the clean tier is unconstructable and the outcome degrades.
    expect(er.candidates[0]?.result).toBe("no_effect");
    expect(er.outcome).toBe("evaluation_inconclusive");
    expect(er.restrictionState).toBe("undetermined");
  });

  it("does not read an ineffective freeze as a clean exit", async () => {
    // `ignoreFreeze` is the dangerous shape: the mutation lands, the exit still
    // works, and the tempting conclusion is "no restriction here". That is only
    // honest if the freeze actually took effect — it did not, so no cause was
    // established and the outcome must stay inconclusive rather than clean.
    config.freezeNoop = true;
    config.ignoreFreeze = true;
    const er = (await runExitRestrictionEngine(req() as never)).exitRestriction;
    expect(er.outcome).not.toBe("no_direct_restriction_found");
    expect(er.restrictionState).toBe("undetermined");
  });

  it("refuses a baseline it could not fund, rather than testing an empty holder", async () => {
    config.fundNoop = true;
    const result = await runExitRestrictionEngine(req() as never);
    expect(result.exitRestriction.outcome).toBe("baseline_unestablished");
    expect(result.restrictorRoute).toBeNull();
  });

  it("refuses when the guarding party cannot even act", async () => {
    config.freezeRevert = true;
    const er = (await runExitRestrictionEngine(req() as never)).exitRestriction;
    expect(er.candidates[0]?.result).toBe("inconclusive");
    expect(er.candidates[0]?.detail).toContain("reverted");
  });
});

describe("adapter self-declarations are honest", () => {
  it("every adapter names the chains it was validated on", () => {
    for (const adapter of EXIT_ADAPTERS) {
      expect(Array.isArray(adapter.validatedOn)).toBe(true);
      expect(adapter.coverageLimitations.length).toBeGreaterThan(0);
      expect(adapter.archetype.length).toBeGreaterThan(20);
    }
  });

  it("fiatToken does not claim asset-scenario support it has not built", () => {
    expect(fiatTokenAdapter.supportsAssetScenarios).toBe(false);
    expect(cometAdapter.supportsAssetScenarios).toBe(true);
  });

  it("selectors are pinned to their derivations", () => {
    expect(COMET_SELECTORS.withdraw).toBe(toFunctionSelector("withdraw(address,uint256)"));
    expect(FIAT_TOKEN_SELECTORS.blacklist).toBe(toFunctionSelector("blacklist(address)"));
  });
});
