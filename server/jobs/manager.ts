/**
 * THE JOB MANAGER — queue, worker lifecycle, event stream, cancellation.
 *
 * One object owns everything that can outlive an HTTP request, because the
 * alternative (state spread across route handlers) is how a service ends up with
 * an orphaned anvil process and a queue that never drains.
 *
 * The properties it is responsible for, and why each one is here rather than
 * "handled by the caller":
 *
 *  - A JOB OUTLIVES ITS REQUEST. `POST /api/jobs` returns 202 immediately and
 *    the analysis keeps running. Closing the browser tab does not cancel it, and
 *    a disconnected SSE consumer cannot change the outcome: events accumulate in
 *    a bounded history that a reconnecting client resumes from.
 *
 *  - EVERY EVENT HAS A MONOTONIC PER-JOB SEQUENCE. That is what makes reconnect
 *    correct rather than best-effort. A client resumes from `lastSeq`; if that
 *    cursor has fallen off the back of the bounded history, it gets a fresh
 *    consistent snapshot instead of a silent gap — a gap would render as
 *    "nothing happened", which is precisely the wrong thing to show.
 *
 *  - CANCELLATION IS AUTHORISED BY A SECRET, NOT BY THE JOB ID. Job ids appear
 *    in shareable URLs. If the id were sufficient, anyone with a link could kill
 *    someone else's run. The control token is returned exactly once, to the
 *    submitter, and only its hash is stored.
 *
 *  - EVERY EXIT PATH KILLS THE WORKER. Success, failure, timeout, cancellation
 *    and service SIGTERM all route through `finish`, which terminates the child.
 *    Killing the worker is what guarantees its anvil child dies too — anvil is
 *    spawned by the worker, so it cannot outlive it. Nothing here ever kills a
 *    process it did not spawn.
 *
 *  - REPEATED SUBMITS DO NOT STACK. A resubmit with the same idempotency key and
 *    the same parameters returns the existing job. A deliberate re-run omits the
 *    key and gets a new execution id — the distinction is the user's to make,
 *    not something inferred from timing.
 */
import { fork, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ServerConfig } from "../config.js";
import { classify } from "../sanitize.js";
import type { CreateJobRequest, JobEvent, JobEventPayload, JobState, JobSummary, PhaseId, PhaseSnapshot, PhaseStatus, RunMode } from "../shared/dto.js";
import { isTerminal, phasesForMode } from "../shared/dto.js";
import { JobStore, type JobRecord, type StoredReportMeta } from "./store.js";
import { isWorkerMessage, type StartMessage, type WorkerMessage } from "./protocol.js";

/** How many events per job stay in memory for reconnect replay. Beyond this a client is given a fresh snapshot. */
const EVENT_HISTORY_LIMIT = 2000;

/** Retention bounds. Reports outlive jobs because a shared report URL should keep working. */
const RETENTION = { maxJobs: 200, maxReports: 500 };

export interface CreateJobOutcome {
  record: JobRecord;
  controlToken: string;
  deduplicated: boolean;
}

export class QueueFullError extends Error {
  constructor(public readonly queued: number, public readonly max: number) {
    super(`the analysis queue is full (${queued}/${max} waiting)`);
    this.name = "QueueFullError";
  }
}

interface LiveJob {
  record: JobRecord;
  events: JobEvent[];
  child: ChildProcess | null;
  timeoutHandle: NodeJS.Timeout | null;
  /**
   * Set SYNCHRONOUSLY the moment a `done` or `failed` message arrives.
   *
   * Node does not order the `message` and `exit` events of a child relative to
   * each other: a worker that sends its result and then exits can have `exit`
   * dispatched to us FIRST. Without this flag the exit handler then reports
   * "stopped unexpectedly" about an analysis that had in fact just succeeded —
   * observed live on a real Comet run, and reproduced intermittently by the job
   * tests. `onWorkerMessage` is async (it persists the report), so the record's
   * own state is not a usable signal here; this flag is.
   */
  terminalMessageSeen: boolean;
}

