/**
 * THE JOB MANAGER — queue, worker lifecycle, event stream, cancellation.
 *
 * One object owns everything that can outlive an HTTP request, because the
 * alternative is an orphaned anvil process and a queue that never drains.
 *
 *  - A JOB OUTLIVES ITS REQUEST. Closing the tab does not cancel it, and a
 *    disconnected SSE consumer cannot change the outcome: events accumulate in
 *    a bounded history a reconnecting client resumes from.
 *  - EVERY EVENT HAS A MONOTONIC PER-JOB SEQUENCE, which is what makes reconnect
 *    correct rather than best-effort. A cursor that has fallen off the back of
 *    the history gets a fresh snapshot, not a silent gap — a gap renders as
 *    "nothing happened", precisely the wrong thing to show.
 *  - CANCELLATION IS AUTHORISED BY A SECRET, NOT BY THE JOB ID, because ids
 *    travel in shareable URLs. The control token is returned once, to the
 *    submitter, and only its hash is stored.
 *  - EVERY EXIT PATH KILLS THE WORKER. Success, failure, timeout, cancellation
 *    and SIGTERM all route through `finish`. The worker owns a process group;
 *    termination signals the group and checks exit before releasing the slot.
 *  - REPEATED SUBMITS DO NOT STACK. Same idempotency key and parameters returns
 *    the existing job; a deliberate re-run omits the key — the distinction is
 *    the user's to make, not something inferred from timing.
 */
import { fork, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ServerConfig } from "../config.js";
import { classify, publicValue, rpcSecrets, redact } from "../sanitize.js";
import type { CreateJobRequest, JobEvent, JobEventPayload, JobState, JobSummary, PhaseId, PhaseSnapshot, PhaseStatus, RunMode } from "../shared/dto.js";
import { isTerminal, phasesForMode } from "../shared/dto.js";
import { JobStore, type JobRecord, type StoredReportMeta } from "./store.js";
import { isWorkerMessage, type StartMessage, type WorkerMessage } from "./protocol.js";
import type { Report } from "../../src/report/schema.js";

/** How many events per job stay in memory for reconnect replay. Beyond this a client is given a fresh snapshot. */
const EVENT_HISTORY_LIMIT = 2000;

/** Retention bounds. Reports outlive jobs because a shared report URL should keep working. */
const RETENTION = { maxJobs: 200, maxReports: 500 };

export interface CreateJobOutcome {
  record: JobRecord;
  controlToken: string;
  deduplicated: boolean;
}

export interface StoredReportHookInput {
  reportId: string;
  report: Report;
  meta: StoredReportMeta;
}

export class IdempotencyConflictError extends Error {}
export class SubmissionRateError extends Error {}

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
  writes: Promise<void>;
  messages: Promise<void>;
  finishing?: Promise<void>;
  starting?: Promise<void>;
}

export class JobManager {
  private readonly jobs = new Map<string, LiveJob>();
  private readonly queue: string[] = [];
  private readonly running = new Set<string>();
  private readonly bus = new EventEmitter();
  /** True once shutdown has begun; `pump` checks it so no new work is scheduled during teardown. */
  private shuttingDown = false;
  private admissions = 0;
  private submissionTimes: number[] = [];
  private retentionTail: Promise<unknown> = Promise.resolve();
  private admissionTail: Promise<unknown> = Promise.resolve();
  private creationTail: Promise<unknown> = Promise.resolve();
  private readonly submitting = new Map<string, { fingerprint: string; promise: Promise<CreateJobOutcome> }>();

