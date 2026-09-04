/**
 * The parent↔worker IPC contract.
 *
 * Heavy analysis runs in a forked child, not on the HTTP event loop: a single
 * Comet run does thousands of RPC round-trips, spawns anvil and does real bigint
 * work, which would stall SSE heartbeats and /healthz for minutes — and on a
 * platform with an HTTP health check that restarts the deploy mid-demo.
 *
 * It is deliberately NOT stdout parsing: the CLI's strings exist for a person
 * reading a terminal, so treating them as a progress protocol makes every
 * wording change a breaking change. And it is not a shell: the worker is started
 * with `fork()` and receives structured parameters, accepting no RPC URL, anvil
 * flag or path from a request.
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