export class JobManager {
  private readonly jobs = new Map<string, LiveJob>();
  private readonly queue: string[] = [];
  private readonly running = new Set<string>();
  private readonly bus = new EventEmitter();
  /** True once shutdown has begun; `pump` checks it so no new work is scheduled during teardown. */
  private shuttingDown = false;
  /**
   * In-flight event persistence.
   *
   * Event writes are deliberately fire-and-forget on the hot path: an SSE frame
   * must not wait on a disk write. But a SHUTDOWN that returns before those
   * writes land loses the tail of the event log — the part describing how the
   * job ended, which is exactly what a reader coming back afterwards needs.
   * `shutdown` awaits this set.
   */
  private readonly pendingWrites = new Set<Promise<void>>();

  constructor(
    private readonly config: ServerConfig,
    private readonly store: JobStore,
    /** Absolute path to the compiled worker module. Resolved by the entrypoint, never from a request. */
    private readonly workerPath: string,
  ) {
    // One SSE consumer per browser tab, plus a poller each — the default of 10
    // is reached by a handful of viewers and would otherwise print a spurious
    // "possible memory leak" warning during a demo.
    this.bus.setMaxListeners(200);
  }

  // --- lifecycle -------------------------------------------------------------

  async init(): Promise<{ recovered: number }> {
    const recovered = await this.store.recoverInterruptedJobs();
    return { recovered };
  }

  /**
   * Stops everything, in the order that matters: refuse new work, then kill
   * running workers. Called from SIGTERM/SIGINT so a platform-initiated restart
   * does not leave an anvil process holding a port on the next boot.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const active = [...this.running];
    await Promise.all(active.map((id) => this.finish(id, "interrupted", { message: "The service is shutting down.", hint: "Start a new run once it is back." })));
    // Let the event log finish landing before the process goes away.
    await Promise.allSettled([...this.pendingWrites]);
  }

  // --- creation --------------------------------------------------------------

  async createJob(req: CreateJobRequest, resolvedBlock: bigint, blockSource: "explicit" | "resolved_latest"): Promise<CreateJobOutcome> {
    if (req.idempotencyKey) {
      // Same key AND same parameters returns the existing job. Comparing the
      // parameters too matters: a client reusing a key for a different address
      // must not silently receive results for the previous one.
      const existing = await this.findByIdempotencyKey(req.idempotencyKey, req, resolvedBlock);
      if (existing) return { record: existing, controlToken: "", deduplicated: true };
    }

    const queuedCount = this.queue.length;
    if (queuedCount >= this.config.maxQueuedJobs && this.running.size >= this.config.maxActiveJobs) {
      throw new QueueFullError(queuedCount, this.config.maxQueuedJobs);
    }

    const jobId = this.store.newJobId();
    // 32 bytes of CSPRNG. This is the only thing standing between a shared job
    // URL and a stranger cancelling the run behind it.
    const controlToken = randomBytes(32).toString("base64url");

    const record: JobRecord = {
      jobId,
      controlTokenHash: hashToken(controlToken),
      state: "queued",
      mode: req.mode,
      address: req.address,
      chainId: req.chainId,
      block: resolvedBlock.toString(),
      blockHash: null,
      blockSource,
      createdAt: new Date().toISOString(),
      startedAt: null,
      endedAt: null,
      phases: initialPhases(req.mode),
      structure: null,
      reportId: null,
      disclosure: null,
      error: null,
      lastSeq: 0,
      idempotencyKey: req.idempotencyKey ?? null,
    };

    this.jobs.set(jobId, { record, events: [], child: null, timeoutHandle: null, terminalMessageSeen: false });
    await this.store.saveJob(record);
    this.queue.push(jobId);
    this.emit(jobId, { type: "job.state", state: "queued", queuePosition: this.queuePosition(jobId), message: null });
    this.pump();
    return { record, controlToken, deduplicated: false };
  }

  private async findByIdempotencyKey(key: string, req: CreateJobRequest, block: bigint): Promise<JobRecord | null> {
    for (const live of this.jobs.values()) {
      const r = live.record;
      if (r.idempotencyKey !== key) continue;
      if (r.address.toLowerCase() !== req.address.toLowerCase()) continue;
      if (r.chainId !== req.chainId || r.block !== block.toString() || r.mode !== req.mode) continue;
      return r;
    }
    // Also consult disk: a resubmit after a restart should still not re-run a
    // scan that already completed.
    for (const r of await this.store.listJobs()) {
      if (r.idempotencyKey !== key) continue;
      if (r.address.toLowerCase() !== req.address.toLowerCase()) continue;
      if (r.chainId !== req.chainId || r.block !== block.toString() || r.mode !== req.mode) continue;
      return r;
    }
    return null;
  }

  // --- scheduling ------------------------------------------------------------

  private queuePosition(jobId: string): number | null {
    const index = this.queue.indexOf(jobId);
    return index === -1 ? null : index + 1;
  }

  /** Starts as many queued jobs as the active limit allows. Safe to call repeatedly. */
  private pump(): void {
    if (this.shuttingDown) return;
    while (this.running.size < this.config.maxActiveJobs && this.queue.length > 0) {
      const jobId = this.queue.shift();
      if (!jobId) break;
      const live = this.jobs.get(jobId);
      if (!live || live.record.state !== "queued") continue;
      void this.start(live);
    }
    // Everyone still waiting gets their new position, so a queued viewer sees
    // the line actually moving rather than a frozen "position 3".
    for (const jobId of this.queue) {
      this.emit(jobId, { type: "job.state", state: "queued", queuePosition: this.queuePosition(jobId), message: null });
    }
  }

