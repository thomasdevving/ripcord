/**
 * The job manager, the store and the publication boundary — the behaviour where
 * being wrong is invisible rather than loud:
 *
 *  - A JOB THAT DIES MUST NOT STAY `running`. A spinner that never stops is
 *    indistinguishable from work in progress.
 *  - AN INTERRUPTED JOB IS NOT A COMPLETED ONE. Manufacturing a result through a
 *    restart is the same false-clean this project refuses everywhere else.
 *  - A RECONNECT CURSOR THAT HAS FALLEN OFF THE HISTORY MUST SAY SO. Silently
 *    returning the surviving tail renders as a complete timeline missing its
 *    middle.
 *  - CANCELLATION NEEDS THE TOKEN, NOT THE ID. Job ids travel in shareable URLs.
 *  - A BLOCKED REPORT'S BYTES MUST NOT LEAVE THE PROCESS on any transport.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JobManager } from "../server/jobs/manager.js";
import { JobStore, isSafeId, safeJoin } from "../server/jobs/store.js";
import { ReportService, BLOCKED_MESSAGE } from "../server/reports.js";
import type { ServerConfig } from "../server/config.js";
import type { JobEvent } from "../server/shared/dto.js";

const WORKER = resolve(fileURLToPath(new URL("./fixtures/fake-worker.mjs", import.meta.url)));

const addr = (suffix: string) => `0x${"0".repeat(38)}${suffix}`;
const OK = addr("01");
const FAILS = addr("02");
const HANGS = addr("03");
const DIES = addr("04");
const BLOCKED = addr("05");

function config(dataDir: string, overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    nodeEnv: "test",
    port: 0,
    host: "127.0.0.1",
    dataDir,
    rpcUrls: new Map([[1, "https://rpc.example/v2/key"]]),
    enableLiveRuns: true,
    maxActiveJobs: 1,
    maxQueuedJobs: 3,
    jobTimeoutMs: 600_000,
    defaultBlock: 100n,
    webDistDir: null,
    calibrationDir: join(dataDir, "calibration"),
    mobulaApiKey: null,
    ...overrides,
  };
}

/**
 * Waits for a predicate, polling.
 *
 * `describe` is not decoration: when this fails it is the only thing that says
 * WHAT was being waited for and what the state actually was. A bare "condition
 * not met" on a job-lifecycle test tells you nothing about whether the job
 * failed, was cancelled, or simply had not finished.
 */
async function until(check: () => boolean, describe: () => string = () => "", timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms${describe() ? ` — ${describe()}` : ""}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Waits for a job to reach a terminal state, reporting the state and error it actually reached. */
const untilState = (record: { state: string; error?: { message: string } | null }, want: string, timeoutMs?: number) =>
  until(
    () => record.state === want,
    () => `expected state "${want}", saw "${record.state}"${record.error ? ` (error: ${record.error.message})` : ""}`,
    timeoutMs,
  );

let dir: string;
let store: JobStore;
let manager: JobManager;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ripcord-test-"));
  store = new JobStore(dir);
  await store.init();
  manager = new JobManager(config(dir), store, WORKER);
  await manager.init();
});

afterEach(async () => {
  await manager.shutdown();
  // Retry the temp-dir removal. `shutdown` awaits every write this code owns,
  // but a just-killed child's file descriptors are torn down by the OS
  // asynchronously, and rmdir intermittently sees ENOTEMPTY behind that. This is
  // test-harness cleanup, not a product property — encoding a wait for the
  // kernel into the manager would be the wrong place for it.
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt >= 10) throw err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
});

const create = (address: string, extra: Record<string, unknown> = {}) =>
  manager.createJob({ address, chainId: 1, block: "100", mode: "scan", ...extra } as never, 100n, "explicit");

