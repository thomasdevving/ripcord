/**
 * The browser's API client.
 *
 * Everything is same-origin and relative (`/api/...`). There is no configurable
 * base URL and no `VITE_` variable: the app is served by the process that owns
 * the API, so a second host would only be a second thing to secure.
 *
 * THE PROGRESS CHANNEL is SSE with polling as a genuine fallback, not a
 * degraded mode. Both read the same event log through the same `seq` cursor, so
 * they cannot tell different stories — and conference wifi behind a buffering
 * proxy is exactly the environment this has to work in.
 *
 * THE ONE INVARIANT WORTH STATING: this file computes NO risk conclusion. It
 * moves bytes. Verdicts, notices, route minima and uncertainty all arrive
 * already decided by the server, because a second implementation of that logic
 * in the browser would eventually disagree with the first, and the one on screen
 * is the one people would believe.
 */
import type {
  ApiError,
  ConfigResponse,
  CreateJobResponse,
  JobEvent,
  JobSummary,
  RunMode,
  SavedReportListItem,
} from "@shared/dto";
import type { AssetCoverage } from "@shared/coverage";

export class ApiRequestError extends Error {
  constructor(public readonly api: ApiError, public readonly status: number) {
    super(api.message);
    this.name = "ApiRequestError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let api: ApiError = { code: "internal", message: `Request failed (${res.status}).`, hint: null };
    try {
      const body = (await res.json()) as { error?: ApiError; blocked?: boolean; message?: string };
      // 451 is the disclosure gate. Its message is already neutral by
      // construction (server/reports.ts) and safe to show verbatim.
      if (body.blocked) api = { code: "report_blocked", message: body.message ?? api.message, hint: null };
      else if (body.error) api = body.error;
    } catch {
      // A non-JSON error body (a proxy's own 502 page, say). The generic
      // message above already covers it; there is nothing further to extract.
    }
    throw new ApiRequestError(api, res.status);
  }
  return (await res.json()) as T;
}

export const getConfig = () => request<ConfigResponse>("/api/config");

export const createJob = (body: { address: string; chainId: number; block: string; mode: RunMode; idempotencyKey?: string; controlToken?: string }) =>
  request<CreateJobResponse>("/api/jobs", { method: "POST", body: JSON.stringify(body) });

export const getJob = (jobId: string) => request<JobSummary>(`/api/jobs/${encodeURIComponent(jobId)}`);

export const cancelJob = (jobId: string, controlToken: string) =>
  request<{ status: string }>(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST",
    body: JSON.stringify({ controlToken }),
  });

/**
 * Asset coverage for a report. Goes through the same publication gate as the
 * report body, so a blocked report yields a 451 here too.
 */
export const getCoverage = (id: string) =>
  request<{ id: string; coverage: AssetCoverage }>(`/api/reports/${encodeURIComponent(id)}/coverage`);

export const listReports = () => request<{ reports: SavedReportListItem[] }>("/api/reports");

export const getReport = (id: string) =>
  request<{ id: string; origin: "live" | "calibration"; report: unknown; structure: import("@shared/dto").StructuralSnapshot | null }>(`/api/reports/${encodeURIComponent(id)}`);

export const pollEvents = (jobId: string, after: number) =>
  request<{ events: JobEvent[]; truncated: boolean; summary: JobSummary }>(
    `/api/jobs/${encodeURIComponent(jobId)}/events/poll?after=${after}`,
  );

export interface StreamHandlers {
  onEvent: (event: JobEvent) => void;
  /** The cursor fell off the retained history: the caller must re-snapshot rather than assume continuity. */
  onResync: () => Promise<boolean | void>;
  onSnapshot?: (summary: JobSummary) => void;
  onTransport: (mode: "sse" | "polling" | "closed") => void;
}

/**
 * Subscribes to a job's events, preferring SSE and falling back to polling.
 *
 * `getCursor` is a callback rather than a value so a reconnect resumes from
 * what the caller has ACTUALLY APPLIED, not from where this function last was.
 * Those differ after a re-snapshot, and resuming from the wrong one silently
 * replays or skips events.
 *
 * Returns an unsubscribe function. Unsubscribing detaches this listener only —
 * the server-side job keeps running, by design.
 */
export function streamJobEvents(jobId: string, getCursor: () => number, handlers: StreamHandlers): () => void {
  let closed = false;
  let source: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastActivity = Date.now();
  let polling = false;
  let delivery = Promise.resolve();
  const terminal = (state: string) => ["completed", "failed", "cancelled", "timed_out", "interrupted"].includes(state);
  const stop = () => {
    if (closed) return;
    closed = true;
    source?.close();
    if (timer) clearTimeout(timer);
    clearInterval(watchdog);
    handlers.onTransport("closed");
  };
  const resync = async () => { if (!closed && await handlers.onResync()) stop(); };
  const deliver = async (event: JobEvent) => {
    if (closed || event.seq <= getCursor()) return;
    handlers.onEvent(event);
    if (event.type === "job.state" && terminal(event.state)) { await resync(); stop(); }
  };
  const startPolling = () => {
    if (closed || polling) return;
    polling = true;
    source?.close(); source = null;
    handlers.onTransport("polling");
    const tick = async () => {
      if (closed) return;
      try {
        const { events, truncated, summary } = await pollEvents(jobId, getCursor());
        if (closed) return;
        await delivery;
        if (truncated) await resync();
        for (const event of events) await deliver(event);
        if (!closed) handlers.onSnapshot?.(summary);
        if (terminal(summary.state)) { await resync(); stop(); }
      } catch { /* transient delivery failure: preserve the last measured state */ }
      if (!closed) timer = setTimeout(() => { timer = null; void tick(); }, 1500);
    };
    void tick();
  };
  // A proxy can buffer SSE forever without reporting an error. Named heartbeats
  // make liveness measurable; a quiet engine is not mistaken for a dead stream.
  const watchdog = setInterval(() => {
    if (source && Date.now() - lastActivity > 35_000) startPolling();
  }, 5000);
  source = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/events?after=${getCursor()}`);
  handlers.onTransport("sse");
  source.addEventListener("heartbeat", () => { lastActivity = Date.now(); });
  source.addEventListener("resync", () => {
    lastActivity = Date.now();
    delivery = delivery.then(resync).catch(startPolling);
  });
  for (const type of EVENT_TYPES) source.addEventListener(type, msg => {
    lastActivity = Date.now();
    delivery = delivery.then(async () => {
      try { await deliver(JSON.parse((msg as MessageEvent).data) as JobEvent); }
      catch { await resync(); }
    }).catch(startPolling);
  });
  source.onerror = startPolling;
  return stop;
}

/** Kept in sync with JobEvent's `type` union. A type missing here simply arrives via onmessage instead. */
const EVENT_TYPES = [
  "runtime.stats",
  "job.state",
  "stage.started",
  "stage.completed",
  "stage.inconclusive",
  "stage.degraded",
  "stage.failed",
  "stage.skipped",
  "structure",
  "fork.baseline.completed",
  "fork.mutation.completed",
  "fork.reexit.completed",
  "report.ready",
  "job.error",
] as const;
