/**
 * The parent↔worker IPC contract.
 *
 * Heavy analysis runs in a forked child process, not on the HTTP event loop.
 * A single Comet run does thousands of RPC round-trips, spawns anvil, and does
 * real bigint work; on the server's own loop that would stall SSE heartbeats,
 * /healthz and every other request for minutes, which on a platform with an
 * HTTP health check means the deploy gets restarted mid-demo.
 *
 * TWO THINGS THIS PROTOCOL DELIBERATELY IS NOT:
 *
 *  - It is not stdout parsing. Nothing here reads the CLI's human-facing text.
 *    Those strings exist for a person reading a terminal; treating them as a
 *    progress protocol makes every wording change a breaking change, and it
 *    silently loses anything the CLI chose not to print. The worker imports the
 *    engine functions directly and reports through typed messages.
 *
 *  - It is not a shell. The worker is started with `fork()` and receives its
 *    parameters as a structured message. No user input is ever interpolated
 *    into a command line, and the worker accepts no RPC URL, no anvil flags and
 *    no path from the request — those come from server configuration only.
 */
import type { JobEventPayload, RunMode } from "../shared/dto.js";

/** Parent → worker. Sent exactly once, immediately after fork. */
export interface StartMessage {
  type: "start";
  jobId: string;
  address: string;
  chainId: number;
  /** Already resolved and pinned by the parent. The worker never re-resolves "latest". */
  blockNumber: string;
  blockHash?: string | null;
  mode: RunMode;
  /** Server-side configuration. Never sourced from the HTTP request. */
  rpcUrl: string;
  cacheDir: string;
  artifactDir: string;
}

/** Parent → worker. A cooperative stop; the parent follows with SIGTERM/SIGKILL if ignored. */
export interface CancelMessage {
  type: "cancel";
}

export type ParentMessage = StartMessage | CancelMessage;

/**
 * Worker → parent.
 *
 * `event` carries a JobEvent MINUS the transport fields the parent stamps on
 * (`seq`, `jobId`, `at`). The worker cannot mint a sequence number correctly —
 * only the parent sees the whole stream — and letting it try would produce gaps
 * a browser would render as missing progress.
 */
export type WorkerEventPayload = JobEventPayload;

export interface WorkerEventMessage {
  type: "event";
  payload: WorkerEventPayload;
}

export interface WorkerDoneMessage {
  type: "done";
  /** The full schema-valid report, serialised. The parent decides where it is stored and who may read it. */
  report: string;
  publishable: boolean;
  verdictStatus: string | null;
  hasExitRestriction: boolean;
  generatedAt: string;
  schemaVersion: string;
  rulesetVersion: string;
  blockHash: string | null;
}

export interface WorkerFailedMessage {
  type: "failed";
  /** ALREADY SANITISED by the worker before it is sent (see sanitize.ts) — no RPC URL can ride out on this path. */
  message: string;
  hint: string | null;
  code: string;
}

export type WorkerMessage = WorkerEventMessage | WorkerDoneMessage | WorkerFailedMessage;

export function isWorkerMessage(value: unknown): value is WorkerMessage {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return type === "event" || type === "done" || type === "failed";
}
