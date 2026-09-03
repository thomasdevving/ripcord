import { useEffect, useState } from "react";
import type { ForkBlocks, JobEvent, JobSummary, PhaseId, PhaseStatus, StructuralSnapshot } from "@shared/dto";
import { isTerminal } from "@shared/dto";
import { getJob, streamJobEvents } from "./api.js";
export type { ForkBlockView } from "@shared/dto";

export interface JobView {
  summary: JobSummary | null;
  phases: JobSummary["phases"];
  structure: StructuralSnapshot | null;
  fork: ForkBlocks;
  reportId: string | null;
  blockedMessage: string | null;
  transport: "sse" | "polling" | "closed" | "connecting";
  loadError: string | null;
}
const emptyFork = (): ForkBlocks => ({ baseline: null, mutation: null, reexit: null });

/** Pure transport reducer: no verdict or economic inference. */
export function applyJobEvent(summary: JobSummary, event: JobEvent): JobSummary {
  if (event.seq <= summary.lastSeq) return summary;
  const next = { ...summary, lastSeq: event.seq, phases: summary.phases.map(p => ({ ...p })), fork: { ...summary.fork ?? emptyFork() } };
  if (event.type === "runtime.stats") next.runtimeStats = event.stats;
  else if (event.type.startsWith("stage.")) {
    const e = event as JobEvent & { phase: PhaseId; detail?: string; metrics?: Record<string, string | number | boolean | null> };
    const phase = next.phases.find(p => p.id === e.phase);
    if (phase) {
      phase.status = event.type === "stage.started" ? "running" : event.type.slice(6) as PhaseStatus;
      phase.detail = e.detail ?? null;
      if (e.metrics) phase.metrics = e.metrics;
      const relative = summary.startedAt ? Date.parse(event.at) - Date.parse(summary.startedAt) : null;
      if (phase.status === "running") phase.startedAtMs ??= relative;
      else phase.endedAtMs = relative;
    }
  } else if (event.type === "structure") next.structure = event.snapshot;
  else if (event.type === "fork.baseline.completed") next.fork.baseline = { established: event.established, detail: event.detail, transactions: event.transactions, evidence: event.evidence ?? [] };
  else if (event.type === "fork.mutation.completed") next.fork.mutation = { established: null, detail: event.detail, transactions: event.transactions, evidence: event.evidence ?? [] };
  else if (event.type === "fork.reexit.completed") next.fork.reexit = { established: null, detail: event.detail, transactions: event.transactions, evidence: event.evidence ?? [] };
  else if (event.type === "job.state") {
    next.state = event.state;
    next.queuePosition = event.queuePosition;
    if (event.state === "running") next.startedAt ??= event.at;
  } else if (event.type === "report.ready") {
    next.reportId = event.publishable ? event.reportId : null;
    next.disclosure = { publishable: event.publishable, message: event.publishable ? "Publication review passed." : "This report is withheld pending manual review. No detailed findings are released." };
  } else if (event.type === "job.error") next.error = { message: event.message, hint: event.hint };
  return next;
}

export function useJob(jobId: string): JobView {
  const [summary, setSummary] = useState<JobSummary | null>(null);
  const [transport, setTransport] = useState<JobView["transport"]>("connecting");
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    let current: JobSummary | null = null;
    let unsubscribe: (() => void) | undefined;
    setSummary(null); setLoadError(null); setTransport("connecting");
    const accept = (s: JobSummary) => {
      if (disposed || (current && s.lastSeq < current.lastSeq)) return;
      current = s; setSummary(s); setLoadError(null);
    };
    const snapshot = async () => {
      const s = await getJob(jobId);
      accept(s);
      return isTerminal(s.state);
    };
    void snapshot().then(done => {
      if (disposed) return;
      if (done) { setTransport("closed"); return; }
      unsubscribe = streamJobEvents(jobId, () => current?.lastSeq ?? 0, {
        onResync: snapshot,
        onSnapshot: accept,
        onEvent: e => { if (!disposed && current) accept(applyJobEvent(current, e)); },
        onTransport: mode => { if (!disposed) setTransport(mode); },
      });
    }).catch(() => { if (!disposed) setLoadError("This analysis could not be loaded. Check the connection or reopen the link."); });
    return () => { disposed = true; unsubscribe?.(); };
  }, [jobId]);
  return { summary, phases: summary?.phases ?? [], structure: summary?.structure ?? null, fork: summary?.fork ?? emptyFork(), reportId: summary?.reportId ?? null,
    blockedMessage: summary?.disclosure && !summary.disclosure.publishable ? summary.disclosure.message : null, transport, loadError };
}