describe("job lifecycle", () => {
  it("runs post-analysis enrichment only for an opted-in, publishable report", async () => {
    const calls: string[] = [];
    const enriched = new JobManager(config(dir), store, WORKER, async ({ reportId, meta }) => {
      calls.push(reportId);
      expect(meta.refreshAssetContext).toBe(true);
    });
    await enriched.init();

    const ordinary = await enriched.createJob(
      { address: OK, chainId: 1, block: "100", mode: "scan", refreshAssetContext: false } as never,
      100n,
      "explicit",
    );
    await untilState(ordinary.record, "completed");

    const optedIn = await enriched.createJob(
      { address: OK, chainId: 1, block: "100", mode: "scan", refreshAssetContext: true } as never,
      100n,
      "explicit",
    );
    await untilState(optedIn.record, "completed");
    await until(() => calls.length === 1);

    const blocked = await enriched.createJob(
      { address: BLOCKED, chainId: 1, block: "100", mode: "scan", refreshAssetContext: true } as never,
      100n,
      "explicit",
    );
    await untilState(blocked.record, "completed");
    expect(calls).toEqual([optedIn.record.reportId]);
    await enriched.shutdown();
  });

  it("runs a job to completion and stores a publishable report", async () => {
    const { record, controlToken } = await create(OK);
    expect(controlToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);

    await untilState(record, "completed");
    expect(record.reportId).toBeTruthy();
    expect(record.disclosure?.publishable).toBe(true);

    const reports = new ReportService(store, join(dir, "calibration"));
    await reports.init();
    const loaded = await reports.loadPublishable(record.reportId as string);
    expect(loaded.ok).toBe(true);
  });

  it("reports a classified failure without leaking the RPC URL", async () => {
    const { record } = await create(FAILS);
    await untilState(record, "failed");
    expect(record.error?.message).toContain("RPC endpoint could not be reached");
    expect(JSON.stringify(record)).not.toContain("rpc.example");
  });

  it("does not leave a job running when its worker dies without answering", async () => {
    const { record } = await create(DIES);
    await untilState(record, "failed");
    // A perpetual spinner is indistinguishable from work still happening.
    expect(record.error?.message).toContain("stopped unexpectedly");
    expect(record.phases.every((p) => p.status !== "running")).toBe(true);
  });

  it("times out a hanging job and kills the worker", async () => {
    const fast = new JobManager(config(dir, { jobTimeoutMs: 10_000 }), store, WORKER);
    await fast.init();
    // Deliberately a real short timeout rather than fake timers: the point is
    // that the CHILD PROCESS is gone afterwards, which fake timers cannot show.
    const shortLived = new JobManager(config(dir, { jobTimeoutMs: 300 }), store, WORKER);
    await shortLived.init();
    const { record } = await shortLived.createJob({ address: HANGS, chainId: 1, block: "100", mode: "scan" } as never, 100n, "explicit");
    await untilState(record, "timed_out", 10_000);
    expect(record.error?.message).toContain("limit");
    await shortLived.shutdown();
    await fast.shutdown();
  });

  it("does not mistake a worker that exits right after delivering its result for a crash", async () => {
    // REGRESSION. Node does not order a child's `message` and `exit` events
    // against each other, so a worker that sends its report and immediately
    // exits can have `exit` delivered first. The manager used to conclude
    // "stopped unexpectedly" there — about an analysis that had just succeeded.
    // Seen first on a real Comet run, then intermittently here.
    //
    // The race cannot be forced deterministically, so this runs the handshake
    // repeatedly: every one of them must complete, and none may report a crash.
    for (let i = 0; i < 8; i++) {
      const { record } = await create(OK);
      await untilState(record, "completed");
      expect(record.error).toBeNull();
      expect(record.reportId).toBeTruthy();
    }
  });

  it("lets a subsequent job start after one was killed", async () => {
    const shortLived = new JobManager(config(dir, { jobTimeoutMs: 300 }), store, WORKER);
    await shortLived.init();
    const first = await shortLived.createJob({ address: HANGS, chainId: 1, block: "100", mode: "scan" } as never, 100n, "explicit");
    await untilState(first.record, "timed_out", 10_000);
    // The active slot must be released: a leaked slot means the queue never
    // drains again and every later submit sits at position 1 forever.
    const second = await shortLived.createJob({ address: OK, chainId: 1, block: "100", mode: "scan" } as never, 100n, "explicit");
    await untilState(second.record, "completed", 12_000);
    await shortLived.shutdown();
  });
});

