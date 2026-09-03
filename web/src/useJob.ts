/**
 * Subscribes to one job and keeps a consistent local view of it.
 *
 * THE HARD PART IS RECONNECTION, and it is worth being explicit about why the
 * shape below is what it is.
 *
 * A run is minutes long. During it a user may refresh, lose wifi, or sit behind
 * a proxy that buffers event streams. Each of those means the client rejoins a
 * stream already in progress. Three rules keep the rendered timeline honest:
 *
 *  1. START FROM A SNAPSHOT. On mount we fetch `/api/jobs/:id`, which carries
 *     the full phase list, the structural graph and `lastSeq`. Only then do we
 *     subscribe, from that cursor. Subscribing first and back-filling would show
 *     a page that fills in backwards.
 *
 *  2. DEDUPE ON `seq`, ALWAYS. Events can arrive twice — an SSE auto-retry
 *     replays from its own cursor, and the polling fallback can overlap a
 *     recovering stream. Applying an event twice would double-count fork
 *     transactions, which are exactly the numbers a reviewer will scrutinise.
 *
 *  3. A `resync` MEANS RE-SNAPSHOT, NOT "CARRY ON". If our cursor has fallen off
 *     the server's retained history, the events we can still be sent are a
 *     partial tail. Rendering that tail as though it were the whole run would
 *     produce a plausible, wrong timeline — so we throw the local view away and
 *     take a fresh snapshot instead.
 *
 * Nothing here derives a conclusion. It accumulates what the server reported.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ForkTxView, JobEvent, JobSummary, PhaseId, PhaseSnapshot, PhaseStatus, StructuralSnapshot } from "@shared/dto";
import { isTerminal } from "@shared/dto";
import { getJob, streamJobEvents } from "./api.js";

export interface ForkBlockView {
  established: boolean | null;
  detail: string;
  transactions: ForkTxView[];
}

export interface JobView {
  summary: JobSummary | null;
  phases: PhaseSnapshot[];
  structure: StructuralSnapshot | null;
  fork: { baseline: ForkBlockView | null; mutation: ForkBlockView | null; reexit: ForkBlockView | null };
  reportId: string | null;
  /** Present whenever a report was produced but withheld — never carries what was withheld. */
  blockedMessage: string | null;
  transport: "sse" | "polling" | "closed" | "connecting";
  loadError: string | null;
}

