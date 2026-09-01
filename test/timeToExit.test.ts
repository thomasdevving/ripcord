/**
 * Time-to-exit unit tests. Network-free.
 *
 * The rules under test are the modelling choices an auditor should challenge:
 * an unmeasured leg is never a zero-length one, a claim window is a deadline
 * rather than a delay, and "no mechanism detected" is a bounded observation
 * rather than a claim of instant exit.
 */
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, toFunctionSelector, type Hex } from "viem";
import { analyseTimeToExit, exitPatternsVersion } from "../src/detect/timeToExit.js";
import type { ChainReader, Evidence } from "../src/chain/client.js";
import type { CapabilitiesResult, ProxyResult } from "../src/report/schema.js";

const ev = (): Evidence => ({ kind: "call", params: {}, rawValue: "0x", block: "1" });
const TARGET = "0x0000000000000000000000000000000000000a01" as Hex;

const uint = (v: bigint): Hex => encodeAbiParameters([{ type: "uint256" }], [v]);
const bool = (v: boolean): Hex => encodeAbiParameters([{ type: "bool" }], [v]);

function fakeChain(code: Hex | undefined, calls: Record<string, Hex>): ChainReader {
  return {
    chainId: 1,
    blockNumber: 1n,
    async getBlockHash() {
      return "0x00" as Hex;
    },
    async getCodeAtBlock() {
      return { code: undefined };
    },
    async getCode() {
      return { code, evidence: ev() };
    },
    async getStorageAt() {
      return { value: `0x${"0".repeat(64)}` as Hex, evidence: ev() };
    },
    async call(_address, data) {
      const hit = calls[data.slice(0, 10).toLowerCase()];
      return { result: hit, reverted: hit === undefined, evidence: ev() };
    },
    async probeCall() {
      return { revertData: undefined, reverted: true, evidence: ev() };
    },
    async getLogs() {
      return { logs: [], evidence: ev() };
    },
  };
}

/** Same dispatcher shape the exit-window tests build: a real selector-load plus one EQ branch per selector. */
function dispatcherBytecode(selectors: Hex[]): Hex {
  let code = "60003560e01c";
  const bodyStart = 6 + selectors.length * 12 + 1;
  selectors.forEach((sel, i) => {
    code += "80" + "63" + sel.slice(2) + "14" + "61" + (bodyStart + i).toString(16).padStart(4, "0") + "57";
  });
  code += "00";
  code += "5b".repeat(selectors.length);
  return ("0x" + code) as Hex;
}

const PROXY: ProxyResult = {
  pattern: "not_a_proxy",
  isProxy: false,
  implementation: null,
  beacon: null,
  admin: null,
  slots: {},
  evidence: [],
};

const caps = (overrides: Partial<CapabilitiesResult> = {}): CapabilitiesResult => ({
  taxonomyVersion: "test",
  dispatcherRecognized: true,
  scannedAddress: null,
  probedAddress: TARGET,
  selectorsExtracted: 0,
  unmatchedSelectors: [],
  findings: [],
  needsManualVerification: [],
  evidence: [],
  ...overrides,
});

const COOLDOWN_DURATION = toFunctionSelector("cooldownDuration()");
const SET_COOLDOWN = toFunctionSelector("setCooldownDuration(uint24)");
const COOLDOWN_SHARES = toFunctionSelector("cooldownShares(uint256)");
const UNSTAKE = toFunctionSelector("unstake(address)");
const COOLDOWN_SECONDS = toFunctionSelector("COOLDOWN_SECONDS()");
const UNSTAKE_WINDOW = toFunctionSelector("UNSTAKE_WINDOW()");
const PAUSED = toFunctionSelector("paused()");
const REQ_WITHDRAWALS = toFunctionSelector("requestWithdrawals(uint256[],address)");
const CLAIM_WITHDRAWALS = toFunctionSelector("claimWithdrawals(uint256[],uint256[])");

