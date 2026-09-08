/**
 * THE REPORT-WIDE BUDGET, and the one property that makes it safe to have.
 *
 * A budget is a mechanism for stopping work early. In a tool whose entire value
 * is that "we did not look" never reads as "there is nothing there", that is a
 * dangerous thing to add: a truncated analysis produces exactly the same shaped
 * result as a target with less to find. So the cases below are weighted toward
 * the direction that would hurt — an exhaustion must reach the aggregate
 * enumeration witness, and a witness that has seen one must refuse to certify
 * the reassuring assessment variants.
 *
 * The other half is determinism. Every dimension counts logical work, so a cold
 * run and a warm run consume identically; a time or network-attempt budget could
 * be exhausted by one and not the other, which would make a report depend on
 * whether someone had run it before (KNOWN EDGE #23).
 */
import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { AnalysisBudget, BudgetExhaustedError, DEFAULT_BUDGET_LIMITS } from "../src/chain/budget.js";
import { BudgetedChainReader, budgetOf } from "../src/chain/budgetedReader.js";
import { deriveEnumerationCompleteness, witnessOf } from "../src/report/enumeration.js";
import type { ChainReader, Evidence } from "../src/chain/client.js";
import type { CapabilitiesResult, OwnerField, ProxyResult } from "../src/report/schema.js";

const ev = (): Evidence => ({ kind: "call", params: {}, rawValue: "0x", block: "1" });
const ADDR = ("0x" + "11".repeat(20)) as Hex;

function countingChain(counts: { reads: number; logs: number }): ChainReader {
  return {
    chainId: 1,
    blockNumber: 100n,
    async getBlockHash() { counts.reads++; return "0xhash" as Hex; },
    async getCodeAtBlock() { counts.reads++; return { code: "0x60" as Hex }; },
    async getCode(address: Hex) { counts.reads++; return { code: "0x60" as Hex, evidence: { ...ev(), params: { address } } }; },
    async getStorageAt() { counts.reads++; return { value: ("0x" + "0".repeat(64)) as Hex, evidence: ev() }; },
    async call() { counts.reads++; return { result: "0xabcd" as Hex, reverted: false, evidence: ev() }; },
    async probeCall() { counts.reads++; return { revertData: undefined, reverted: true, evidence: ev() }; },
    async getLogs() { counts.logs++; return { logs: [], evidence: ev() }; },
  };
}

