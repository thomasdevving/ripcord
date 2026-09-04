/**
 * File-backed job and report storage for a SINGLE replica.
 *
 * A database is not warranted here and would be the wrong kind of complexity:
 * one Railway service, one replica, a mounted volume at /data. What this layer
 * does owe the rest of the system is four properties that are easy to get wrong
 * with plain `writeFile`:
 *
 *  1. ATOMIC WRITES. Every record is written to a temp file in the same
 *     directory and then `rename`d over the target. A rename within a
 *     filesystem is atomic, so a reader (or a restart) never observes a
 *     half-written JSON document. Without this, a SIGTERM landing mid-write
 *     leaves a corrupt job record that fails to parse forever after.
 *
 *  2. SAFE ID → PATH RESOLUTION. An id from a URL never becomes a path. Ids are
 *     validated against a strict character class and the resolved path is
 *     checked to still be inside its directory, so `../../etc/passwd` and its
 *     encoded variants cannot escape. This matters more than usual here because
 *     the same process also holds committed calibration reports and an RPC cache.
 *
 *  3. INTERRUPTED ≠ COMPLETED. On boot, any job still marked `running` is moved
 *     to `interrupted`. It did not finish and it did not fail; nobody knows how
 *     far it got. Resuming it fictitiously, or marking it complete, would
 *     manufacture a result — the same false-clean this project refuses
 *     everywhere else, arrived at through a restart instead of a detector.
 *
 *  4. BOUNDED RETENTION. Old jobs and their artifact directories are pruned by
 *     count, so a demo left running does not fill the volume. Completed
 *     PUBLISHABLE reports are pruned last and separately, because their URLs are
 *     meant to keep working after the run that produced them is long gone.
 *
 *  5. ORDERED ASSET-CONTEXT WRITES. Atomic replacement protects readers from a
 *     partial document, but two valid concurrent replacements can still finish
 *     out of order. Sidecar writes are therefore serialised per report id so an
 *     older generation cannot land after its successor.
 */
import { mkdir, readFile, rename, writeFile, readdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import type { JobEvent, JobState, JobSummary, PhaseSnapshot, RunMode, StructuralSnapshot } from "../shared/dto.js";

/** Ids we generate and ids we accept from a URL share this shape. Anything else is rejected before touching the filesystem. */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isSafeId(id: string): boolean {
  return ID_PATTERN.test(id);
}

/**
 * Resolves `id` inside `dir`, or throws. Two independent checks: the id must
 * match the safe pattern, AND the resolved path must still be within `dir`.
 * Either alone would probably do; both together mean a future change to the
 * pattern cannot silently open a traversal.
 */
export function safeJoin(dir: string, id: string, suffix = ".json"): string {
  if (!isSafeId(id)) throw new Error(`unsafe identifier: ${JSON.stringify(id.slice(0, 40))}`);
  const target = resolve(dir, `${id}${suffix}`);
  const root = resolve(dir);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error("resolved path escapes its directory");
  }
  return target;
}

/** The record persisted per job. A superset of JobSummary — `controlTokenHash` and paths never leave the server. */
export interface JobRecord {
  jobId: string;
  /**
   * Hash of the control token, not the token itself. A stored plaintext token
   * would let anyone with read access to the volume cancel arbitrary jobs; the
   * hash is enough to verify a presented token and useless on its own.
   */
  controlTokenHash: string;
  state: JobState;
  mode: RunMode;
  /** Explicit opt-in; the worker never receives it. */
  refreshAssetContext: boolean;
  address: string;
  chainId: number;
  block: string;
  blockHash: string | null;
  blockSource: "explicit" | "resolved_latest";
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  phases: PhaseSnapshot[];
  structure: StructuralSnapshot | null;
  fork?: import("../shared/dto.js").ForkBlocks;
  runtimeStats?: import("../shared/dto.js").RuntimeStats;
  reportId: string | null;
  disclosure: { publishable: boolean; message: string } | null;
  error: { message: string; hint: string | null } | null;
  lastSeq: number;
  /** Set only when the submitter supplied one. Used for submit-level idempotency. */
  idempotencyKey: string | null;
}

export interface StoredReportMeta {
  id: string;
  jobId: string | null;
  address: string;
  chainId: number;
  block: string;
  generatedAt: string;
  schemaVersion: string;
  rulesetVersion: string;
  verdictStatus: string | null;
  publishable: boolean;
  hasExitRestriction: boolean;
  mode: RunMode | null;
  /** Whether a per-analysis Mobula refresh and candidate verification was requested. */
  refreshAssetContext?: boolean;
}

