/**
 * Rebuilding the three fork evidence blocks from a stored report.
 *
 * WHY THIS EXISTS. During a live run the blocks arrive as SSE events. After a
 * reload — or when opening a shared report link — there are no events to
 * replay, and the blocks would be empty. Empty is not neutral here: the UI
 * would say "the withdrawal experiment did not run for this target" about a
 * differential that had, in fact, run and found a restrictor. That is a
 * false-clean reached through a page refresh.
 *
 * So the same blocks are derived from the report, which is the authoritative
 * artifact either way. Everything is COPIED from evidence the engine recorded;
 * nothing is computed, because a receipt fact invented by the UI would be
 * indistinguishable on screen from one the fork produced.
 */
import type { ForkTxView } from "@shared/dto";
import type { Report } from "./report-types.js";
import type { ForkBlockView } from "./useJob.js";

/**
 * Pulls fork transactions out of an evidence array.
 *
 * Reads only entries the engine wrote as `eth_sendTransaction`, so an ordinary
 * `eth_call` read is never rendered as a transaction. Mirrors the server-side
 * extractor in `server/jobs/observer.ts`, so a report opened from a link shows
 * exactly what the live run showed.
 */
export function forkTransactions(evidence: readonly unknown[]): ForkTxView[] {
  const out: ForkTxView[] = [];
  for (const entry of evidence) {
    if (typeof entry !== "object" || entry === null) continue;
    const params = (entry as { params?: Record<string, unknown> }).params;
    const rawValue = (entry as { rawValue?: Record<string, unknown> }).rawValue;
    if (!params || params.method !== "eth_sendTransaction" || !rawValue) continue;
    const receipt = (rawValue as { receipt?: Record<string, unknown> }).receipt;
    if (!receipt) continue;
    out.push({
      action: String(params.action ?? "transaction"),
      from: String(params.from ?? ""),
      to: params.to == null ? null : String(params.to),
      selector: params.selector == null ? null : String(params.selector),
      status: receipt.status === "success" ? "success" : "reverted",
      gasUsed: String(receipt.gasUsed ?? ""),
      localBlock: String(receipt.blockNumber ?? ""),
      localTimestamp: String(receipt.blockTimestamp ?? ""),
      revertData: (rawValue as { revertData?: unknown }).revertData == null ? null : String((rawValue as { revertData: unknown }).revertData),
    });
  }
  return out;
}

export interface ForkBlocks {
  baseline: ForkBlockView | null;
  mutation: ForkBlockView | null;
  reexit: ForkBlockView | null;
}

/**
 * Returns the blocks a stored report can support, or null when it carries no
 * fork evaluation at all.
 *
 * `reexit` is deliberately null. A stored report keeps the mutation and the
 * re-exit in ONE candidate evidence array, and splitting it by guesswork would
 * be inventing a boundary the engine did not record. The candidate's own
 * `detail` states the differential's outcome in full, so nothing is lost — and
 * the block renders as "did not run" rather than as a fabricated third step.
 */
export function forkBlocksFromReport(report: Report): ForkBlocks | null {
  const er = report.exitRestriction;
  if (!er) return null;
  const candidate = er.candidates[0];
  return {
    baseline: {
      established: er.baseline.status === "established",
      detail: er.baseline.note,
      transactions: forkTransactions(er.baseline.evidence),
    },
    mutation: candidate
      ? { established: null, detail: candidate.detail, transactions: forkTransactions(candidate.evidence) }
      : null,
    reexit: null,
  };
}

/**
 * Whichever view is real.
 *
 * Live events win while a run is in flight — they arrive step by step and show
 * the experiment happening. Once the page is reloaded there are none, and the
 * report's own evidence takes over.
 */
export function preferLiveBlocks(live: ForkBlocks, report: Report | null): ForkBlocks {
  if (live.baseline || live.mutation || live.reexit) return live;
  return (report && forkBlocksFromReport(report)) ?? live;
}