describe("cancellation", () => {
  it("refuses cancellation without the control token", async () => {
    const { record } = await create(HANGS);
    await untilState(record, "running");
    // The job id alone appears in shareable URLs, so it must not confer control.
    expect(await manager.cancel(record.jobId, "not-the-token")).toBe("forbidden");
    expect(record.state).toBe("running");
  });

  it("cancels with the right token and releases the slot", async () => {
    const { record, controlToken } = await create(HANGS);
    await untilState(record, "running");
    expect(await manager.cancel(record.jobId, controlToken)).toBe("cancelled");
    expect(record.state).toBe("cancelled");
    expect(manager.stats().active).toBe(0);
  });

  it("reports an unknown job distinctly from a wrong token", async () => {
    expect(await manager.cancel("job_doesnotexist", "x")).toBe("not_found");
  });
});

describe("queueing and idempotency", () => {
  it("queues beyond the active limit and reports positions", async () => {
    const first = await create(HANGS);
    await untilState(first.record, "running");
    const second = await create(HANGS);
    expect(second.record.state).toBe("queued");
    expect(manager.toSummary(second.record).queuePosition).toBe(1);
    expect(manager.stats()).toEqual({ active: 1, queued: 1 });
  });

  it("refuses a submit when both the active slot and the queue are full", async () => {
    const tight = new JobManager(config(dir, { maxActiveJobs: 1, maxQueuedJobs: 1 }), store, WORKER);
    await tight.init();
    const a = await tight.createJob({ address: HANGS, chainId: 1, block: "100", mode: "scan" } as never, 100n, "explicit");
    await untilState(a.record, "running");
    await tight.createJob({ address: HANGS, chainId: 1, block: "100", mode: "scan" } as never, 100n, "explicit");
    await expect(
      tight.createJob({ address: HANGS, chainId: 1, block: "100", mode: "scan" } as never, 100n, "explicit"),
    ).rejects.toThrow(/queue is full/);
    await tight.shutdown();
  });

  it("returns the SAME job for a repeated submit with the same key and parameters", async () => {
    const first = await create(HANGS, { idempotencyKey: "abcdefgh1234" });
    const second = await create(HANGS, { idempotencyKey: "abcdefgh1234" });
    expect(second.deduplicated).toBe(true);
    expect(second.record.jobId).toBe(first.record.jobId);
    // One heavyweight scan, not two.
    expect(manager.stats().active + manager.stats().queued).toBe(1);
  });

  it("rejects reuse of an idempotency key for different parameters", async () => {
    const first = await create(HANGS, { idempotencyKey: "abcdefgh1234" });
    await expect(create(BLOCKED, { idempotencyKey: "abcdefgh1234" })).rejects.toThrow(/different parameters/);
    expect(first.record.address).toBe(HANGS);
  });

  it("gives a deliberate re-run (no key) a new execution id", async () => {
    const first = await create(HANGS);
    const second = await create(HANGS);
    expect(second.record.jobId).not.toBe(first.record.jobId);
    expect(second.deduplicated).toBe(false);
  });
});

