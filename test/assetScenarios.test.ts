import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeAbiParameters, getAddress, keccak256, toHex, type Hex } from "viem";
import { runAssetExitScenariosOnFork } from "../src/fork/assetScenarios.js";
import { COMET_PAUSED_ERROR, cometAbi, SELECTORS } from "../src/fork/exitActions.js";

const TARGET = "0xc3d688B66703497DAA19211EEdff47f25384cdc3" as Hex;
const BASE = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Hex;
const COLLATERAL = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as Hex;
const COLLATERAL_2 = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599" as Hex;
const UNSUPPORTED = "0x514910771af9ca656af840dff83e8264ecf986ca" as Hex;
const GUARDIAN = "0x000000000000000000000000000000000000dEaD" as Hex;

/**
 * A revert as a NODE reports it: EIP-1474 code 3. The engine classifies reverts
 * positively (KNOWN EDGE #31), so a test that threw a bare `new Error()` would
 * be exercising the infrastructure-failure path while claiming to test the
 * protocol-said-no path — which is the exact conflation the split exists to
 * prevent, reproduced in the test suite.
 */
function revertError(message = "execution reverted"): Error {
  return Object.assign(new Error(message), { code: 3 });
}

interface Flags { supply: boolean; transfer: boolean; withdraw: boolean; absorb: boolean; buy: boolean }

interface State {
  balances: Map<string, bigint>;
  holderTokens: Map<string, Map<string, bigint>>;
  collateral: Map<string, Map<string, bigint>>;
  flags: Flags;
  block: bigint;
  timestamp: bigint;
}

const cloneInner = (m: Map<string, Map<string, bigint>>) =>
  new Map([...m].map(([k, v]) => [k, new Map(v)] as const));

const clone = (state: State): State => ({
  ...state,
  flags: { ...state.flags },
  balances: new Map(state.balances),
  holderTokens: cloneInner(state.holderTokens),
  collateral: cloneInner(state.collateral),
});

const FLAG_READS: Record<string, keyof Flags> = {
  isSupplyPaused: "supply",
  isTransferPaused: "transfer",
  isWithdrawPaused: "withdraw",
  isAbsorbPaused: "absorb",
  isBuyPaused: "buy",
};

let state: State;
let collateralAssets: Set<string>;
/** Simulates a node that cannot answer, as distinct from a contract that says no. */
let roleReadFails: boolean;
let pauseNoop: boolean;
/** The guardian call itself REVERTS, as opposed to succeeding without effect. */
let pauseReverts: boolean;
/** The token contract refuses decimals()/balanceOf() — a fact about the token, not about us. */
let tokenInterfaceReverts: boolean;
let pauseAlsoFreezesSupply: boolean;
let baselineRevert: boolean;
let withdrawIgnoresPause: boolean;
let guardianCode: Hex;
let supplyCap: bigint;
let totalCollateral: bigint;
let fork: any;

const bal = (m: Map<string, Map<string, bigint>>, account: string, asset: string) =>
  m.get(account.toLowerCase())?.get(asset.toLowerCase()) ?? 0n;
const add = (m: Map<string, Map<string, bigint>>, account: string, asset: string, delta: bigint) => {
  const key = account.toLowerCase();
  const inner = m.get(key) ?? new Map<string, bigint>();
  inner.set(asset.toLowerCase(), (inner.get(asset.toLowerCase()) ?? 0n) + delta);
  m.set(key, inner);
};

