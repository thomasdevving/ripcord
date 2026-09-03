import type { ForkTxView, ForkBlockView, ForkBlocks } from "./dto.js";
import type { Report } from "../../src/report/schema.js";

export function forkTransactions(evidence: readonly unknown[]): ForkTxView[] {
  const out: ForkTxView[] = [];
  for (const entry of evidence) {
    if (typeof entry !== "object" || entry === null) continue;
    const params = (entry as { params?: Record<string, unknown> }).params;
    const rawValue = (entry as { rawValue?: Record<string, unknown> }).rawValue;
    if (!params || params.method !== "eth_sendTransaction" || params.forkOnly !== true || !rawValue) continue;
    const receipt = (rawValue as { receipt?: Record<string, unknown> }).receipt;
    if (!receipt) continue;
    out.push({
      action: String(params.action ?? "transaction"),
      from: String(params.from ?? ""),
      to: params.to === null || params.to === undefined ? null : String(params.to),
      selector: params.selector === null || params.selector === undefined ? null : String(params.selector),
      status: receipt.status === "success" ? "success" : receipt.status === "reverted" ? "reverted" : "unknown",
      transactionHash: typeof rawValue.transactionHash === "string" ? rawValue.transactionHash : null,
      calldata: typeof params.calldata === "string" ? params.calldata : null,
      gasUsed: String(receipt.gasUsed ?? ""),
      localBlock: String(receipt.blockNumber ?? ""),
      localTimestamp: String(receipt.blockTimestamp ?? ""),
      revertData: (rawValue as { revertData?: unknown }).revertData == null ? null : String((rawValue as { revertData: unknown }).revertData),
    });
  }
  return out;
}

const object = (v: unknown): Record<string, unknown> => typeof v === "object" && v !== null ? v as Record<string, unknown> : {};
/** The engine records explicit action/phase names. Never split by array index:
 * old baseline evidence arrays included later mutations through aliasing. */
function stepOf(entry: unknown): "baseline" | "mutation" | "reexit" {
  const p = object(object(entry).params);
  if (p.action === "holder withdraw after candidate" || /withdrawal after candidate/.test(String(p.phase ?? ""))) return "reexit";
  if (p.action === "guardian pause withdraw" || /candidate mutation/.test(String(p.phase ?? ""))) return "mutation";
  return "baseline";
}

export function forkBlocksFromReport(report: Report): ForkBlocks | null {
  const er = report.exitRestriction;
  if (!er) return null;
  const candidate = er.candidates[0]; // currently one registered candidate
  const all = [...er.baseline.evidence, ...(candidate?.evidence ?? [])];
  const unique = [...new Map(all.map(e => [JSON.stringify(e), e])).values()];
  const groups = { baseline: unique.filter(e => stepOf(e) === "baseline"), mutation: unique.filter(e => stepOf(e) === "mutation"), reexit: unique.filter(e => stepOf(e) === "reexit") };
  const version = report.rulesetVersion.split(".").map(Number);
  const modern = (version[0] ?? 0) > 0 || (version[1] ?? 0) >= 13;
  const legacy = !modern || !forkTransactions(groups.baseline).every(tx => tx.localTimestamp !== "");
  const make = (evidence: unknown[], detail: string, established: boolean | null = null): ForkBlockView => ({ evidence, detail, established, transactions: forkTransactions(evidence), legacy });
  return {
    baseline: make(groups.baseline, `${legacy ? "Legacy evidence: the recorded baseline does not establish today's full-position economic and matched-clock checks. " : ""}${er.baseline.note}`, legacy ? null : er.baseline.status === "established"),
    mutation: candidate ? make(groups.mutation, groups.mutation.length ? "Candidate call and recorded pause-state reads; see the differential outcome in C." : "Candidate recorded, but separate mutation receipts are unavailable.") : null,
    reexit: candidate ? make(groups.reexit, candidate.detail) : null,
  };
}

export function preferLiveBlocks(live: ForkBlocks, report: Report | null): ForkBlocks {
  const stored = report && forkBlocksFromReport(report);
  // The completed artifact is authoritative. During a run merge step by step.
  return { baseline: stored?.baseline ?? live.baseline, mutation: stored?.mutation ?? live.mutation, reexit: stored?.reexit ?? live.reexit };
}