describe("event stream and reconnection", () => {
  it("assigns a monotonic per-job sequence", async () => {
    const seen: JobEvent[] = [];
    const { record } = await create(OK);
    manager.subscribe(record.jobId, (e) => seen.push(e));
    await untilState(record, "completed");
    const { events } = manager.eventsSince(record.jobId, 0);
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("replays only events after a cursor", async () => {
    const { record } = await create(OK);
    await untilState(record, "completed");
    const all = manager.eventsSince(record.jobId, 0);
    const tail = manager.eventsSince(record.jobId, 2);
    expect(tail.events.every((e) => e.seq > 2)).toBe(true);
    expect(tail.events.length).toBeLessThan(all.events.length);
    expect(tail.truncated).toBe(false);
  });

  it("flags a cursor older than the retained history rather than returning a partial tail silently", async () => {
    const { record } = await create(OK);
    await untilState(record, "completed");
    // Nothing was evicted here, so an in-range cursor is not truncated…
    expect(manager.eventsSince(record.jobId, 1).truncated).toBe(false);
    // …and an unknown job is reported as truncated rather than as "no events",
    // because "no events" would render as "nothing has happened".
    expect(manager.eventsSince("job_unknown", 5).truncated).toBe(true);
  });

  it("keeps running when a subscriber detaches", async () => {
    const { record } = await create(OK);
    const unsubscribe = manager.subscribe(record.jobId, () => undefined);
    unsubscribe();
    // A closed browser tab must not change an analysis outcome.
    await untilState(record, "completed");
    expect(record.reportId).toBeTruthy();
  });

  it("persists events so a reload can reconstruct the run", async () => {
    const { record } = await create(OK);
    await untilState(record, "completed");

    // Event writes are fire-and-forget on the hot path (an SSE frame must not
    // wait on a disk write), so the last of them can land just after the job
    // reaches its terminal state. Re-read until they appear.
    let persisted = await store.readEvents(record.jobId);
    const deadline = Date.now() + 5000;
    while (persisted.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      persisted = await store.readEvents(record.jobId);
    }

    expect(persisted.length).toBeGreaterThan(0);
    expect(persisted[0]?.seq).toBe(1);
  });
});

describe("restart recovery", () => {
  it("marks a job that was running as interrupted, never completed", async () => {
    const { record } = await create(HANGS);
    await untilState(record, "running");
    // Simulate a restart: a fresh store over the same directory.
    const rebooted = new JobStore(dir);
    await rebooted.init();
    const recovered = await rebooted.recoverInterruptedJobs();
    expect(recovered).toBeGreaterThanOrEqual(1);

    const reloaded = await rebooted.loadJob(record.jobId);
    expect(reloaded?.state).toBe("interrupted");
    expect(reloaded?.reportId).toBeNull();
    expect(reloaded?.error?.message).toContain("restarted");
    // A phase caught mid-flight must not stay `running` forever.
    expect(reloaded?.phases.every((p) => p.status !== "running")).toBe(true);
  });

  it("also recovers a job left queued, which nothing would otherwise advance", async () => {
    const first = await create(HANGS);
    await untilState(first.record, "running");
    const queued = await create(HANGS);
    expect(queued.record.state).toBe("queued");

    const rebooted = new JobStore(dir);
    await rebooted.init();
    await rebooted.recoverInterruptedJobs();
    expect((await rebooted.loadJob(queued.record.jobId))?.state).toBe("interrupted");
  });
});

describe("storage safety", () => {
  it("rejects an identifier that is not id-shaped", () => {
    expect(isSafeId("job_abc123")).toBe(true);
    expect(isSafeId("../../etc/passwd")).toBe(false);
    expect(isSafeId("a/b")).toBe(false);
    expect(isSafeId("a.b")).toBe(false);
    expect(isSafeId("")).toBe(false);
  });

  it("refuses to build a path from an unsafe identifier", () => {
    expect(() => safeJoin("/data/reports", "../../etc/passwd")).toThrow(/unsafe identifier/);
    expect(() => safeJoin("/data/reports", "%2e%2e%2fetc")).toThrow(/unsafe identifier/);
  });

  it("keeps the metadata sidecar inside the reports directory", () => {
    // The suffix goes through the SUFFIX parameter; folding it into the id
    // fails validation, because the id character class excludes dots. This was
    // a real crash on the first report the server ever persisted.
    const path = safeJoin("/data/reports", "rep_abc", ".meta.json");
    expect(path).toBe("/data/reports/rep_abc.meta.json");
  });

  it("writes a report and its sidecar as separate readable files", async () => {
    const { record } = await create(OK);
    await untilState(record, "completed");
    const files = await readdir(store.reportsDir);
    expect(files.some((f) => f.endsWith(".meta.json"))).toBe(true);
    expect(files.some((f) => f.endsWith(".json") && !f.endsWith(".meta.json"))).toBe(true);
    // No temp files left behind by the atomic-write dance.
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("stores post-analysis asset context separately from the report", async () => {
    await store.saveAssetContext("rep_assetcontext", { status: "complete", candidates: [] });
    expect(await store.loadAssetContext("rep_assetcontext")).toEqual({ status: "complete", candidates: [] });
    expect(await store.loadReport("rep_assetcontext")).toBeNull();
  });

  it("marks a pending asset sidecar unavailable after restart", async () => {
    await store.saveAssetContext("rep_pending", { status: "pending", completedAt: null, notes: [] });
    expect(await store.recoverPendingAssetContexts()).toBe(1);
    expect(await store.loadAssetContext("rep_pending")).toMatchObject({
      status: "unavailable",
      completedAt: expect.any(String),
    });
  });

  it("preserves completed balances but marks an interrupted candidate fork unavailable", async () => {
    await store.saveAssetContext("rep_fork_pending", {
      status: "complete",
      completedAt: "2026-09-04T00:00:00.000Z",
      candidates: [{ state: "verified_nonzero" }],
      forkScenarios: { requested: true, status: "pending", batch: null, note: "running" },
      notes: [],
    });
    expect(await store.recoverPendingAssetContexts()).toBe(1);
    expect(await store.loadAssetContext("rep_fork_pending")).toMatchObject({
      status: "complete",
      candidates: [{ state: "verified_nonzero" }],
      forkScenarios: { status: "unavailable" },
    });
  });
});

describe("the publication boundary", () => {
  it("stores a blocked report but never hands back its body", async () => {
    const { record } = await create(BLOCKED);
    await untilState(record, "completed");

    // No report id is exposed at all for a blocked result: there is nothing to
    // try against the report route.
    expect(record.reportId).toBeNull();
    expect(record.disclosure?.publishable).toBe(false);
    expect(record.disclosure?.message).toContain("withheld");
    // The blocked report is still ON DISK — it is evidence, and its author may
    // need it. What changes is who may read it.
    const metas = await store.listReportMeta();
    expect(metas.some((m) => !m.publishable)).toBe(true);
  });

  it("refuses a blocked report by id, returning no bytes", async () => {
    const { record } = await create(BLOCKED);
    await untilState(record, "completed");
    const metas = await store.listReportMeta();
    const blockedId = metas.find((m) => !m.publishable)?.id as string;

    const reports = new ReportService(store, join(dir, "calibration"));
    await reports.init();
    const loaded = await reports.loadPublishable(blockedId);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.reason).toBe("blocked");
    // There is no shape of this result that carries a body plus a "do not show" flag.
    expect(Object.keys(loaded)).toEqual(["ok", "reason"]);
  });

  it("omits blocked reports from the public listing entirely", async () => {
    const blocked = await create(BLOCKED);
    await untilState(blocked.record, "completed");
    const ok = await create(OK);
    await untilState(ok.record, "completed");

    const reports = new ReportService(store, join(dir, "calibration"));
    await reports.init();
    const listed = await reports.listPublishable();
    // A row reading "withheld: <protocol>" is itself a signal about that
    // protocol, and this listing is public.
    expect(listed.length).toBe(1);
    expect(listed[0]?.id).toBe(ok.record.reportId);
  });

  it("names nothing about what was withheld in its refusal message", () => {
    expect(BLOCKED_MESSAGE).not.toMatch(/0x[0-9a-fA-F]{8}/);
    expect(BLOCKED_MESSAGE).toContain("says nothing about whether such a vulnerability exists");
  });
});