beforeEach(() => {
  state = {
    balances: new Map([
      [`${TARGET.toLowerCase()}|${COLLATERAL.toLowerCase()}`, 2_000_000_000n],
      [`${TARGET.toLowerCase()}|${COLLATERAL_2.toLowerCase()}`, 5_000_000_000n],
    ]),
    holderTokens: new Map(),
    collateral: new Map(),
    flags: { supply: false, transfer: false, withdraw: false, absorb: false, buy: false },
    block: 25_800_000n,
    timestamp: 1_000_000n,
  };
  collateralAssets = new Set([COLLATERAL.toLowerCase(), COLLATERAL_2.toLowerCase()]);
  roleReadFails = false;
  pauseNoop = false;
  pauseReverts = false;
  tokenInterfaceReverts = false;
  pauseAlsoFreezesSupply = false;
  baselineRevert = false;
  withdrawIgnoresPause = false;
  guardianCode = "0x";
  supplyCap = 10n ** 30n;
  totalCollateral = 0n;

  const snapshots = new Map<Hex, State>();
  let snapshotId = 0;
  let txId = 0;

  const targetBalanceOf = (asset: string) => state.balances.get(`${TARGET.toLowerCase()}|${asset.toLowerCase()}`) ?? 0n;
  const addTargetBalance = (asset: string, delta: bigint) => {
    const key = `${TARGET.toLowerCase()}|${asset.toLowerCase()}`;
    state.balances.set(key, (state.balances.get(key) ?? 0n) + delta);
  };
  const seededSlots = new Map<string, string>();
  for (let index = 0; index < 12; index++) {
    const holder = getAddress(toHex(0xd100n + BigInt(index), { size: 20 }));
    seededSlots.set(keccak256(encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [holder, 7n],
    )).toLowerCase(), holder.toLowerCase());
  }

  fork = {
    client: {
      getBlock: vi.fn(async () => ({ number: state.block, timestamp: state.timestamp })),
      getCode: vi.fn(async ({ address }: { address: Hex }) =>
        (address.toLowerCase() === GUARDIAN.toLowerCase() ? guardianCode : "0x")),
      setBalance: vi.fn(async () => undefined),
      impersonateAccount: vi.fn(async () => undefined),
      getStorageAt: vi.fn(async () => toHex(0n, { size: 32 })),
      setStorageAt: vi.fn(async ({ address, index, value }: { address: Hex; index: Hex; value: Hex }) => {
        const holder = seededSlots.get(index.toLowerCase());
        if (holder) {
          const current = bal(state.holderTokens, holder, address);
          add(state.holderTokens, holder, address, BigInt(value) - current);
        }
      }),
      readContract: vi.fn(async ({ address, functionName, args = [] }: { address: Hex; functionName: string; args?: readonly Hex[] }) => {
        if (functionName === "baseToken") return BASE;
        if (functionName === "pauseGuardian") return GUARDIAN;
        if (functionName === "getThreshold") {
          if (guardianCode === "0x") throw revertError();
          if (guardianCode === "0xc0de") throw revertError(); // a contract that is not a Safe
          return 5n;
        }
        if (functionName === "getOwners") return Array(9).fill(GUARDIAN);
        if (FLAG_READS[functionName]) return state.flags[FLAG_READS[functionName]!];
        if (functionName === "getAssetInfoByAddress") {
          if (roleReadFails) throw new Error("fetch failed"); // infrastructure, NOT a revert
          const asset = args[0]!.toLowerCase();
          if (!collateralAssets.has(asset)) throw revertError("execution reverted: BadAsset()");
          return { asset: args[0]!, supplyCap };
        }
        if (functionName === "totalsCollateral") return [totalCollateral, 0n] as const;
        if (functionName === "decimals") {
          if (tokenInterfaceReverts) throw revertError("execution reverted");
          return 6;
        }
        if (functionName === "balanceOf") {
          const account = args[0]!.toLowerCase();
          return account === TARGET.toLowerCase() ? targetBalanceOf(address) : bal(state.holderTokens, account, address);
        }
        if (functionName === "collateralBalanceOf") return bal(state.collateral, args[0]!, args[1]!);
        if (functionName === "borrowBalanceOf") return 0n;
        throw new Error(`unsupported read ${functionName} on ${address}`);
      }),
    },
    snapshot: vi.fn(async () => {
      const id = `0x${++snapshotId}` as Hex;
      snapshots.set(id, clone(state));
      return id;
    }),
    revert: vi.fn(async (id: Hex) => {
      state = clone(snapshots.get(id)!);
      snapshots.delete(id);
    }),
    stop: vi.fn(async () => undefined),
    sendFrom: vi.fn(async (from: Hex, tx: { to: Hex; data?: Hex; gas?: bigint }) => {
      // Every transaction mines a block, reverted ones included — this is what
      // keeps the control and mutation branches on the same clock.
      state.block++;
      state.timestamp++;
      let status: "success" | "reverted" = "success";
      let revertData: Hex | null = null;
      const selector = tx.data?.slice(0, 10);
      if (selector === "0xa9059cbb") {
        const decoded = decodeFunctionData({ abi: [
          { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
        ] as const, data: tx.data! });
        const [to, amount] = decoded.args;
        addTargetBalance(tx.to, -amount);
        add(state.holderTokens, to, tx.to, amount);
      } else if (selector === SELECTORS.cometSupply) {
        const [asset, amount] = decodeFunctionData({ abi: cometAbi, data: tx.data! }).args as [Hex, bigint];
        add(state.holderTokens, from, asset, -amount);
        add(state.collateral, from, asset, amount);
        addTargetBalance(asset, amount);
      } else if (selector === SELECTORS.cometPause) {
        if (pauseReverts) {
          return {
            status: "reverted" as const, revertData: "0x82b42900" as Hex, gasUsed: 30_000n,
            hash: (`0x${(++txId).toString(16).padStart(64, "0")}`) as Hex,
            blockTimestamp: state.timestamp, baseFeePerGas: 1n, effectiveGasPrice: 1n,
            blockHash: (`0x${"22".repeat(32)}`) as Hex, blockNumber: state.block, transactionIndex: 0,
          };
        }
        if (!pauseNoop) {
          const [supply, transfer, withdraw, absorb, buy] = decodeFunctionData({ abi: cometAbi, data: tx.data! }).args as boolean[];
          state.flags = {
            supply: pauseAlsoFreezesSupply ? true : supply!,
            transfer: transfer!, withdraw: withdraw!, absorb: absorb!, buy: buy!,
          };
        }
      } else if (selector === SELECTORS.cometWithdraw) {
        const blocked = (state.flags.withdraw && !withdrawIgnoresPause) || baselineRevert;
        if (blocked) {
          status = "reverted";
          revertData = state.flags.withdraw ? COMET_PAUSED_ERROR : "0xdead";
        } else {
          const [asset, amount] = decodeFunctionData({ abi: cometAbi, data: tx.data! }).args as [Hex, bigint];
          add(state.collateral, from, asset, -amount);
          add(state.holderTokens, from, asset, amount);
          addTargetBalance(asset, -amount);
        }
      }
      return {
        status,
        revertData,
        gasUsed: 50_000n,
        hash: (`0x${(++txId).toString(16).padStart(64, "0")}`) as Hex,
        blockTimestamp: state.timestamp,
        baseFeePerGas: 1n,
        effectiveGasPrice: 1n,
        blockHash: (`0x${"22".repeat(32)}`) as Hex,
        blockNumber: state.block,
        transactionIndex: 0,
      };
    }),
  };
});