  /** Bound expensive RPC validation too, not just already-created workers. */
  async admit(raw: unknown, create: () => Promise<CreateJobOutcome>): Promise<CreateJobOutcome> {
    const req = raw as CreateJobRequest | null;
    const key = typeof req?.idempotencyKey === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(req.idempotencyKey) ? req.idempotencyKey : null;
    const fingerprint = JSON.stringify([
      req?.address?.toLowerCase?.(),
      Number(req?.chainId),
      canonicalBlock(req?.block),
      req?.mode,
      req?.refreshAssetContext === true,
    ]);
    if (key) {
      const pending = this.submitting.get(key);
      if (pending) {
        if (pending.fingerprint !== fingerprint) throw new IdempotencyConflictError("Idempotency key already used for different parameters");
        const outcome = await pending.promise;
        return { ...outcome, controlToken: this.retryToken(req!, outcome.record), deduplicated: true };
      }
    }
    if (this.shuttingDown || this.admissions >= this.config.maxActiveJobs + this.config.maxQueuedJobs) {
      throw new QueueFullError(this.queue.length, this.config.maxQueuedJobs);
    }
    this.admissions++;
    const promise = this.admissionTail.then(async () => {
      if (this.shuttingDown) throw new Error("Service is shutting down");
      if (key && req && typeof req.address === "string") {
        const existing = await this.findByIdempotencyKey(key, req);
        if (existing) return { record: existing, controlToken: this.retryToken(req, existing), deduplicated: true };
      }
      this.checkCapacity();
      const now = Date.now();
      this.submissionTimes = this.submissionTimes.filter(time => now - time < 60_000);
      if (this.submissionTimes.length >= 12) throw new SubmissionRateError("Too many new analysis requests; retry in a minute");
      this.submissionTimes.push(now);
      return create();
    });
    this.admissionTail = promise.catch(() => undefined);
    if (key) this.submitting.set(key, { fingerprint, promise });
    try { return await promise; }
    finally { this.admissions--; if (key) this.submitting.delete(key); }
  }

  private retryToken(req: CreateJobRequest, record: JobRecord): string {
    return req.controlToken && verifyToken(req.controlToken, record.controlTokenHash) ? req.controlToken : "";
  }

  private checkCapacity(): void {
    if (this.shuttingDown || this.queue.length + this.running.size >= this.config.maxQueuedJobs + this.config.maxActiveJobs) {
      throw new QueueFullError(this.queue.length, this.config.maxQueuedJobs);
    }
  }