export class JobStore {
  readonly jobsDir: string;
  readonly reportsDir: string;
  readonly eventsDir: string;
  readonly artifactsDir: string;
  readonly cacheDir: string;
  /** Per-report Mobula refresh + pinned candidate verification. Never report content. */
  readonly assetContextsDir: string;
  /**
   * One write tail per report id.
   *
   * Atomic rename prevents half a JSON document, but it does not preserve the
   * order of two concurrent complete writes: an older, slower rename can still
   * land after a newer generation. Serialising per id makes invocation order
   * durable while allowing unrelated reports to write concurrently.
   */
  private readonly assetContextWriteTails = new Map<string, Promise<void>>();

  constructor(private readonly dataDir: string) {
    this.jobsDir = join(dataDir, "jobs");
    this.reportsDir = join(dataDir, "reports");
    this.eventsDir = join(dataDir, "events");
    this.artifactsDir = join(dataDir, "artifacts");
    this.assetContextsDir = join(dataDir, "asset-contexts");
    // The pinned RPC cache keeps its own subdirectory and its existing
    // (chainId, block, method, params) key semantics untouched. It lives under
    // the data dir so a mounted volume makes warm reruns fast across deploys,
    // but nothing about how it is keyed changes — a cache built by the CLI is a
    // valid hit for the server and vice versa.
    this.cacheDir = join(dataDir, "rpc-cache");
  }

  async init(): Promise<void> {
    for (const dir of [this.jobsDir, this.reportsDir, this.eventsDir, this.artifactsDir, this.cacheDir, this.assetContextsDir]) {
      await mkdir(dir, { recursive: true });
    }
    // Fail loudly at boot if the volume is not writable, rather than at the
    // first job — on Railway a volume mounted for a different container user is
    // a real and otherwise very confusing failure.
    const probe = join(this.dataDir, ".write-probe");
    await writeFile(probe, "ok", "utf8");
    await rm(probe, { force: true });
  }

  // --- atomic primitives -----------------------------------------------------