describe("AnalysisBudget accounting", () => {
  it("spends, reports what is left, and never goes negative", () => {
    const budget = new AnalysisBudget({ ...DEFAULT_BUDGET_LIMITS, authorityNodes: 3 });
    expect(budget.spend("authorityNodes", 2, "a", "c")).toBe(true);
    expect(budget.remaining("authorityNodes")).toBe(1);
    expect(budget.consumed("authorityNodes")).toBe(2);
    // The over-spend is REFUSED, not partially applied: a caller that gets
    // `false` must degrade, and a half-charged budget would leave the next
    // caller's arithmetic wrong.
    expect(budget.spend("authorityNodes", 2, "b", "c")).toBe(false);
    expect(budget.consumed("authorityNodes")).toBe(2);
    expect(budget.remaining("authorityNodes")).toBe(1);
  });

  it("records every refusal, deduped by (dimension, where) so one boundary is one fact", () => {
    const budget = new AnalysisBudget({ ...DEFAULT_BUDGET_LIMITS, roleMembers: 0 });
    budget.spend("roleMembers", 1, "accessControl:0xaa", "floor");
    budget.spend("roleMembers", 1, "accessControl:0xaa", "floor");
    budget.spend("roleMembers", 1, "accessControl:0xbb", "floor");
    expect(budget.exhausted).toHaveLength(2);
    expect(budget.exhausted.map((e) => e.where).sort()).toEqual(["accessControl:0xaa", "accessControl:0xbb"]);
  });

  it("declareExhausted records a boundary a caller planned around, without charging for it", () => {
    const budget = new AnalysisBudget({ ...DEFAULT_BUDGET_LIMITS, logRequests: 10 });
    budget.declareExhausted("logRequests", 5000, "accessControl:0xaa", "scanned the recent window only");
    expect(budget.consumed("logRequests")).toBe(0);
    expect(budget.exhausted[0]!.requested).toBe(5000);
  });

  it("spendOrThrow fails loud rather than returning a default", () => {
    const budget = new AnalysisBudget({ ...DEFAULT_BUDGET_LIMITS, chainReads: 1 });
    budget.spendOrThrow("chainReads", 1, "call:0xaa");
    expect(() => budget.spendOrThrow("chainReads", 1, "call:0xbb")).toThrow(BudgetExhaustedError);
    expect(budget.exhausted).toHaveLength(1);
  });

  it("snapshot is a copy, not a live view into the running budget", () => {
    const budget = new AnalysisBudget();
    const before = budget.snapshot();
    budget.spend("authorityNodes", 5, "a", "c");
    expect(before.consumed.authorityNodes).toBe(0);
    expect(budget.snapshot().consumed.authorityNodes).toBe(5);
  });

  it("default limits sit above everything the calibration corpus actually needs", () => {
    // Measured against the 26 committed reports: ~1,600 reads and ~1,590 log
    // requests at the most expensive, 4 authority nodes, 3 members in a role.
    // If a future change makes these limits BIND on an ordinary target, that is
    // a deliberate decision to record, not a default to drift into.
    expect(DEFAULT_BUDGET_LIMITS.chainReads).toBeGreaterThan(1600 * 10);
    expect(DEFAULT_BUDGET_LIMITS.logRequests).toBeGreaterThan(1590 * 2);
    expect(DEFAULT_BUDGET_LIMITS.authorityNodes).toBeGreaterThan(4 * 10);
    expect(DEFAULT_BUDGET_LIMITS.roleMembers).toBeGreaterThan(3 * 10);
  });
});

describe("BudgetedChainReader is transparent until the ceiling", () => {
  it("passes identity and every value through unchanged", async () => {
    const counts = { reads: 0, logs: 0 };
    const inner = countingChain(counts);
    const reader = new BudgetedChainReader(inner, new AnalysisBudget());
    expect(reader.chainId).toBe(inner.chainId);
    expect(reader.blockNumber).toBe(inner.blockNumber);
    expect(await reader.call(ADDR, "0x00" as Hex)).toEqual(await inner.call(ADDR, "0x00" as Hex));
    expect((await reader.getCode(ADDR)).code).toBe("0x60");
  });

  it("counts one read per call, across every read method", async () => {
    const budget = new AnalysisBudget();
    const reader = new BudgetedChainReader(countingChain({ reads: 0, logs: 0 }), budget);
    await reader.getCode(ADDR);
    await reader.getStorageAt(ADDR, "0x0" as Hex);
    await reader.call(ADDR, "0x00" as Hex);
    await reader.probeCall(ADDR, "0x00" as Hex, ADDR);
    await reader.getBlockHash();
    await reader.getCodeAtBlock(ADDR, 1n);
    expect(budget.consumed("chainReads")).toBe(6);
  });

  it("charges getLogs to BOTH the read total and the log budget", async () => {
    const budget = new AnalysisBudget();
    const reader = new BudgetedChainReader(countingChain({ reads: 0, logs: 0 }), budget);
    await reader.getLogs({ address: ADDR, event: "event X()", fromBlock: 0n, toBlock: 1n });
    expect(budget.consumed("chainReads")).toBe(1);
    expect(budget.consumed("logRequests")).toBe(1);
  });

  it("stops issuing reads once the ceiling is reached, and does not reach the provider", async () => {
    const counts = { reads: 0, logs: 0 };
    const reader = new BudgetedChainReader(countingChain(counts), new AnalysisBudget({ ...DEFAULT_BUDGET_LIMITS, chainReads: 2 }));
    await reader.call(ADDR, "0x00" as Hex);
    await reader.call(ADDR, "0x01" as Hex);
    await expect(reader.call(ADDR, "0x02" as Hex)).rejects.toThrow(BudgetExhaustedError);
    expect(counts.reads).toBe(2); // the refused read never became a request
  });

  it("budgetOf finds the budget on a budgeted reader and null on a plain one", () => {
    const inner = countingChain({ reads: 0, logs: 0 });
    const budget = new AnalysisBudget();
    expect(budgetOf(new BudgetedChainReader(inner, budget))).toBe(budget);
    // A null is "this reader belongs to no report-wide analysis", which is the
    // case for a unit-test fake and for the fork engines' direct chain.
    expect(budgetOf(inner)).toBeNull();
  });
});