const req = (assets: { address: Hex; balanceRaw: string }[], extra: Record<string, unknown> = {}) => ({
  chainId: 1,
  rpcUrl: "http://unused.invalid",
  blockNumber: 25_800_000n,
  expectedBlockHash: (`0x${"11".repeat(32)}`) as Hex,
  target: TARGET,
  assets,
  ...extra,
});

const ONE = { address: COLLATERAL, balanceRaw: "2000000000" };
const TWO = { address: COLLATERAL_2, balanceRaw: "5000000000" };
const BASE_INPUT = { address: BASE, balanceRaw: "100" };
const UNSUPPORTED_INPUT = { address: UNSUPPORTED, balanceRaw: "100" };

describe("per-asset Compound fork scenarios", () => {
  it("confirms the real pause differential for supported collateral only", async () => {
    const result = await runAssetExitScenariosOnFork(
      req([BASE_INPUT, ONE, UNSUPPORTED_INPUT]), fork, "2026-09-04T00:00:00.000Z",
    );
    expect(result.scenarios.map((item) => [item.assetRole, item.state])).toEqual([
      ["base", "covered_by_primary_report"],
      ["collateral", "restrictor_confirmed"],
      ["unsupported", "unsupported_asset"],
    ]);
    expect(result.evaluated).toBe(1);
    expect(result.restrictorsConfirmed).toBe(1);
    expect(result.experimental).toBe(true);
    const collateral = result.scenarios[1]!;
    expect(collateral.suppliedRaw).toBe("1000000");
    expect(collateral.recoveredRaw).toBe("1000000");
    expect(collateral.detail).toContain("DIFFERENTIAL CONFIRMED");
    expect(collateral.evidence.some((entry) => entry.params.action === "guardian pause withdrawals")).toBe(true);
  });

  // --- multi-asset: each candidate gets its own branch root ------------------

  it("evaluates two collateral assets from isolated identical starting states", async () => {
    const result = await runAssetExitScenariosOnFork(req([ONE, TWO]), fork);
    expect(result.scenarios.map((item) => item.state)).toEqual(["restrictor_confirmed", "restrictor_confirmed"]);
    expect(result.evaluated).toBe(2);
    expect(result.status).toBe("complete");
    // Distinct deterministic sandbox holders — one holder for two assets would
    // make each asset's position depend on the other's.
    expect(new Set(result.scenarios.map((s) => s.holder)).size).toBe(2);
    // Each asset recovered exactly what it supplied in the control branch.
    for (const scenario of result.scenarios) expect(scenario.recoveredRaw).toBe(scenario.suppliedRaw);
    expect(result.notes.join(" ")).toMatch(/own pre-candidate fork snapshot/i);
    // The outer dispatcher restores one root per candidate. A single shared
    // mutation branch could not satisfy this assertion.
    expect(fork.revert).toHaveBeenCalledWith("0x1");
    expect(fork.revert).toHaveBeenCalledWith("0x4");
  });

  it("can test registered collateral even when the analysed contract held zero at the pinned block", async () => {
    state.balances.set(`${TARGET.toLowerCase()}|${COLLATERAL_2.toLowerCase()}`, 0n);
    const result = await runAssetExitScenariosOnFork(
      req([{ address: COLLATERAL_2, balanceRaw: "0" }]), fork,
    );
    expect(result.scenarios[0]).toMatchObject({ assetRole: "collateral", state: "restrictor_confirmed" });
    expect(result.scenarios[0]?.evidence.some((entry) => entry.params.method === "anvil_setStorageAt")).toBe(true);
    expect(result.scenarios[0]?.detail).toContain("DIFFERENTIAL CONFIRMED");
  });

  it("keeps candidate order stable regardless of which candidates are evaluated", async () => {
    const result = await runAssetExitScenariosOnFork(
      req([UNSUPPORTED_INPUT, TWO, BASE_INPUT, ONE]), fork,
    );
    expect(result.scenarios.map((item) => item.address)).toEqual([
      UNSUPPORTED.toLowerCase(), COLLATERAL_2.toLowerCase(), BASE.toLowerCase(), COLLATERAL.toLowerCase(),
    ]);
  });

  it("reports no_effect per asset without ever calling it clean", async () => {
    withdrawIgnoresPause = true;
    const result = await runAssetExitScenariosOnFork(req([ONE, TWO]), fork);
    expect(result.scenarios.map((item) => item.state)).toEqual(["no_effect", "no_effect"]);
    expect(result.restrictorsConfirmed).toBe(0);
    expect(result.evaluated).toBe(2);
    for (const scenario of result.scenarios) {
      expect(scenario.detail).not.toMatch(/\bsafe\b/i);
      expect(scenario.detail).toMatch(/not a clean result/i);
    }
  });

  // --- the split between "the protocol said no" and "we could not ask" ------

  it("separates a protocol rejection from a failed role read", async () => {
    const rejected = await runAssetExitScenariosOnFork(req([UNSUPPORTED_INPUT]), fork);
    expect(rejected.scenarios[0]).toMatchObject({ assetRole: "unsupported", state: "unsupported_asset" });
    expect(rejected.scenarios[0]?.detail).toMatch(/reverted/i);

    roleReadFails = true;
    const unresolved = await runAssetExitScenariosOnFork(req([ONE]), fork);
    expect(unresolved.scenarios[0]).toMatchObject({ assetRole: "unresolved", state: "role_unresolved" });
    // The decisive property: a failed read must NOT produce a claim about Compound.
    expect(unresolved.scenarios[0]?.detail).toMatch(/never asked/i);
    expect(unresolved.scenarios[0]?.detail).not.toMatch(/does not register/i);
    expect(unresolved.restrictorsConfirmed).toBe(0);
  });

  it("never reports a supply-cap cause it did not read", async () => {
    // A recognised collateral whose pinned balance does not match is refused at
    // setup; whatever the message says, it must not name an unread cause.
    const result = await runAssetExitScenariosOnFork(req([{ address: COLLATERAL, balanceRaw: "999" }]), fork);
    expect(result.scenarios[0]?.state).toBe("baseline_unestablished");
    for (const scenario of result.scenarios) expect(scenario.detail).not.toMatch(/supply cap may/i);
  });

  it("proves a full supply cap from on-chain values and does not attempt supply", async () => {
    supplyCap = 500n;
    totalCollateral = 500n;
    const result = await runAssetExitScenariosOnFork(req([ONE]), fork);
    expect(result.scenarios[0]?.state).toBe("baseline_unestablished");
    expect(result.scenarios[0]?.detail).toMatch(/equals or exceeds the on-chain supply cap \(500 raw units\)/i);
    expect(result.scenarios[0]?.evidence.some((entry) => entry.params.read === "totalsCollateral(address)")).toBe(true);
    expect(fork.sendFrom).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ data: expect.stringMatching(new RegExp(`^${SELECTORS.cometSupply}`)) }),
    );
  });

  // --- pause postconditions -------------------------------------------------

  it("refuses a clean claim when the pause flag does not transition", async () => {
    pauseNoop = true;
    const result = await runAssetExitScenariosOnFork(req([ONE]), fork);
    expect(result.scenarios[0]?.state).toBe("inconclusive");
    expect(result.scenarios[0]?.detail).toMatch(/false-to-true transition/i);
  });

  it("refuses attribution when the guardian call moved more than the exit flag", async () => {
    pauseAlsoFreezesSupply = true;
    const result = await runAssetExitScenariosOnFork(req([ONE]), fork);
    // The withdrawal IS blocked here, so the naive check would confirm a
    // restrictor. It must not: the mutation was not isolated to the exit.
    expect(result.scenarios[0]?.state).toBe("inconclusive");
    expect(result.scenarios[0]?.detail).toMatch(/more than the exit flag \(also: supply\)/);
    expect(result.restrictorsConfirmed).toBe(0);
  });

  it("records the mutation evidence in the order the events happened", async () => {
    const result = await runAssetExitScenariosOnFork(req([ONE]), fork);
    const evidence = result.scenarios[0]!.evidence;
    const pauseTxIndex = evidence.findIndex((e) => e.params.action === "guardian pause withdrawals");
    const beforeRead = evidence.findIndex((e) => e.params.phase === "before isolated candidate mutation" && e.params.read === "isWithdrawPaused()");
    const afterRead = evidence.findIndex((e) => e.params.phase === "after isolated candidate mutation" && e.params.read === "isWithdrawPaused()");
    expect(beforeRead).toBeGreaterThan(-1);
    expect(afterRead).toBeGreaterThan(-1);
    expect(beforeRead).toBeLessThan(pauseTxIndex);
    expect(pauseTxIndex).toBeLessThan(afterRead);
    // All five flags are read on both sides, not just the exit flag.
    for (const phase of ["before isolated candidate mutation", "after isolated candidate mutation"]) {
      expect(evidence.filter((e) => e.params.phase === phase).length).toBe(5);
    }
  });

  it("does not smuggle an unrelated setup read into a failed pause", async () => {
    pauseNoop = true;
    const result = await runAssetExitScenariosOnFork(req([ONE]), fork);
    const mutationPhase = result.scenarios[0]!.evidence.filter(
      (e) => e.params.phase === "before isolated candidate mutation" || e.params.phase === "after isolated candidate mutation",
    );
    // Both readings are present even though the transaction failed: "the flags
    // did not move" is an observation, not an inference from the receipt.
    expect(mutationPhase.length).toBe(10);
    expect(result.scenarios[0]!.evidence.some(
      (e) => e.params.phase === "before asset setup" && e.params.read === "isBuyPaused()"
        && result.scenarios[0]!.evidence.indexOf(e) > result.scenarios[0]!.evidence.findIndex((x) => x.params.action === "guardian pause withdrawals"),
    )).toBe(false);
  });

  it("cannot turn a failed open withdrawal into a restriction", async () => {
    baselineRevert = true;
    const result = await runAssetExitScenariosOnFork(req([ONE]), fork);
    expect(result.scenarios[0]?.state).toBe("baseline_unestablished");
    expect(result.restrictorsConfirmed).toBe(0);
  });

  // --- an already-shut exit -------------------------------------------------

  it("claims no protocol answer it never requested when withdrawals are already paused", async () => {
    state.flags.withdraw = true;
    const result = await runAssetExitScenariosOnFork(req([BASE_INPUT, ONE, UNSUPPORTED_INPUT]), fork);
    expect(result.scenarios.map((item) => [item.assetRole, item.state])).toEqual([
      ["base", "covered_by_primary_report"],
      // NOT "unsupported": Compound was never asked about these tokens.
      ["unresolved", "role_unresolved"],
      ["unresolved", "role_unresolved"],
    ]);
    expect(result.status).toBe("partial");
    expect(result.restrictorsConfirmed).toBe(0);
  });

  // --- guardian classification ---------------------------------------------

  it("carries the Safe caveat and impersonation note on a Safe guardian", async () => {
    guardianCode = "0x6080";
    const result = await runAssetExitScenariosOnFork(req([ONE]), fork);
    expect(result.scenarios[0]?.guardianType).toBe("safe");
    expect(result.scenarios[0]?.caveats.join(" ")).toMatch(/5-of-9 Safe impersonated; signatures, guards and modules were not executed/);
  });

  it("does not claim zero notice for a contract guardian it did not model", async () => {
    guardianCode = "0xc0de";
    const result = await runAssetExitScenariosOnFork(req([ONE]), fork);
    expect(result.scenarios[0]?.guardianType).toBe("contract");
    // A contract guardian may hold its own delay; "0s of notice" is not established.
    expect(result.scenarios[0]?.noticeSeconds).toBeNull();
    expect(result.scenarios[0]?.caveats.join(" ")).toMatch(/internal authorization and delay were not executed/);
  });

  // --- status semantics and the time limit ---------------------------------

  it("never calls a batch complete when nothing was evaluated", async () => {
    const empty = await runAssetExitScenariosOnFork(req([]), fork);
    expect(empty.status).toBe("unavailable");
    expect(empty.evaluated).toBe(0);

    const baseOnly = await runAssetExitScenariosOnFork(req([BASE_INPUT]), fork);
    expect(baseOnly.evaluated).toBe(0);
    expect(baseOnly.status).not.toBe("complete");
  });

  it("records every candidate it ran out of time for instead of dropping it", async () => {
    const result = await runAssetExitScenariosOnFork(req([ONE, TWO], { deadlineAt: Date.now() - 1 }), fork);
    expect(result.scenarios).toHaveLength(2);
    expect(result.scenarios.map((item) => item.state)).toEqual(["inconclusive", "inconclusive"]);
    expect(result.status).toBe("partial");
    expect(result.notes.join(" ")).toMatch(/time limit/i);
  });

  it("states its experimental bounds in the artifact, not only in a document", async () => {
    const result = await runAssetExitScenariosOnFork(req([ONE]), fork);
    expect(result.experimental).toBe(true);
    expect(result.notes.join(" ")).toMatch(/EXPERIMENTAL/);
    expect(result.notes.join(" ")).toMatch(/not evidence of safety/i);
  });

  it("keeps full chronological evidence when the guardian transaction itself reverts", async () => {
    // Distinct from `pauseNoop`, which is a SUCCESSFUL transaction that changed
    // nothing. Here the call fails outright — the case that used to leave
    // `commonEvidence.slice(-2)` reaching back into unrelated setup reads
    // because no after-reading had been taken at all.
    pauseReverts = true;
    const result = await runAssetExitScenariosOnFork(req([ONE, TWO]), fork);

    expect(result.scenarios.map((item) => item.state)).toEqual(["inconclusive", "inconclusive"]);
    expect(result.restrictorsConfirmed).toBe(0);
    expect(result.status).toBe("partial");

    for (const scenario of result.scenarios) {
      expect(scenario.detail).toMatch(/false-to-true transition/i);
      const evidence = scenario.evidence;
      const pauseTx = evidence.findIndex((e) => e.params.action === "guardian pause withdrawals");
      expect(pauseTx).toBeGreaterThan(-1);
      // The after-readings were still taken: "the flags did not move" is an
      // observation, not something inferred from a failed receipt.
      const beforeReads = evidence.filter((e) => e.params.phase === "before isolated candidate mutation");
      const afterReads = evidence.filter((e) => e.params.phase === "after isolated candidate mutation");
      expect(beforeReads).toHaveLength(5);
      expect(afterReads).toHaveLength(5);
      expect(evidence.indexOf(beforeReads[4]!)).toBeLessThan(pauseTx);
      expect(evidence.indexOf(afterReads[0]!)).toBeGreaterThan(pauseTx);
      // No setup-phase reading smuggled in after the transaction.
      const strays = evidence
        .map((e, i) => ({ e, i }))
        .filter(({ e, i }) => i > pauseTx && e.params.phase === "before asset setup");
      expect(strays).toHaveLength(0);
    }
  });

  it("separates a token contract refusing a setup call from a failed read", async () => {
    tokenInterfaceReverts = true;
    const rejected = await runAssetExitScenariosOnFork(req([ONE]), fork);
    expect(rejected.scenarios[0]).toMatchObject({
      assetRole: "collateral",
      state: "token_interface_rejected",
    });
    // Compound's answer stands — the token is registered collateral — and the
    // failure is attributed to the token, not to our connection.
    expect(rejected.scenarios[0]?.detail).toMatch(/token's own decimals\(\)\/balanceOf\(\) call reverted/i);
    expect(rejected.scenarios[0]?.detail).not.toMatch(/could not be read/i);
    expect(rejected.unresolved).toBe(1);
  });
});
