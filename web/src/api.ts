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

export const createJob = (body: { address: string; chainId: number; block: string; mode: RunMode; idempotencyKey?: string }) =>
  request<CreateJobResponse>("/api/jobs", { method: "POST", body: JSON.stringify(body) });

export const getJob = (jobId: string) => request<JobSummary>(`/api/jobs/${encodeURIComponent(jobId)}`);

export const cancelJob = (jobId: string, controlToken: string) =>
  request<{ status: string }>(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST",
    body: JSON.stringify({ controlToken }),
  });

export const listReports = () => request<{ reports: SavedReportListItem[] }>("/api/reports");

export const getReport = (id: string) =>
  request<{ id: string; origin: "live" | "calibration"; report: unknown }>(`/api/reports/${encodeURIComponent(id)}`);

export const pollEvents = (jobId: string, after: number) =>
  request<{ events: JobEvent[]; truncated: boolean; summary: JobSummary }>(
    `/api/jobs/${encodeURIComponent(jobId)}/events/poll?after=${after}`,
  );

export interface StreamHandlers {
  onEvent: (event: JobEvent) => void;
  /** The cursor fell off the retained history: the caller must re-snapshot rather than assume continuity. */
  onResync: () => void;
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
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let sseFailures = 0;

  const startPolling = () => {
    if (closed) return;
    handlers.onTransport("polling");
    const tick = async () => {
      if (closed) return;
      try {
        const { events, truncated } = await pollEvents(jobId, getCursor());
        if (truncated) handlers.onResync();
        for (const event of events) handlers.onEvent(event);
      } catch {
        // A failed poll is a transient network condition, not a fact about the
        // job. Keep the cadence and try again; the job is unaffected either way.
      }
      if (!closed) pollTimer = setTimeout(() => void tick(), 1500);
    };
    void tick();
  };

  const startSse = () => {
    if (closed) return;
    // `after` in the query string, because EventSource cannot set a
    // Last-Event-ID header on its FIRST connect — only on its own automatic
    // retries. Without it, a reconnect after a page refresh would replay from
    // the beginning and duplicate every event.
    source = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/events?after=${getCursor()}`);
    handlers.onTransport("sse");

    source.addEventListener("resync", () => handlers.onResync());

    source.onmessage = (msg) => {
      try {
        handlers.onEvent(JSON.parse(msg.data) as JobEvent);
      } catch {
        // A frame we cannot parse is dropped rather than crashing the stream.
        // It is the only case this catch covers: every frame the server sends
        // is JSON.stringify'd, so this means a truncated delivery.
      }
    };
    // Named event types arrive as their own listeners, not via onmessage.
    for (const type of EVENT_TYPES) {
      source.addEventListener(type, (msg) => {
        try {
          handlers.onEvent(JSON.parse((msg as MessageEvent).data) as JobEvent);
        } catch {
          // As above.
        }
      });
    }

    source.onerror = () => {
      if (closed) return;
      sseFailures++;
      source?.close();
      source = null;
      // Two failures is enough to conclude the path is blocked rather than
      // merely flaky — a buffering proxy fails consistently — and polling is
      // strictly better than a stalled stream.
      if (sseFailures >= 2) startPolling();
      else setTimeout(startSse, 1000);
    };
  };

  startSse();

  return () => {
    closed = true;
    source?.close();
    if (pollTimer) clearTimeout(pollTimer);
    handlers.onTransport("closed");
  };
}

/** Kept in sync with JobEvent's `type` union. A type missing here simply arrives via onmessage instead. */
const EVENT_TYPES = [
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