  private async start(live: LiveJob): Promise<void> {
    const { record } = live;
    const rpcUrl = this.config.rpcUrls.get(record.chainId);
    if (!rpcUrl) {
      await this.finish(record.jobId, "failed", {
        message: "No RPC endpoint is configured for this chain on the server.",
        hint: "This is a server configuration gap, not a property of the contract.",
      });
      return;
    }

    record.state = "running";
    record.startedAt = new Date().toISOString();
    this.running.add(record.jobId);
    await this.store.saveJob(record);
    this.emit(record.jobId, { type: "job.state", state: "running", queuePosition: null, message: null });

    const artifactDir = await this.store.ensureArtifactDir(record.jobId);

    // `fork` rather than `spawn`: it gives a structured IPC channel, so the
    // parent never parses text, and it inherits no shell. User input reaches
    // the child only as fields of the typed start message below.
    const child = fork(this.workerPath, [], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      // `fork` inherits the parent's execArgv by default, and that is wrong here
      // in both directions. In production, a parent started with `--inspect`
      // makes every worker try to bind the same debug port and fail. Under a
      // test runner, the parent carries loader/condition flags that the plain
      // compiled worker neither needs nor survives — which is exactly how this
      // surfaced: the job-manager tests passed alone and hung as part of the
      // full suite. The worker is ordinary compiled JS; it needs no flags.
      execArgv: [],
      env: {
        // A DELIBERATELY NARROW ENVIRONMENT. The worker gets what it needs and
        // nothing else — notably no MOBULA_API_KEY, because the live layer must
        // stay out of the pinned path, and no unrelated platform secrets.
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        NODE_ENV: this.config.nodeEnv,
      },
    });
    live.child = child;

    child.stderr?.on("data", (d: Buffer) => {
      // Worker stderr is already sanitised at the source; the job id makes a
      // user-visible failure correlatable with this line.
      process.stderr.write(`[job ${record.jobId}] ${d.toString()}`);
    });

    child.on("message", (raw: unknown) => {
      if (!isWorkerMessage(raw)) return;
      // Synchronously, BEFORE any await: the exit handler below checks this.
      if (raw.type === "done" || raw.type === "failed") live.terminalMessageSeen = true;
      // A failure handling a worker message must fail THIS JOB, never the
      // service. Without this catch the rejection is unhandled and Node exits —
      // which is exactly what happened the first time a report was persisted
      // (a bad sidecar path threw inside saveReport and took the whole server
      // down mid-run, losing every other job with it).
      void this.onWorkerMessage(record.jobId, raw).catch((err: unknown) => {
        const api = classify(err, record.jobId);
        console.error(`[ripcord] job ${record.jobId}: failed to handle a worker message: ${api.message}`);
        void this.finish(record.jobId, "failed", {
          message: "The analysis finished but its result could not be stored.",
          hint: "This is a server-side storage failure, not a property of the contract.",
        });
      });
    });