  /** Serialize snapshots before entering even a delayed/custom store. */
  private persist(live: LiveJob): Promise<void> {
    const snapshot = structuredClone(live.record);
    const write = live.writes.then(() => this.store.saveJob(snapshot));
    live.writes = write.catch(() => undefined);
    return write;
  }

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
    /** Optional hook that durably schedules post-report sidecar work. */
    private readonly onReportStored: ((input: StoredReportHookInput) => Promise<void>) | null = null,
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
    await this.admissionTail;
    await this.creationTail;
    await Promise.all([...this.jobs.keys()].map((id) => this.finish(id, "interrupted", { message: "The service is shutting down.", hint: "Start a new run once it is back." })));
    await Promise.all([...this.jobs.values()].map(async live => { await live.starting; await live.messages; await live.writes; }));
    // Let the event log finish landing before the process goes away.
    await Promise.allSettled([...this.pendingWrites]);
    if (this.running.size) throw new Error("Some worker groups could not be stopped; shutdown is incomplete");
  }

  // --- creation --------------------------------------------------------------

  createJob(req: CreateJobRequest, resolvedBlock: bigint, blockSource: "explicit" | "resolved_latest", blockHash: string | null = null): Promise<CreateJobOutcome> {
    const result = this.creationTail.then(() => this.createSerialized(req, resolvedBlock, blockSource, blockHash));
    this.creationTail = result.catch(() => undefined);
    return result;
  }

  private async createSerialized(req: CreateJobRequest, resolvedBlock: bigint, blockSource: "explicit" | "resolved_latest", blockHash: string | null): Promise<CreateJobOutcome> {
    if (req.idempotencyKey) {
      // Same key AND same parameters returns the existing job. Comparing the
      // parameters too matters: a client reusing a key for a different address
      // must not silently receive results for the previous one.
      const existing = await this.findByIdempotencyKey(req.idempotencyKey, req);
      if (existing) return { record: existing, controlToken: this.retryToken(req, existing), deduplicated: true };
    }

    this.checkCapacity();

    const jobId = this.store.newJobId();
    // 32 bytes of CSPRNG. This is the only thing standing between a shared job
    // URL and a stranger cancelling the run behind it.
    const controlToken = req.controlToken && /^[A-Za-z0-9_-]{32,128}$/.test(req.controlToken) ? req.controlToken : randomBytes(32).toString("base64url");

    const record: JobRecord = {
      jobId,
      controlTokenHash: hashToken(controlToken),
      state: "queued",
      mode: req.mode,
      refreshAssetContext: req.refreshAssetContext === true,
      address: req.address,
      chainId: req.chainId,
      block: resolvedBlock.toString(),
      blockHash,
      blockSource,
      createdAt: new Date().toISOString(),
      startedAt: null,
      endedAt: null,
      phases: initialPhases(req.mode),
      structure: null,
      fork: { baseline: null, mutation: null, reexit: null },
      reportId: null,
      disclosure: null,
      error: null,
      lastSeq: 0,
      idempotencyKey: req.idempotencyKey ?? null,
    };

    this.jobs.set(jobId, { record, events: [], child: null, timeoutHandle: null, terminalMessageSeen: false, writes: Promise.resolve(), messages: Promise.resolve() });
    try { await this.persist(this.jobs.get(record.jobId)!); }
    catch (err) { this.jobs.delete(jobId); throw err; }
    this.queue.push(jobId);
    this.emit(jobId, { type: "job.state", state: "queued", queuePosition: this.queuePosition(jobId), message: null });
    await this.persist(this.jobs.get(jobId)!);
    this.pump();
    return { record, controlToken, deduplicated: false };
  }

  private async findByIdempotencyKey(key: string, req: CreateJobRequest): Promise<JobRecord | null> {
    for (const r of [...[...this.jobs.values()].map(live => live.record), ...await this.store.listJobs()]) {
      if (r.idempotencyKey !== key) continue;
      const sameBlock = req.block === "latest" ? r.blockSource === "resolved_latest" : r.block === canonicalBlock(req.block);
      if (
        r.address.toLowerCase() !== req.address.toLowerCase() ||
        r.chainId !== Number(req.chainId) ||
        r.mode !== req.mode ||
        (r.refreshAssetContext === true) !== (req.refreshAssetContext === true) ||
        !sameBlock
      ) {
        throw new IdempotencyConflictError("Idempotency key already used for different parameters");
      }
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
      live.starting = this.start(live).catch(() => this.finish(jobId, "failed", { message: "Could not start the analysis process or persist its state.", hint: "Check server storage and worker configuration." })).catch(err => console.error(classify(err).message));
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
    await this.persist(this.jobs.get(record.jobId)!);
    if (this.shuttingDown || isTerminal(record.state)) return;
    this.emit(record.jobId, { type: "job.state", state: "running", queuePosition: null, message: null });

    const artifactDir = await this.store.ensureArtifactDir(record.jobId);
    if (this.shuttingDown || isTerminal(record.state)) return;

    // `fork` rather than `spawn`: it gives a structured IPC channel, so the
    // parent never parses text, and it inherits no shell. User input reaches
    // the child only as fields of the typed start message below.
    const child = fork(this.workerPath, [], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      detached: process.platform !== "win32",
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

    let logLine = "";
    child.stderr?.on("data", (d: Buffer) => {
      logLine += d.toString();
      const lines = logLine.split("\n"); logLine = lines.pop() ?? "";
      for (const line of lines) process.stderr.write(`[job ${record.jobId}] ${redact(publicValue(line, rpcSecrets(this.config.rpcUrls.values())))}\n`);
      // Never print a partial credential if a pathological line exceeds the cap.
      if (logLine.length > 8192) logLine = "[worker log line omitted: length limit]";
    });
    child.stderr?.on("end", () => {
      if (logLine) process.stderr.write(`[job ${record.jobId}] ${redact(publicValue(logLine, rpcSecrets(this.config.rpcUrls.values())))}\n`);
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
      live.messages = live.messages.then(() => this.onWorkerMessage(record.jobId, raw)).catch((err: unknown) => {
        const api = classify(err, record.jobId);
        console.error(`[ripcord] job ${record.jobId}: failed to handle a worker message: ${api.message}`);
        return this.finish(record.jobId, "failed", {
          message: "The analysis finished but its result could not be stored.",
          hint: "This is a server-side storage failure, not a property of the contract.",
        });
      });
    });

    child.on("error", () => { void this.finish(record.jobId, "failed", { message: "The analysis process could not be started.", hint: null }).catch(err => console.error(classify(err).message)); });

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
        return this.finish(record.jobId, "failed", {
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
      blockHash: record.blockHash,
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
    if (!live || isTerminal(live.record.state)) return;
    msg = publicValue(msg, rpcSecrets(this.config.rpcUrls.values()));

    if (msg.type === "event") {
      this.emit(jobId, msg.payload);
      this.applyToRecord(live, msg.payload);
      await this.persist(live);
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
      verdictStatus: msg.publishable ? msg.verdictStatus : null,
      publishable: msg.publishable,
      hasExitRestriction: msg.hasExitRestriction,
      mode: live.record.mode,
      refreshAssetContext: live.record.refreshAssetContext,
    };
    // Stored regardless of publishability — a blocked report is still evidence
    // and its author may need it. What changes is who may READ it, and that is
    // enforced once, in the report route.
    const parsedReport = JSON.parse(msg.report) as Report;
    await this.store.saveReport(reportId, parsedReport, meta);

    // Starts after the immutable report has landed and only on explicit user
    // opt-in. The hook is not awaited on the publication path. Its contract is
    // to return after scheduling durable work, not after third-party I/O.
    if (msg.publishable && live.record.refreshAssetContext && this.onReportStored) {
      const enrichment = Promise.resolve()
        .then(() => this.onReportStored?.({ reportId, report: parsedReport, meta }))
        .catch((err: unknown) => {
          console.error(`[ripcord] asset context for ${reportId} failed: ${classify(err).message}`);
        })
        .finally(() => this.pendingWrites.delete(enrichment));
      this.pendingWrites.add(enrichment);
    }

    if (isTerminal(live.record.state)) return;
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
      verdictStatus: msg.publishable ? msg.verdictStatus : null,
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
      case "runtime.stats": live.record.runtimeStats = payload.stats; break;
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
      case "fork.baseline.completed":
      case "fork.mutation.completed":
      case "fork.reexit.completed": {
        live.record.fork ??= { baseline: null, mutation: null, reexit: null };
        const key = payload.type === "fork.baseline.completed" ? "baseline" : payload.type === "fork.mutation.completed" ? "mutation" : "reexit";
        live.record.fork[key] = { established: "established" in payload ? payload.established : null, detail: payload.detail, transactions: payload.transactions, evidence: payload.evidence ?? [] };
        break;
      }
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
  private finish(jobId: string, state: JobState, error: { message: string; hint: string | null } | null): Promise<void> {
    const live = this.jobs.get(jobId);
    if (!live) return Promise.resolve();
    if (live.finishing) return live.finishing;
    live.finishing = this.finishImpl(jobId, state, error).catch(async (err: unknown) => {
      live.record.error = { message: "The worker could not be stopped or its final state persisted.", hint: "This queue slot is retained. The service needs operator attention." };
      console.error(`[ripcord] job cleanup failed: ${classify(err).message}`);
      this.emit(jobId, { type: "job.error", ...live.record.error });
      try { await this.persist(live); } catch { console.error("[ripcord] final job state could not be persisted"); }
    });
    return live.finishing;
  }

  private async finishImpl(jobId: string, state: JobState, error: { message: string; hint: string | null } | null): Promise<void> {
    const live = this.jobs.get(jobId);
    if (!live || isTerminal(live.record.state)) return;

    if (live.timeoutHandle) {
      clearTimeout(live.timeoutHandle);
      live.timeoutHandle = null;
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
        return { ...p, status: state === "completed" ? "inconclusive" : ("failed" as const), detail: p.detail ?? `stopped: ${state}` };
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

    await stopWorkerGroup(live.child);
    this.running.delete(jobId);
    const queueIndex = this.queue.indexOf(jobId);
    if (queueIndex !== -1) this.queue.splice(queueIndex, 1);

    if (error) this.emit(jobId, { type: "job.error", message: error.message, hint: error.hint });
    this.emit(jobId, { type: "job.state", state, queuePosition: null, message: error?.message ?? null });
    await this.persist(live);

    // Retention runs after a job ends rather than on a timer: it is the only
    // moment new data was added, and it keeps the volume bounded without a
    // background task that could race a live job.
    const retention = this.retentionTail.then(async () => {
      await Promise.all([...this.jobs.values()].filter(j => isTerminal(j.record.state)).map(j => j.writes));
      await this.store.prune(RETENTION);
      // New submissions may start during awaits, so read active leases lazily.
      await this.store.pruneCache(() => new Set([...this.jobs.values()].filter(j => !isTerminal(j.record.state) || this.running.has(j.record.jobId)).map(j => j.record.blockHash).filter((h): h is string => !!h)));
    })
      .then(async () => {
        const retained = new Set((await this.store.listJobs()).map(r => r.jobId));
        for (const [id, job] of this.jobs) if (isTerminal(job.record.state) && !retained.has(id)) this.jobs.delete(id);
      })
      .catch((err) => {
        console.error(`[ripcord] retention pass failed: ${classify(err).message}`);
      })
      .finally(() => this.pendingWrites.delete(retention));
    this.retentionTail = retention;
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
    // finish signals the entire owned process group, including anvil.
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
    const event = publicValue({ ...payload, seq, jobId, at: new Date().toISOString() } as JobEvent, rpcSecrets(this.config.rpcUrls.values()));
    live.events.push(event);
    if (live.events.length > EVENT_HISTORY_LIMIT) live.events.splice(0, live.events.length - EVENT_HISTORY_LIMIT);
    const write = live.writes.then(() => this.store.appendEvents(jobId, [event]))
      .catch((err) => {
        console.error(`[ripcord] could not persist event for ${jobId}: ${classify(err).message}`);
      })
      .finally(() => this.pendingWrites.delete(write));
    live.writes = write;
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
    const truncated = oldest > afterSeq + 1 || afterSeq > live.record.lastSeq;
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
    return publicValue({
      jobId: record.jobId,
      state: record.state,
      mode: record.mode,
      refreshAssetContext: record.refreshAssetContext === true,
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
      fork: record.fork ?? { baseline: null, mutation: null, reexit: null },
      ...(record.runtimeStats ? { runtimeStats: record.runtimeStats } : {}),
      reportId: record.reportId,
      disclosure: record.disclosure,
      error: record.error,
      lastSeq: record.lastSeq,
    }, rpcSecrets(this.config.rpcUrls.values()));
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

/** Only the detached process group we created is signalled. `child.killed`
 * means a signal was sent, NOT that a process exited. Check liveness instead.
 */
async function stopWorkerGroup(child: ChildProcess | null): Promise<void> {
  if (!child?.pid) return;
  const group = process.platform !== "win32";
  const signal = async (sig: NodeJS.Signals | 0): Promise<boolean> => {
    // Darwin can return EPERM while the last member is exiting, before Node
    // receives its exit event; immediately after reap the same group is ESRCH.
    // Retry this short transition, but never equate permission failure with
    // successful cleanup. Persistent EPERM still quarantines the queue slot.
    const retryUntil = Date.now() + 500;
    for (;;) {
      try {
        if (group) process.kill(-child.pid!, sig);
        else if (child.exitCode === null && child.signalCode === null) child.kill(sig);
        else return false;
        return true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ESRCH") return false;
        if (code !== "EPERM" || Date.now() >= retryUntil) throw err;
        await new Promise(r => setTimeout(r, 25));
      }
    }
  };
  if (!await signal("SIGTERM")) return;
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && await signal(0)) await new Promise(r => setTimeout(r, 50));
  await signal("SIGKILL");
  const hardDeadline = Date.now() + 2000;
  while (!exited() && Date.now() < hardDeadline) await new Promise(r => setTimeout(r, 25));
  if (!exited()) throw new Error("Worker did not exit after SIGKILL; queue slot is retained");
}

function canonicalBlock(block: unknown): string {
  if (typeof block === "string" && /^\d+$/.test(block)) return BigInt(block).toString();
  return String(block);
}
