import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { decodeFunctionData, type Hex } from "viem";
import { COMET_PAUSED_ERROR, cometAbi, SELECTORS } from "../src/fork/exitActions.js";
import { runExitRestrictionEngine } from "../src/fork/exitRestriction.js";
import { applyExitRestriction } from "../src/report/applyExitRestriction.js";
import { composeVerdict } from "../src/report/verdict.js";
import { exitRestrictionSchema } from "../src/report/schema.js";

const h = vi.hoisted(() => ({ fork: null as any }));
vi.mock("../src/fork/anvil.js", () => ({ startAnvilFork: async () => h.fork }));
vi.mock("../src/fork/preflight.js", () => ({ checkAnvilAvailable: async () => ({ executable: "mock", available: true, version: "mock" }) }));
const report = JSON.parse(readFileSync("calibration/reports/compound-comet-cusdcv3.json", "utf8"));
const TOKEN = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const COMPLETE = { complete: true, gaps: [], note: "complete" };
const req = () => ({ chainId: 1, rpcUrl: "http://unused.invalid", blockNumber: 25800000n,
  target: report.target.address, capabilities: report.capabilities, enumeration: COMPLETE,
  exitWindow: report.exitWindow, authorityResolution: report.authorityResolution });
let config: {
  fundNoop: boolean; supplyNoop: boolean; withdrawalNoop: "baseline" | "after" | null;
  baselineRevert: boolean; pauseRevert: boolean; pauseNoop: boolean; ignorePause: boolean;
  unrelatedRevert: boolean; outOfGas: boolean; clockDrift: boolean; contractGuardian: boolean;
  leavePrincipal: boolean; incurDebt: boolean;
};
let state: { tokens: bigint; principal: bigint; debt: bigint; paused: boolean; mutation: boolean; block: bigint; timestamp: bigint };
beforeEach(() => {
  config = { fundNoop: false, supplyNoop: false, withdrawalNoop: null, baselineRevert: false,
    pauseRevert: false, pauseNoop: false, ignorePause: false, unrelatedRevert: false, outOfGas: false,
    clockDrift: false, contractGuardian: false, leavePrincipal: false, incurDebt: false };
  state = { tokens: 0n, principal: 0n, debt: 0n, paused: false, mutation: false, block: 25800000n, timestamp: 1000000n };
  const snaps = new Map<Hex, typeof state>();
  let snapId = 0;
  h.fork = {
    client: {
      setBalance: vi.fn(async () => {}), impersonateAccount: vi.fn(async () => {}),
      getCode: vi.fn(async ({ address }) => config.contractGuardian && address.toLowerCase().endsWith("dead") ? "0x6000" : "0x"),
      getBlock: vi.fn(async () => ({ number: state.block, timestamp: state.timestamp })),
      readContract: vi.fn(async ({ address, functionName }) => {
        switch (functionName) {
          case "baseToken": return TOKEN;
          case "pauseGuardian": return "0x000000000000000000000000000000000000dEaD";
          case "isWithdrawPaused": return state.paused;
          case "isTransferPaused": return true; // must be preserved by the mutation
          case "isSupplyPaused": case "isAbsorbPaused": case "isBuyPaused": return false;
          case "balanceOf": return address === TOKEN ? state.tokens : state.principal;
          case "borrowBalanceOf": return state.debt;
          case "userBasic": return [state.principal, 0n, 0n, 0, 0];
          default: throw new Error("unsupported getter");
        }
      }),
    },
    snapshot: vi.fn(async () => { const id = `0x${++snapId}` as Hex; snaps.set(id, { ...state }); return id; }),
    revert: vi.fn(async (id: Hex) => { state = { ...snaps.get(id)! }; if (config.clockDrift) state.timestamp += 10n; snaps.delete(id); }),
    stop: vi.fn(async () => {}),
    sendFrom: vi.fn(async (_from, tx) => {
      state.block++; state.timestamp++;
      let status = "success", revertData: Hex | null = null;
      let gasUsed = 40000n;
      const sel = tx.data?.slice(0, 10);
      if (sel === "0xa9059cbb" && !config.fundNoop) state.tokens += 100_000_000_000n;
      if (sel === SELECTORS.cometSupply && !config.supplyNoop) { state.tokens -= 50_000_000_000n; state.principal = 50_000_000_000n; }
      if (sel === SELECTORS.cometPause) {
        if (config.pauseRevert) status = "reverted";
        else { state.mutation = true; state.paused = !config.pauseNoop; }
      }
      if (sel === SELECTORS.cometWithdraw) {
        if ((!state.mutation && config.baselineRevert) || (state.mutation && (!config.ignorePause || config.unrelatedRevert))) {
          status = "reverted";
          revertData = state.paused && !config.unrelatedRevert ? COMET_PAUSED_ERROR : "0x";
          if (config.outOfGas) gasUsed = tx.gas;
        } else if (config.withdrawalNoop !== (state.mutation ? "after" : "baseline")) {
          state.tokens += state.principal;
          if (!config.leavePrincipal) state.principal = 0n;
          if (config.incurDebt) state.debt = 1n;
        }
      }
      return { status, revertData, gasUsed, hash: ("0x" + "11".repeat(32)) as Hex,
        blockTimestamp: state.timestamp, baseFeePerGas: 1n, effectiveGasPrice: 1n,
        blockHash: ("0x" + "22".repeat(32)) as Hex, blockNumber: state.block, transactionIndex: 0 };
    }),
  };
});
async function run() {
  const result = await runExitRestrictionEngine(req());
  expect(exitRestrictionSchema.safeParse(result.exitRestriction).success).toBe(true);
  expect(h.fork.stop).toHaveBeenCalledOnce();
  return result;
}