    child.on("exit", (code, signal) => {
      // A worker that exits without EVER having sent `done` or `failed` died
      // unexpectedly (OOM, a hard kill). Do not let the job sit in `running`
      // forever; report it rather than leaving a spinner.
      //
      // Deferred by one macrotask because `exit` and `message` are not ordered
      // against each other: a worker that sends its result and immediately
      // exits can have `exit` delivered first, and deciding here and now would
      // declare a successful analysis dead. By the next tick any queued
      // `message` has been dispatched and `terminalMessageSeen` is set.
      setImmediate(() => {
        if (live.terminalMessageSeen || isTerminal(record.state)) return;
        void this.finish(record.jobId, "failed", {
          message: "The analysis process stopped unexpectedly before producing a result.",
          hint: `Exit ${code ?? "none"}${signal ? ` (${signal})` : ""}. Nothing about the contract follows from this.`,
        });
      });
    });

    live.timeoutHandle = setTimeout(() => {
      void this.finish(record.jobId, "timed_out", {
        message: `The analysis exceeded the ${Math.round(this.config.jobTimeoutMs / 1000)}s limit and was stopped.`,
        hint: "Deep-history role reconstruction on a range-capped RPC provider is the usual cause. A larger-range endpoint resolves it.",
      });
    }, this.config.jobTimeoutMs);

