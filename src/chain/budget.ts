/**
 * THE REPORT-WIDE BUDGET.
 *
 * Every individual limit in this codebase is real (the role scan's 1500-request
 * ceiling, the authority recursion's depth cap of 3, the one-level dependency
 * mandate), and their COMPOSITION is not. A report can reach a dozen
 * AccessControl contracts, each entitled to its own 1500 requests; the depth cap
 * bounds how FAR the recursion travels, not how many branches it visits; and
 * `getRoleMemberCount` returns a number supplied by the contract under analysis,
 * which is then iterated. So the cost of one report is bounded only by the shape
 * of the target — which is the same as saying it is not bounded.
 *
 * This module makes it bounded, under two rules that are not negotiable here:
 *
 * 1. DETERMINISM. Every dimension counts LOGICAL work — reads requested, nodes
 *    visited, members enumerated — never wall-clock time and never network
 *    attempts. A warm run makes zero network calls and a cold run makes
 *    thousands, and a budget that could be exhausted by one and not the other
 *    would make a report depend on whether someone had run it before. That is
 *    precisely the cold/warm divergence KNOWN EDGE #23 exists to forbid. There
 *    is deliberately no time budget.
 *
 * 2. EXHAUSTION IS NEVER QUIET, AND NEVER CLEAN. A budget that stops work is
 *    indistinguishable, in the result it produces, from a contract that had less
 *    to find — the exact "absence manufactured from a failed read" this project
 *    treats as its cardinal defect. So every exhaustion is recorded here, flows
 *    into the aggregate enumeration witness as a gap, and thereby makes the
 *    reassuring assessment variants structurally unconstructable. A budget can
 *    only ever make a verdict more cautious.
 */

/** The dimensions. Each is a count of logical work, deterministic under a fixed pinned block. */
export type BudgetDimension =
  /** Reads requested through ChainReader, whether they were served from disk or the network. */
  | "chainReads"
  /** eth_getLogs requests, counted report-wide rather than per contract scan. */
  | "logRequests"
  /** Contracts the authority recursion classified, across every branch at every depth. */
  | "authorityNodes"
  /** Role members enumerated, summed over every role on every contract. */
  | "roleMembers";

export interface BudgetLimits {
  chainReads: number;
  logRequests: number;
  authorityNodes: number;
  roleMembers: number;
}

/**
 * Defaults, chosen against the committed calibration corpus rather than by feel:
 * the most expensive of the 26 reports issues ~1,600 evidence-bearing reads and
 * ~1,590 of a single contract's log requests, visits 4 authority nodes, and
 * enumerates at most 3 members in a role. Each limit below sits far above the
 * observed maximum, so no report in the set can change — the budget's job in
 * this pass is to make the WORST case finite and labelled, not to trim the
 * ordinary one. Tightening these is a deliberate, measured change; see
 * docs/BASELINES.md.
 */
export const DEFAULT_BUDGET_LIMITS: BudgetLimits = {
  chainReads: 60_000,
  logRequests: 6_000,
  authorityNodes: 200,
  roleMembers: 500,
};

export interface BudgetExhaustion {
  dimension: BudgetDimension;
  limit: number;
  /** What was asked for at the moment the limit was reached — never a number below `limit`. */
  requested: number;
  /** The detector and subject that ran into it, e.g. "accessControl:0x…". */
  where: string;
  /** What the analysis did instead. Always a labelled partial or a loud failure, never a default. */
  consequence: string;
}

/**
 * Raised when the report-wide READ budget is gone. Thrown rather than degraded
 * because at that point no detector can complete honestly: the stage lands in
 * `errors[]` via build.ts's runStage, which the enumeration witness already
 * treats as a gap. A read budget that returned a default would be the failure
 * this whole file exists to prevent.
 */
export class BudgetExhaustedError extends Error {
  constructor(public readonly exhaustion: BudgetExhaustion) {
    super(
      `report-wide ${exhaustion.dimension} budget exhausted at ${exhaustion.limit} (${exhaustion.where}) — the analysis is INCOMPLETE, not finished`,
    );
    this.name = "BudgetExhaustedError";
  }
}

export class AnalysisBudget {
  private readonly used: Record<BudgetDimension, number> = {
    chainReads: 0,
    logRequests: 0,
    authorityNodes: 0,
    roleMembers: 0,
  };
  private readonly exhaustions: BudgetExhaustion[] = [];

  constructor(readonly limits: BudgetLimits = DEFAULT_BUDGET_LIMITS) {}

  consumed(dimension: BudgetDimension): number {
    return this.used[dimension];
  }

  /** How much of a dimension is left. Detectors ask this BEFORE planning work they cannot afford. */
  remaining(dimension: BudgetDimension): number {
    return Math.max(0, this.limits[dimension] - this.used[dimension]);
  }

  /**
   * Spends `amount` and reports whether it fit. A caller that gets `false` must
   * degrade to a LABELLED partial — the exhaustion is already recorded here, so
   * the report cannot come out looking clean either way, but a caller that
   * silently truncated would still be hiding WHERE the boundary was hit.
   */
  spend(dimension: BudgetDimension, amount: number, where: string, consequence: string): boolean {
    if (this.used[dimension] + amount > this.limits[dimension]) {
      this.record({
        dimension,
        limit: this.limits[dimension],
        requested: this.used[dimension] + amount,
        where,
        consequence,
      });
      return false;
    }
    this.used[dimension] += amount;
    return true;
  }

  /** Spends `amount` or throws. Used for the read budget, where there is no honest partial. */
  spendOrThrow(dimension: BudgetDimension, amount: number, where: string): void {
    if (this.used[dimension] + amount > this.limits[dimension]) {
      const exhaustion: BudgetExhaustion = {
        dimension,
        limit: this.limits[dimension],
        requested: this.used[dimension] + amount,
        where,
        consequence: "the stage was aborted and recorded in errors[]; nothing it would have found is claimed to be absent",
      };
      this.record(exhaustion);
      throw new BudgetExhaustedError(exhaustion);
    }
    this.used[dimension] += amount;
  }

  /**
   * Records a boundary a caller planned AROUND instead of running into.
   *
   * `accessControl.ts` asks how many log chunks the report can still afford and
   * scans only that many. Nothing is over-spent, so nothing throws — but the
   * scan is short BECAUSE of this budget, and a partial scan whose cause went
   * unrecorded is exactly the silent truncation the module refuses. Declaring it
   * puts the boundary in the report without charging for work never done.
   */
  declareExhausted(dimension: BudgetDimension, requested: number, where: string, consequence: string): void {
    this.record({ dimension, limit: this.limits[dimension], requested, where, consequence });
  }

  /**
   * Deduped by (dimension, where): one boundary hit repeatedly is one fact about
   * the analysis, and a thousand copies of it would bury the other gaps.
   */
  private record(exhaustion: BudgetExhaustion): void {
    const key = `${exhaustion.dimension}:${exhaustion.where}`;
    if (this.exhaustions.some((e) => `${e.dimension}:${e.where}` === key)) return;
    this.exhaustions.push(exhaustion);
  }

  /** Every boundary this run hit. Empty means "nothing ran out", never "nothing was counted". */
  get exhausted(): BudgetExhaustion[] {
    return [...this.exhaustions];
  }

  /** The record that goes in the report. A snapshot, not a live view. */
  snapshot(): {
    limits: BudgetLimits;
    consumed: Record<BudgetDimension, number>;
    exhausted: BudgetExhaustion[];
  } {
    return { limits: { ...this.limits }, consumed: { ...this.used }, exhausted: this.exhausted };
  }
}