describe("the actual engine's fork execution and failure paths", () => {
  it("verifies token recovery and a cleared position, then confirms the specific pause restriction", async () => {
    const { exitRestriction: er, restrictorRoute } = await run();
    expect(er.outcome).toBe("restrictor_found");
    expect(er.baseline.note).toContain("50000000000 base-token units received");
    expect(restrictorRoute?.noticeSeconds).toBe("0");
    const pauseTx = h.fork.sendFrom.mock.calls.find(([, tx]) => tx.data?.startsWith(SELECTORS.cometPause))![1];
    expect(decodeFunctionData({ abi: cometAbi, data: pauseTx.data }).args).toEqual([false, true, true, false, false]);
    expect(er.baseline.evidence.some((e) => e.params.action === "guardian pause withdraw")).toBe(false);
    expect(er.candidates[0]?.evidence.filter((e) => e.params.read === "isWithdrawPaused()").map((e) => e.rawValue)).toEqual([false, true]);
  });
  it("verifies the existing point-1 fix through the engine, not just its classifier", async () => {
    config.pauseRevert = true;
    const { exitRestriction: er } = await run();
    expect(er.outcome).toBe("evaluation_inconclusive");
    expect(er.candidates[0]?.result).toBe("inconclusive");
    expect(er.confirmationMethod).toBe("not_confirmed");
  });
  it.each(["fundNoop", "supplyNoop", "baselineRevert", "leavePrincipal", "incurDebt"] as const)("refuses an invalid baseline: %s", async (mode) => {
    config[mode] = true;
    const result = await run();
    expect(result.exitRestriction.outcome).toBe("baseline_unestablished");
    expect(result.restrictorRoute).toBeNull();
  });
  it("does not mistake a successful no-op withdrawal for token recovery", async () => {
    config.withdrawalNoop = "baseline";
    expect((await run()).exitRestriction.baseline.status).toBe("unestablished");
  });
  it("does not fabricate a causal experiment when withdrawals start paused", async () => {
    state.paused = true;
    const result = await run();
    expect(result.exitRestriction.outcome).toBe("baseline_unestablished");
    expect(result.restrictorRoute).toBeNull();
    expect(h.fork.sendFrom).not.toHaveBeenCalled();
  });
  it.each(["pauseNoop", "unrelatedRevert", "outOfGas", "clockDrift"] as const)("does not manufacture causal evidence: %s", async (mode) => {
    config[mode] = true;
    const { exitRestriction: er } = await run();
    expect(er.candidates[0]?.result).toBe("inconclusive");
    expect(er.outcome).toBe("evaluation_inconclusive");
  });
  it("requires economic recovery after the mutation too", async () => {
    config.ignorePause = true; config.withdrawalNoop = "after";
    expect((await run()).exitRestriction.outcome).toBe("evaluation_inconclusive");
  });
  it("permits only a fully verified, scoped no-effect result", async () => {
    config.ignorePause = true;
    expect((await run()).exitRestriction.outcome).toBe("no_direct_restriction_found");
  });
  it("does not borrow zero notice from another route for a contract guardian", async () => {
    config.contractGuardian = true;
    const result = await run();
    expect(result.restrictorRoute).toBeNull();
    const window = { ...report.exitWindow, routes: [], assessment: { status: "no_notice", confidence: "high", statement: "independent zero-notice route" } };
    const v = composeVerdict(window, report.timeToExit, report.enumeration, result.exitRestriction);
    expect(v.statement).toContain("CLOSABLE with an unestablished notice period");
    expect(v.statement).not.toContain("CLOSABLE with zero notice");
  });
  it("cannot rewrite an unestablished baseline as a successful differential", async () => {
    config.baselineRevert = true;
    const base = { ...report, exitWindow: { ...report.exitWindow, assessment: { status: "undetermined", confidence: "low", statement: "unknown", missing: [], citedGapSites: [] } } };
    const result = await run();
    // Even if a stale caller supplies the previous run's synthetic route.
    result.restrictorRoute = report.exitWindow.routes.find((r) => r.confirmationMethod === "fork_confirmed");
    const merged = applyExitRestriction(base, result);
    expect(merged.exitWindow?.assessment.status).toBe("undetermined");
    expect(merged.exitWindow?.assessment.statement).not.toContain("baseline withdrawal succeeded");
  });
});