    const start: StartMessage = {
      type: "start",
      jobId: record.jobId,
      address: record.address,
      chainId: record.chainId,
      blockNumber: record.block,
      mode: record.mode,
      rpcUrl,
      cacheDir: this.store.cacheDir,
      artifactDir,
    };
    child.send(start);
  }

  // --- worker messages -------------------------------------------------------

  private async onWorkerMessage(jobId: string, msg: WorkerMessage): Promise<void> {
    const live = this.jobs.get(jobId);
    if (!live) return;

    if (msg.type === "event") {
      this.emit(jobId, msg.payload);
      this.applyToRecord(live, msg.payload);
      await this.store.saveJob(live.record);
      return;
    }

    if (msg.type === "failed") {
      await this.finish(jobId, msg.code === "cancelled" ? "cancelled" : "failed", { message: msg.message, hint: msg.hint });
      return;
    }

    // msg.type === "done"
    const reportId = this.store.newReportId();
    const meta: StoredReportMeta = {
      id: reportId,
      jobId,
      address: live.record.address,
      chainId: live.record.chainId,
      block: live.record.block,
      generatedAt: msg.generatedAt,
      schemaVersion: msg.schemaVersion,
      rulesetVersion: msg.rulesetVersion,
      verdictStatus: msg.verdictStatus,
      publishable: msg.publishable,
      hasExitRestriction: msg.hasExitRestriction,
      mode: live.record.mode,
    };
    // Stored regardless of publishability — a blocked report is still evidence
    // and its author may need it. What changes is who may READ it, and that is
    // enforced once, in the report route.
    await this.store.saveReport(reportId, JSON.parse(msg.report), meta);

    live.record.blockHash = msg.blockHash;
    live.record.disclosure = {
      publishable: msg.publishable,
      message: msg.publishable
        ? "This report passed the publication gate and can be read in full."
        : "This report is withheld pending manual review. Ripcord could not attribute at least one privileged function to a recognised guard, and the unguarded reading cannot be ruled out — publishing it would be a vulnerability claim about a live contract.",
    };
    // `reportId` is set ONLY when publishable. A client that receives a
    // reportId can fetch the body; making the id conditional means there is no
    // identifier to try against the report route for a blocked result.
    live.record.reportId = msg.publishable ? reportId : null;

    this.emit(jobId, {
      type: "report.ready",
      reportId: msg.publishable ? reportId : "",
      publishable: msg.publishable,
      verdictStatus: msg.verdictStatus,
    });
    await this.finish(jobId, "completed", null);
  }

  /** Folds a transport event into the persisted job record so a reload reconstructs the same view. */
  private applyToRecord(live: LiveJob, payload: JobEventPayload): void {
    const setPhase = (phase: PhaseId, status: PhaseStatus, detail: string | null, metrics?: Record<string, number | string | boolean | null>) => {
      const now = Date.now();
      const startedMs = live.record.startedAt ? Date.parse(live.record.startedAt) : now;
      const existing = live.record.phases.find((p) => p.id === phase);
      if (!existing) return;
      existing.status = status;
      existing.detail = detail;
      if (metrics) existing.metrics = metrics;
      if (status === "running") existing.startedAtMs = now - startedMs;
      else existing.endedAtMs = now - startedMs;
    };

    switch (payload.type) {
      case "stage.started":
        setPhase(payload.phase, "running", null);
        break;
      case "stage.completed":
        setPhase(payload.phase, "completed", payload.detail, payload.metrics);
        break;
      case "stage.inconclusive":
        setPhase(payload.phase, "inconclusive", payload.detail);
        break;
      case "stage.degraded":
        setPhase(payload.phase, "degraded", payload.detail);
        break;
      case "stage.failed":
        setPhase(payload.phase, "failed", payload.detail);
        break;
      case "stage.skipped":
        setPhase(payload.phase, "skipped", payload.detail);
        break;
      case "structure":
        live.record.structure = payload.snapshot;
        break;
      default:
        break;
    }
  }

  // --- termination -----------------------------------------------------------

  /**
   * The single exit path. Every terminal transition goes through here, which is
   * what makes "the worker is always killed" a property of the code rather than
   * a checklist item repeated at five call sites.
   */
  private async finish(jobId: string, state: JobState, error: { message: string; hint: string | null } | null): Promise<void> {
    const live = this.jobs.get(jobId);
    if (!live || isTerminal(live.record.state)) return;

    if (live.timeoutHandle) {
      clearTimeout(live.timeoutHandle);
      live.timeoutHandle = null;
    }
    if (live.child && live.child.exitCode === null && !live.child.killed) {
      // SIGTERM first, then a SIGKILL backstop. Killing the worker kills the
      // anvil it spawned: anvil is its child, and the worker's own `finally`
      // stops the fork. We never signal a process we did not create.
      live.child.kill("SIGTERM");
      const child = live.child;
      setTimeout(() => {
        if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
      }, 3000).unref();
    }

    live.record.state = state;
    live.record.endedAt = new Date().toISOString();
    live.record.error = error;
    // Two corrections once a job is over, both about not leaving a finished run
    // wearing an in-progress status:
    //
    //   running → the phase did not finish. Perpetual motion on a finished job
    //     is indistinguishable from work still happening.
    //   pending → the phase was never reached. On a finished run "pending" reads
    //     as "about to happen", which is exactly wrong: it will not. Seen on
    //     WETH9, where the exit action could not be identified and the three
    //     later fork phases correctly never ran.
    live.record.phases = live.record.phases.map((p) => {
      if (p.status === "running") {
        return { ...p, status: state === "completed" ? "completed" : ("failed" as const), detail: p.detail ?? `stopped: ${state}` };
      }
      if (p.status === "pending") {
        return {
          ...p,
          status: "skipped" as const,
          detail:
            state === "completed"
              ? "not reached — an earlier phase did not produce what this one needs; see its result above"
              : `not reached — the run ended as ${state}`,
        };
      }
      return p;
    });

    this.running.delete(jobId);
    const queueIndex = this.queue.indexOf(jobId);
    if (queueIndex !== -1) this.queue.splice(queueIndex, 1);

    await this.store.saveJob(live.record);
    if (error) this.emit(jobId, { type: "job.error", message: error.message, hint: error.hint });
    this.emit(jobId, { type: "job.state", state, queuePosition: null, message: error?.message ?? null });

    // Retention runs after a job ends rather than on a timer: it is the only
    // moment new data was added, and it keeps the volume bounded without a
    // background task that could race a live job.
    const retention = this.store
      .prune(RETENTION)
      .then(() => undefined)
      .catch((err) => {
        console.error(`[ripcord] retention pass failed: ${classify(err).message}`);
      })
      .finally(() => this.pendingWrites.delete(retention));
    this.pendingWrites.add(retention);

    this.pump();
  }

  async cancel(jobId: string, token: string): Promise<"cancelled" | "not_found" | "forbidden" | "already_finished"> {
    const live = this.jobs.get(jobId);
    const record = live?.record ?? (await this.store.loadJob(jobId));
    if (!record) return "not_found";
    if (!verifyToken(token, record.controlTokenHash)) return "forbidden";
    if (isTerminal(record.state)) return "already_finished";
    // Ask the worker to stop at the next phase boundary; `finish` kills it
    // regardless, so a worker deep inside a blocking call is still terminated.
    live?.child?.send({ type: "cancel" });
    await this.finish(jobId, "cancelled", { message: "The analysis was cancelled.", hint: null });
    return "cancelled";
  }

  // --- events ----------------------------------------------------------------

  private emit(jobId: string, payload: JobEventPayload): void {
    const live = this.jobs.get(jobId);
    if (!live) return;
    // The sequence number is minted HERE and nowhere else. The worker cannot do
    // it correctly — only the parent sees the whole stream, including the
    // queue-state events the worker never knows about.
    const seq = ++live.record.lastSeq;
    const event = { ...payload, seq, jobId, at: new Date().toISOString() } as JobEvent;
    live.events.push(event);
    if (live.events.length > EVENT_HISTORY_LIMIT) live.events.splice(0, live.events.length - EVENT_HISTORY_LIMIT);
    const write = this.store
      .appendEvents(jobId, [event])
      .catch((err) => {
        console.error(`[ripcord] could not persist event for ${jobId}: ${classify(err).message}`);
      })
      .finally(() => this.pendingWrites.delete(write));
    this.pendingWrites.add(write);
    this.bus.emit(`job:${jobId}`, event);
  }

  /**
   * Events after `afterSeq`, plus whether the cursor was still within the
   * retained history.
   *
   * `truncated: true` tells the caller its cursor is too old, so it must take a
   * fresh snapshot rather than assume the returned events are the whole story.
   * Returning a partial list silently is what turns a reconnect into a
   * plausible-looking but wrong timeline.
   */
  eventsSince(jobId: string, afterSeq: number): { events: JobEvent[]; truncated: boolean } {
    const live = this.jobs.get(jobId);
    if (!live) return { events: [], truncated: true };
    const oldest = live.events[0]?.seq ?? 0;
    const truncated = afterSeq > 0 && oldest > afterSeq + 1;
    return { events: live.events.filter((e) => e.seq > afterSeq), truncated };
  }

  subscribe(jobId: string, listener: (event: JobEvent) => void): () => void {
    const channel = `job:${jobId}`;
    this.bus.on(channel, listener);
    return () => this.bus.off(channel, listener);
  }

  // --- reads -----------------------------------------------------------------

  async getRecord(jobId: string): Promise<JobRecord | null> {
    return this.jobs.get(jobId)?.record ?? (await this.store.loadJob(jobId));
  }

  toSummary(record: JobRecord): JobSummary {
    return {
      jobId: record.jobId,
      state: record.state,
      mode: record.mode,
      address: record.address,
      chainId: record.chainId,
      block: record.block,
      blockHash: record.blockHash,
      blockSource: record.blockSource,
      queuePosition: this.queuePosition(record.jobId),
      createdAt: record.createdAt,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      phases: record.phases,
      structure: record.structure,
      reportId: record.reportId,
      disclosure: record.disclosure,
      error: record.error,
      lastSeq: record.lastSeq,
    };
  }

  stats(): { active: number; queued: number } {
    return { active: this.running.size, queued: this.queue.length };
  }
}

/** Phases for a mode, all `pending`. A phase absent from the mode is never listed, so the timeline shows only work that will actually run. */
function initialPhases(mode: RunMode): PhaseSnapshot[] {
  return phasesForMode(mode).map((p) => ({ id: p.id, status: "pending" as const, startedAtMs: null, endedAtMs: null, detail: null }));
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time comparison — a token check that leaks timing is a token check with a shape an attacker can walk. */
function verifyToken(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