// --- the property that matters: an exhaustion can only make a verdict harsher ---

const evaluatedSurface = (): CapabilitiesResult =>
  ({
    taxonomyVersion: "0.2.0",
    selectorAnalyzer: { name: "evmole", version: "0.9.3" },
    dispatcherRecognized: true,
    scannedAddress: null,
    probedAddress: ADDR,
    selectorsExtracted: 1,
    unmatchedSelectors: [],
    findings: [],
    needsManualVerification: [],
    evidence: [],
  }) as unknown as CapabilitiesResult;

const noOwner = (): OwnerField => ({ address: null, source: "owner() reverted", evidence: [] });
const noProxy = (): ProxyResult =>
  ({ pattern: "not_a_proxy", isProxy: false, implementation: null, beacon: null, admin: null, evidence: [] }) as ProxyResult;

const derive = (budgetExhaustions: Parameters<typeof deriveEnumerationCompleteness>[0]["budgetExhaustions"]) =>
  deriveEnumerationCompleteness({
    budgetExhaustions,
    accessControl: { detected: false, method: "not_applicable", roles: [], reconstruction: null },
    authorityResolution: { maxDepth: 3, roots: [], paths: [], cyclesDetected: [] },
    dependencies: { tokens: [], oracles: [] },
    errors: [],
    capabilities: evaluatedSurface(),
    owner: noOwner(),
    pendingOwner: noOwner(),
    proxy: noProxy(),
    indirection: null,
  });

describe("a budget boundary reaches the enumeration witness", () => {
  it("an otherwise-clean analysis is complete when nothing ran out", () => {
    const e = derive([]);
    expect(e.complete).toBe(true);
    expect(witnessOf(e)).not.toBeNull();
  });

  it("one exhaustion withholds the witness, so no reassuring assessment can be constructed", () => {
    const e = derive([
      {
        dimension: "authorityNodes",
        limit: 200,
        requested: 201,
        where: "authorityResolution",
        consequence: "the recursion stopped",
      },
    ]);
    expect(e.complete).toBe(false);
    // `binding` and `immutable_within_checks` require this witness and cannot be
    // built without it — the same structural refusal edge #30 introduced.
    expect(witnessOf(e)).toBeNull();
    expect(e.gaps.some((g) => g.site.kind === "budget" && g.site.id === "authorityNodes")).toBe(true);
  });

  it("names what was not examined rather than what was found", () => {
    const [gap] = derive([
      { dimension: "logRequests", limit: 6000, requested: 9000, where: "accessControl:0xaa", consequence: "recent window only" },
    ]).gaps;
    expect(gap!.reason).toMatch(/6000/);
    expect(gap!.reason).toMatch(/accessControl:0xaa/);
    expect(gap!.reason).toMatch(/not examined/i);
    // It must never read as a statement about the contract.
    expect(gap!.reason).not.toMatch(/no .* found/i);
  });

  it("keys the gap by DIMENSION, so one ceiling met at many sites is one gap", () => {
    const e = derive([
      { dimension: "roleMembers", limit: 500, requested: 900, where: "accessControl:0xaa", consequence: "floor" },
      { dimension: "roleMembers", limit: 500, requested: 900, where: "accessControl:0xbb", consequence: "floor" },
    ]);
    const keys = new Set(e.gaps.map((g) => `${g.site.kind}:${g.site.id}`));
    expect(keys.has("budget:roleMembers")).toBe(true);
    expect(e.complete).toBe(false);
  });
});