describe("time-to-exit", () => {
  it("measures a readable cooldown and flags that its duration is a privileged SETTING", async () => {
    // The Ethena sUSDe shape, verified live: cooldownDuration() = 86400 with
    // setCooldownDuration present in the same dispatcher.
    const chain = fakeChain(dispatcherBytecode([COOLDOWN_DURATION, SET_COOLDOWN, COOLDOWN_SHARES, UNSTAKE]), {
      [COOLDOWN_DURATION.toLowerCase()]: uint(86_400n),
    });
    const { result } = await analyseTimeToExit(chain, TARGET, { proxy: PROXY, capabilities: caps() });
    expect(result.status).toBe("measured");
    expect(result.atLeastSeconds).toBe("86400");
    expect(result.tight).toBe(true);
    const cooldown = result.legs.find((l) => l.kind === "cooldown")!;
    expect(cooldown.mutableBy).toBe("setCooldownDuration(uint24)");
    expect(result.statement).toContain("privileged SETTINGS");
    // The two-step shape is recorded, but not double-counted as extra unknown wait.
    expect(result.legs.some((l) => l.kind === "two_step")).toBe(true);
    expect(result.unmeasuredLegs).toEqual([]);
  });

  it("counts a claim window as a deadline, not as added waiting", async () => {
    // Aave stkAAVE shape: COOLDOWN_SECONDS + UNSTAKE_WINDOW both 172800. The
    // exit takes 2 days, not 4 — the window says when you must act, not how
    // long you wait.
    const chain = fakeChain(dispatcherBytecode([COOLDOWN_SECONDS, UNSTAKE_WINDOW]), {
      [COOLDOWN_SECONDS.toLowerCase()]: uint(172_800n),
      [UNSTAKE_WINDOW.toLowerCase()]: uint(172_800n),
    });
    const { result } = await analyseTimeToExit(chain, TARGET, { proxy: PROXY, capabilities: caps() });
    expect(result.atLeastSeconds).toBe("172800");
    expect(result.legs.find((l) => l.kind === "claim_window")!.seconds).toBe("172800");
    expect(result.statement).toContain("adds no waiting");
  });

  it("makes an unreadable queue a LOWER BOUND with the leg named, never a zero", async () => {
    const chain = fakeChain(dispatcherBytecode([REQ_WITHDRAWALS, CLAIM_WITHDRAWALS]), {});
    const { result } = await analyseTimeToExit(chain, TARGET, { proxy: PROXY, capabilities: caps() });
    expect(result.status).toBe("lower_bound");
    expect(result.tight).toBe(false);
    expect(result.unmeasuredLegs).toHaveLength(1);
    expect(result.unmeasuredLegs[0]!.name).toContain("requestWithdrawals");
    expect(result.statement).toContain("AT LEAST");
  });

  it("treats no detected mechanism as an observation over a finite table, not proof of instant exit", async () => {
    const chain = fakeChain(dispatcherBytecode([toFunctionSelector("transfer(address,uint256)")]), {});
    const { result } = await analyseTimeToExit(chain, TARGET, { proxy: PROXY, capabilities: caps() });
    expect(result.status).toBe("no_mechanism_detected");
    expect(result.atLeastSeconds).toBe("0");
    expect(result.tight).toBe(true);
    expect(result.confidence).toBe("medium"); // never "high"
    expect(result.statement).toContain("not proof that no delay exists");
  });

  it("reports an unreadable dispatcher as undetermined rather than as no mechanism", async () => {
    const chain = fakeChain("0x6001600155" as Hex, {});
    const { result } = await analyseTimeToExit(chain, TARGET, { proxy: PROXY, capabilities: caps() });
    expect(result.status).toBe("undetermined");
    expect(result.tight).toBe(false);
    expect(result.statement).toContain("Nothing found here should be read as nothing present");
  });

  it("reports exit as BLOCKED, and unbounded, when a pause getter reads true", async () => {
    const chain = fakeChain(dispatcherBytecode([PAUSED, COOLDOWN_DURATION]), {
      [PAUSED.toLowerCase()]: bool(true),
      [COOLDOWN_DURATION.toLowerCase()]: uint(86_400n),
    });
    const { result } = await analyseTimeToExit(chain, TARGET, { proxy: PROXY, capabilities: caps() });
    expect(result.status).toBe("blocked");
    expect(result.tight).toBe(false);
    expect(result.blockable.status).toBe("currently_blocked");
    expect(result.statement).toContain("unbounded");
  });

  it("does not treat paused() == false as a block", async () => {
    const chain = fakeChain(dispatcherBytecode([PAUSED]), { [PAUSED.toLowerCase()]: bool(false) });
    const { result } = await analyseTimeToExit(chain, TARGET, { proxy: PROXY, capabilities: caps() });
    expect(result.status).toBe("no_mechanism_detected");
    expect(result.blockable.status).toBe("not_observed");
  });

  it("names who CAN block the exit from attributed ACCESS_RESTRICTION capabilities", async () => {
    const holder = "0x0000000000000000000000000000000000000009";
    const chain = fakeChain(dispatcherBytecode([toFunctionSelector("pause()")]), {});
    const { result } = await analyseTimeToExit(chain, TARGET, {
      proxy: PROXY,
      capabilities: caps({
        findings: [
          {
            selector: toFunctionSelector("pause()"),
            signature: "pause()",
            category: "ACCESS_RESTRICTION",
            nameMatchSpecificity: "standard",
            scannedAddress: TARGET,
            probedAddress: TARGET,
            guard: { status: "attributed", holders: [holder], authSource: "owner", role: null, evidence: [] },
          },
        ],
      }),
    });
    expect(result.blockable.status).toBe("blockable");
    expect(result.blockable.by).toEqual([holder]);
    // Capability, never prediction.
    expect(result.blockable.note).toContain("a capability, not a prediction");
  });

  it("reports blockability as undetermined when a restriction exists but no holder was attributed", async () => {
    const chain = fakeChain(dispatcherBytecode([toFunctionSelector("pause()")]), {});
    const { result } = await analyseTimeToExit(chain, TARGET, {
      proxy: PROXY,
      capabilities: caps({
        findings: [
          {
            selector: toFunctionSelector("pause()"),
            signature: "pause()",
            category: "ACCESS_RESTRICTION",
            nameMatchSpecificity: "standard",
            scannedAddress: TARGET,
            probedAddress: TARGET,
            guard: { status: "inconclusive", note: "n", evidence: [] },
          },
        ],
      }),
    });
    expect(result.blockable.status).toBe("undetermined");
    expect(result.blockable.note).toContain("not absent");
  });

  it("never models liquidity depth, and says why", async () => {
    const chain = fakeChain(dispatcherBytecode([COOLDOWN_DURATION]), { [COOLDOWN_DURATION.toLowerCase()]: uint(1n) });
    const { result } = await analyseTimeToExit(chain, TARGET, { proxy: PROXY, capabilities: caps() });
    expect(result.liquidity.modelled).toBe(false);
    expect(result.liquidity.reason).toContain("indexer");
    expect(result.liquidity.reason).toContain("LONGER");
  });

  it("records a zero cooldown as a measured zero, not as an absent mechanism", async () => {
    // Ethena signals synchronous exit with cooldownDuration() == 0; that is a
    // reading, and it should be reported as one.
    const chain = fakeChain(dispatcherBytecode([COOLDOWN_DURATION]), { [COOLDOWN_DURATION.toLowerCase()]: uint(0n) });
    const { result } = await analyseTimeToExit(chain, TARGET, { proxy: PROXY, capabilities: caps() });
    expect(result.status).toBe("measured");
    expect(result.atLeastSeconds).toBe("0");
    expect(result.legs[0]!.measured).toBe(true);
    expect(result.legs[0]!.seconds).toBe("0");
  });

  it("pins the pattern-table version so a change to the model is a visible change", () => {
    expect(exitPatternsVersion).toBe("0.1.0");
  });
});