export function useJob(jobId: string): JobView {
  const [summary, setSummary] = useState<JobSummary | null>(null);
  const [phases, setPhases] = useState<PhaseSnapshot[]>([]);
  const [structure, setStructure] = useState<StructuralSnapshot | null>(null);
  const [fork, setFork] = useState<JobView["fork"]>({ baseline: null, mutation: null, reexit: null });
  const [reportId, setReportId] = useState<string | null>(null);
  const [blockedMessage, setBlockedMessage] = useState<string | null>(null);
  const [transport, setTransport] = useState<JobView["transport"]>("connecting");
  const [loadError, setLoadError] = useState<string | null>(null);

  // The cursor is a ref, not state: `streamJobEvents` reads it through a
  // callback on every (re)connect, and a stale closure over a state value would
  // resume from the wrong place after a re-snapshot.
  const cursor = useRef(0);
  const seen = useRef(new Set<number>());

  /** Set once the snapshot shows a terminal job, so the stream is never opened for one. */
  const terminal = useRef(false);

  const snapshot = useCallback(async () => {
    try {
      const s = await getJob(jobId);
      terminal.current = isTerminal(s.state);
      setSummary(s);
      setPhases(s.phases);
      setStructure(s.structure);
      setReportId(s.reportId);
      setBlockedMessage(s.disclosure && !s.disclosure.publishable ? s.disclosure.message : null);
      cursor.current = s.lastSeq;
      seen.current = new Set();
      setLoadError(null);
    } catch {
      setLoadError("This analysis could not be loaded. It may have been pruned, or the link may be wrong.");
    }
  }, [jobId]);

  const apply = useCallback((event: JobEvent) => {
    if (seen.current.has(event.seq)) return;
    seen.current.add(event.seq);
    cursor.current = Math.max(cursor.current, event.seq);

    const setPhase = (id: PhaseId, status: PhaseStatus, detail: string | null, metrics?: PhaseSnapshot["metrics"]) =>
      setPhases((prev) =>
        prev.map((p) => (p.id === id ? { ...p, status, detail, ...(metrics ? { metrics } : {}) } : p)),
      );

    switch (event.type) {
      case "stage.started":
        setPhase(event.phase, "running", null);
        break;
      case "stage.completed":
        setPhase(event.phase, "completed", event.detail, event.metrics);
        break;
      case "stage.inconclusive":
        setPhase(event.phase, "inconclusive", event.detail);
        break;
      case "stage.degraded":
        setPhase(event.phase, "degraded", event.detail);
        break;
      case "stage.failed":
        setPhase(event.phase, "failed", event.detail);
        break;
      case "stage.skipped":
        setPhase(event.phase, "skipped", event.detail);
        break;
      case "structure":
        // Whole snapshots, not diffs — so a client that reconnected mid-run
        // renders a correct graph from one event rather than replaying a diff
        // history it may have gaps in.
        setStructure(event.snapshot);
        break;
      case "fork.baseline.completed":
        setFork((f) => ({ ...f, baseline: { established: event.established, detail: event.detail, transactions: event.transactions } }));
        break;
      case "fork.mutation.completed":
        setFork((f) => ({ ...f, mutation: { established: null, detail: event.detail, transactions: event.transactions } }));
        break;
      case "fork.reexit.completed":
        setFork((f) => ({ ...f, reexit: { established: null, detail: event.detail, transactions: event.transactions } }));
        break;
      case "report.ready":
        // A blocked report yields NO id. There is nothing to fetch, and no
        // identifier to try against the report route.
        setReportId(event.publishable ? event.reportId : null);
        if (!event.publishable) {
          setBlockedMessage(
            "This report is withheld pending manual review: Ripcord could not attribute at least one privileged function to a guard it recognises, so the possibility that it is unguarded cannot be ruled out. This says nothing about whether such a vulnerability exists.",
          );
        }
        break;
      case "job.state":
        setSummary((s) => (s ? { ...s, state: event.state, queuePosition: event.queuePosition } : s));
        // A terminal state changes fields the event does not carry (endedAt,
        // final phase statuses), so re-snapshot rather than patch piecemeal.
        if (isTerminal(event.state)) {
          // The job is over: re-snapshot for the fields the event does not
          // carry, then let the effect's cleanup drop the stream on the next
          // render rather than keeping a dead connection open.
          terminal.current = true;
          void snapshot();
        }
        break;
      case "job.error":
        setSummary((s) => (s ? { ...s, error: { message: event.message, hint: event.hint } } : s));
        break;
      default:
        break;
    }
  }, [snapshot]);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;

    void (async () => {
      await snapshot();
      if (cancelled) return;
      // A FINISHED job gets no stream. There is nothing further to receive, and
      // opening one would hold a server connection open per viewer for as long
      // as the tab stayed on a completed report. It also makes the page settle:
      // an SSE connection that never closes keeps the document permanently
      // "loading", which is how this surfaced — a headless screenshot of a
      // completed analysis never returned.
      if (terminal.current) {
        setTransport("closed");
        return;
      }
      unsubscribe = streamJobEvents(jobId, () => cursor.current, {
        onEvent: apply,
        onResync: () => void snapshot(),
        onTransport: setTransport,
      });
    })();

    return () => {
      cancelled = true;
      // Detaches the LISTENER only. The server-side job keeps running: closing
      // a tab must not be able to change an analysis outcome.
      unsubscribe?.();
    };
  }, [jobId, snapshot, apply]);

  return { summary, phases, structure, fork, reportId, blockedMessage, transport, loadError };
}