  private async writeAtomic(path: string, contents: string): Promise<void> {
    // Temp file in the SAME directory: rename is only atomic within a
    // filesystem, and /tmp is frequently a different one inside a container.
    const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tmp, contents, "utf8");
    await rename(tmp, path);
  }

  private async readJson<T>(path: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(path, "utf8")) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  // --- jobs ------------------------------------------------------------------

  newJobId(): string {
    return `job_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  }

  async saveJob(record: JobRecord): Promise<void> {
    await this.writeAtomic(safeJoin(this.jobsDir, record.jobId), JSON.stringify(record, null, 2));
  }

  async loadJob(jobId: string): Promise<JobRecord | null> {
    if (!isSafeId(jobId)) return null;
    return this.readJson<JobRecord>(safeJoin(this.jobsDir, jobId));
  }

  async listJobs(): Promise<JobRecord[]> {
    if (!existsSync(this.jobsDir)) return [];
    const files = (await readdir(this.jobsDir)).filter((f) => f.endsWith(".json"));
    const out: JobRecord[] = [];
    for (const file of files) {
      const record = await this.readJson<JobRecord>(join(this.jobsDir, file));
      // Corrupt metadata fails loudly; it is never silently treated as an empty job.
      if (record?.jobId) out.push(record);
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Moves every job still marked `running` or `queued` to `interrupted`.
   *
   * Called once at boot. A queued job is included deliberately: the in-memory
   * queue did not survive the restart either, so a job left `queued` on disk
   * would sit there forever showing a position that nothing will ever advance.
   */
  async recoverInterruptedJobs(): Promise<number> {
    const jobs = await this.listJobs();
    let recovered = 0;
    for (const job of jobs) {
      if (job.state !== "running" && job.state !== "queued") continue;
      job.state = "interrupted";
      job.endedAt = new Date().toISOString();
      job.error = {
        message: "The service restarted while this analysis was in progress, so it did not complete.",
        hint: "Start a new run. Nothing about the contract follows from an interrupted job.",
      };
      // Any phase caught mid-flight is marked failed rather than left
      // `running` forever, so the timeline of a recovered job is readable and
      // does not imply work is still happening.
      job.phases = job.phases.map(p => p.status === "running" ? { ...p, status: "failed" as const, detail: "interrupted by a service restart" } : p.status === "pending" ? { ...p, status: "skipped" as const, detail: "not reached before service restart" } : p);
      await this.saveJob(job);
      recovered++;
    }
    return recovered;
  }

  // --- events ----------------------------------------------------------------

  /**
   * Events are appended as JSON Lines. Append is the right shape here: an event
   * is immutable once emitted, and a crash mid-append costs at most the final
   * partial line, which the reader below drops.
   */
  async appendEvents(jobId: string, events: JobEvent[]): Promise<void> {
    if (events.length === 0) return;
    const path = safeJoin(this.eventsDir, jobId, ".jsonl");
    const { appendFile } = await import("node:fs/promises");
    await appendFile(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  }

  async readEvents(jobId: string): Promise<JobEvent[]> {
    if (!isSafeId(jobId)) return [];
    let raw: string;
    try {
      raw = await readFile(safeJoin(this.eventsDir, jobId, ".jsonl"), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const events: JobEvent[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        events.push(JSON.parse(line) as JobEvent);
      } catch {
        // A truncated final line from an interrupted append. Dropping it is
        // correct — it was never a complete event — and it is the only case
        // this catch covers, which is why it does not report.
      }
    }
    return events;
  }

  // --- reports ---------------------------------------------------------------

  newReportId(): string {
    return `rep_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  }

  /**
   * Persists a report and its metadata sidecar.
   *
   * The report is stored WHETHER OR NOT it is publishable: a blocked report is
   * still evidence and its author may need it. What changes is who may read it —
   * the route enforces `publishable` and never ships a blocked body. Storing
   * only publishable reports would instead destroy the record of a gate firing,
   * which is exactly the event worth keeping.
   */
  async saveReport(id: string, report: unknown, meta: StoredReportMeta): Promise<void> {
    await this.writeAtomic(safeJoin(this.reportsDir, id), JSON.stringify(report, null, 2));
    // The sidecar's suffix goes through `safeJoin`'s SUFFIX parameter, not into
    // the id. Folding it into the id (`${id}.meta`) fails validation, because
    // the id character class deliberately excludes dots — which is what makes
    // the traversal check meaningful. Caught by a real run: it threw on the
    // first report the server ever tried to persist.
    await this.writeAtomic(safeJoin(this.reportsDir, id, ".meta.json"), JSON.stringify(meta, null, 2));
  }

  async loadReport(id: string): Promise<unknown | null> {
    if (!isSafeId(id)) return null;
    return this.readJson<unknown>(safeJoin(this.reportsDir, id));
  }

  async loadReportMeta(id: string): Promise<StoredReportMeta | null> {
    if (!isSafeId(id)) return null;
    return this.readJson<StoredReportMeta>(safeJoin(this.reportsDir, id, ".meta.json"));
  }

  async listReportMeta(): Promise<StoredReportMeta[]> {
    if (!existsSync(this.reportsDir)) return [];
    const files = (await readdir(this.reportsDir)).filter((f) => f.endsWith(".meta.json"));
    const out: StoredReportMeta[] = [];
    for (const file of files) {
      const meta = await this.readJson<StoredReportMeta>(join(this.reportsDir, file));
      if (meta?.id) out.push(meta);
    }
    return out.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
  }

  // --- post-analysis asset context ------------------------------------------

  /**
   * Stored separately from the report on purpose. Deleting this file must leave
   * the pinned report byte-for-byte unchanged, including its verdict.
   */
  async saveAssetContext(reportId: string, context: unknown): Promise<void> {
    const previous = this.assetContextWriteTails.get(reportId) ?? Promise.resolve();
    const write = previous
      .catch(() => undefined)
      .then(() => this.writeAtomic(safeJoin(this.assetContextsDir, reportId), JSON.stringify(context, null, 2)));
    this.assetContextWriteTails.set(reportId, write);
    try {
      await write;
    } finally {
      if (this.assetContextWriteTails.get(reportId) === write) this.assetContextWriteTails.delete(reportId);
    }
  }

  async loadAssetContext(reportId: string): Promise<unknown | null> {
    if (!isSafeId(reportId)) return null;
    return this.readJson<unknown>(safeJoin(this.assetContextsDir, reportId));
  }

  /**
   * A post-analysis fetch cannot be resumed after a process restart. Convert a
   * stranded `pending` sidecar into an explicit unavailable result so browsers
   * do not poll forever or mistake silence for an empty inventory.
   */
  async recoverPendingAssetContexts(): Promise<number> {
    if (!existsSync(this.assetContextsDir)) return 0;
    let recovered = 0;
    for (const file of (await readdir(this.assetContextsDir)).filter((name) => name.endsWith(".json"))) {
      const path = join(this.assetContextsDir, file);
      const context = await this.readJson<Record<string, unknown>>(path);
      if (!context) continue;
      const forkScenarios = context.forkScenarios as Record<string, unknown> | undefined;
      if (context.status !== "pending" && forkScenarios?.status !== "pending") continue;
      const notes = Array.isArray(context.notes)
        ? context.notes.filter((note): note is string => typeof note === "string")
        : [];
      const balanceWasPending = context.status === "pending";
      await this.writeAtomic(path, JSON.stringify({
        ...context,
        ...(balanceWasPending ? { completedAt: new Date().toISOString(), status: "unavailable" } : {}),
        ...(forkScenarios?.status === "pending"
          ? { forkScenarios: { ...forkScenarios, status: "unavailable", note: "The service restarted before the candidate fork batch completed; no fork conclusion was recovered." } }
          : {}),
        notes: [
          ...notes,
          balanceWasPending
            ? "The service restarted before post-analysis asset verification completed; no candidate claim was recovered."
            : "The service restarted during candidate fork execution; completed balance evidence remains available, but no fork conclusion was recovered.",
        ],
      }, null, 2));
      recovered++;
    }
    return recovered;
  }

  // --- artifacts -------------------------------------------------------------

  /** Each job gets its own artifact directory, so cleanup is a single recursive remove that cannot touch another job. */
  artifactDirFor(jobId: string): string {
    return safeJoin(this.artifactsDir, jobId, "");
  }

  async ensureArtifactDir(jobId: string): Promise<string> {
    const dir = this.artifactDirFor(jobId);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  // --- retention -------------------------------------------------------------

  /**
   * Prunes oldest-first by count.
   *
   * Publishable reports are kept to a much higher bound than jobs, because a
   * shared report URL is expected to keep working after the job that produced it
   * has aged out. Jobs, their events and their artifacts age together.
   */
  async prune(opts: { maxJobs: number; maxReports: number }): Promise<{ jobs: number; reports: number }> {
    // Nothing to prune if the data directory has gone. That happens for real —
    // a volume detached under a running container, or a test tearing down its
    // temp dir while a fire-and-forget retention pass is still in flight — and
    // it is not worth an error line either time.
    if (!existsSync(this.jobsDir) || !existsSync(this.reportsDir)) return { jobs: 0, reports: 0 };
    const jobs = await this.listJobs();
    let prunedJobs = 0;
    for (const job of jobs.slice(opts.maxJobs)) {
      // Never prune a job that is still live — the queue holds a reference to it.
      if (job.state === "running" || job.state === "queued") continue;
      await rm(safeJoin(this.jobsDir, job.jobId), { force: true });
      await rm(safeJoin(this.eventsDir, job.jobId, ".jsonl"), { force: true });
      await rm(this.artifactDirFor(job.jobId), { recursive: true, force: true });
      prunedJobs++;
    }

    const reports = await this.listReportMeta();
    let prunedReports = 0;
    for (const meta of reports.slice(opts.maxReports)) {
      await rm(safeJoin(this.reportsDir, meta.id), { force: true });
      await rm(safeJoin(this.reportsDir, meta.id, ".meta.json"), { force: true });
      await rm(safeJoin(this.assetContextsDir, meta.id), { force: true });
      prunedReports++;
    }
    return { jobs: prunedJobs, reports: prunedReports };
  }

  /** Hash-isolated web cache buckets; never prune an active worker's namespace.
   * Bounds: 16 completed block identities, seven days, 512 MiB (soft while a
   * bucket is active or younger than one hour). CLI caches are separate.
   */
  async pruneCache(activeHashes: () => Set<string>): Promise<void> {
    const sizeOf = async (path: string): Promise<number> => {
      let size = 0;
      for (const e of await readdir(path, { withFileTypes: true })) {
        const child = join(path, e.name);
        if (e.isDirectory()) size += await sizeOf(child);
        else if (e.isFile()) size += (await stat(child)).size;
      }
      return size;
    };
    const buckets = [];
    for (const entry of await readdir(this.cacheDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^(?:0x[0-9a-f]{64}|[0-9]+)$/i.test(entry.name) || activeHashes().has(entry.name)) continue;
      const path = join(this.cacheDir, entry.name);
      const age = (await stat(path)).mtimeMs;
      buckets.push({ path, hash: entry.name, age, bytes: await sizeOf(path) });
    }
    buckets.sort((a, b) => b.age - a.age);
    let bytes = 0;
    for (const [index, bucket] of buckets.entries()) {
      bytes += bucket.bytes;
      if (index < 16 && bytes <= 512 * 1024 * 1024 && Date.now() - bucket.age < 7 * 86400_000) continue;
      if (activeHashes().has(bucket.hash) || Date.now() - bucket.age < 3600_000) continue;
      await rm(bucket.path, { recursive: true, force: true });
    }
  }

  async dataDirWritable(): Promise<boolean> {
    try {
      const s = await stat(this.dataDir);
      return s.isDirectory();
    } catch {
      return false;
    }
  }
}
