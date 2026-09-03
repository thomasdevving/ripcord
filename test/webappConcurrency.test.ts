/** Mock only the OS process boundary. Real group cleanup is separately exercised
 * by webappJobs/webappProcessCleanup on hosts that permit process groups. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobManager } from "../server/jobs/manager.js";
import { JobStore } from "../server/jobs/store.js";
import { loadConfig } from "../server/config.js";
const h = vi.hoisted(() => ({ children: [] as any[], fork: vi.fn() }));
vi.mock("node:child_process", () => ({ fork: (...args: unknown[]) => h.fork(...args) }));
let dir: string, store: JobStore, manager: JobManager;
const req = { address: `0x${"ab".repeat(20)}`, chainId: 1, block: "100", mode: "scan" as const };
const flush = async () => { for (let i = 0; i < 15; i++) await new Promise(r => setTimeout(r, 2)); };
beforeEach(async () => {
  h.children = [];
  h.fork.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { pid: 800000 + h.children.length, exitCode: null, signalCode: null, killed: false, stderr: new EventEmitter(), send: vi.fn(), ignoreTerm: false, alive: true });
    h.children.push(child); return child;
  });
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    const child = h.children.find(c => c.pid === -pid);
    if (!child?.alive) throw Object.assign(new Error("no process"), { code: "ESRCH" });
    if (signal && signal !== 0) {
      child.killed = true;
      if (!child.ignoreTerm || signal === "SIGKILL") { child.alive = false; child.signalCode = signal; queueMicrotask(() => child.emit("exit", null, signal)); }
    }
    return true;
  });
  dir = await mkdtemp(join(tmpdir(), "ripcord-concurrency-"));
  store = new JobStore(dir); await store.init();
  const config = loadConfig({ RIPCORD_DATA_DIR: dir, RIPCORD_ENABLE_LIVE_RUNS: "true", RPC_URL_1: "https://rpc.invalid/v2/fixture" });
  manager = new JobManager({ ...config, maxActiveJobs: 1, maxQueuedJobs: 3 }, store, "mock-worker"); await manager.init();
});
afterEach(async () => { await manager.shutdown(); vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

describe("serialized admission, state persistence and cleanup ordering", () => {
  it("accepts at most one active plus three queued jobs under simultaneous submissions", async () => {
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => manager.createJob(req, 100n, "explicit")));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(4);
    expect(manager.stats()).toEqual({ active: 1, queued: 3 });
  });
  it("deduplicates simultaneous requests before any repeated RPC validation", async () => {
    const input = { ...req, block: "latest", idempotencyKey: "test-repeat-intent", controlToken: "test-cancellation-capability-000000000" };
    const validate = vi.fn(async () => { await flush(); return manager.createJob(input, 100n, "resolved_latest"); });
    const results = await Promise.all(Array.from({ length: 6 }, () => manager.admit(input, validate)));
    expect(validate).toHaveBeenCalledOnce();
    expect(new Set(results.map(r => r.record.jobId)).size).toBe(1);
    expect(results.every(r => r.controlToken === input.controlToken)).toBe(true);
    const retry = await manager.admit(input, () => { throw new Error("must not resolve latest again"); });
    expect(retry.record.block).toBe("100");
    expect(retry.deduplicated).toBe(true);
  });
  it("refuses expensive validation when the queue is already full", async () => {
    await Promise.all(Array.from({ length: 4 }, () => manager.createJob(req, 100n, "explicit")));
    const validate = vi.fn();
    await expect(manager.admit(req, validate)).rejects.toThrow(/queue is full/);
    expect(validate).not.toHaveBeenCalled();
  });
  it("does not spawn after a cancel during asynchronous startup", async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    vi.spyOn(store, "ensureArtifactDir").mockImplementation(async () => { await gate; return dir; });
    const job = await manager.createJob(req, 100n, "explicit"); await flush();
    await manager.cancel(job.record.jobId, job.controlToken);
    release(); await flush();
    expect(h.children).toHaveLength(0);
    expect((await store.loadJob(job.record.jobId))?.state).toBe("cancelled");
    const events = await store.readEvents(job.record.jobId);
    const terminal = events.findIndex(e => e.type === "job.state" && e.state === "cancelled");
    expect(events.slice(terminal + 1).some(e => e.type === "job.state" && e.state === "running")).toBe(false);
  });
  it("late worker messages cannot overwrite a persisted terminal state or its cursor", async () => {
    const job = await manager.createJob(req, 100n, "explicit"); await flush();
    const child = h.children[0];
    for (let i = 0; i < 10; i++) child.emit("message", { type: "event", payload: { type: "stage.completed", phase: "proxy", detail: `message ${i}` } });
    await manager.cancel(job.record.jobId, job.controlToken);
    child.emit("message", { type: "event", payload: { type: "stage.started", phase: "proxy" } });
    await flush();
    const stored = await store.loadJob(job.record.jobId);
    expect(stored?.state).toBe("cancelled");
    expect(stored?.phases.some(p => p.status === "running")).toBe(false);
    const events = await store.readEvents(job.record.jobId);
    expect(stored?.lastSeq).toBe(events.at(-1)?.seq);
    expect(events.map(e => e.seq)).toEqual([...events.map(e => e.seq)].sort((a,b) => a-b));
  });
  it("persists each fork block so reconnecting from lastSeq cannot lose earlier evidence", async () => {
    const job = await manager.createJob(req, 100n, "explicit"); await flush();
    h.children[0].emit("message", { type: "event", payload: { type: "fork.baseline.completed", established: true, detail: "measured", transactions: [], evidence: [{ rawValue: "1234" }] } });
    await flush();
    expect(manager.toSummary((await store.loadJob(job.record.jobId))!).fork?.baseline?.detail).toBe("measured");
  });
  it("rechecks a transient EPERM during process-group teardown instead of reporting a false cleanup failure", async () => {
    const job = await manager.createJob(req, 100n, "explicit"); await flush();
    const signal = vi.mocked(process.kill);
    const normal = signal.getMockImplementation()!;
    signal.mockImplementationOnce(() => { throw Object.assign(new Error("teardown transition"), { code: "EPERM" }); });
    signal.mockImplementation(normal);
    expect(await manager.cancel(job.record.jobId, job.controlToken)).toBe("cancelled");
    expect(manager.stats().active).toBe(0);
    expect(job.record.error?.message).toBe("The analysis was cancelled.");
  });
  it("escalates even when child.killed is already true and retains its slot until exit", async () => {
    const job = await manager.createJob(req, 100n, "explicit"); await flush();
    const child = h.children[0]; child.ignoreTerm = true;
    vi.useFakeTimers();
    const cancel = manager.cancel(job.record.jobId, job.controlToken);
    expect(child.killed).toBe(true);
    expect(manager.stats().active).toBe(1);
    await vi.advanceTimersByTimeAsync(3100);
    vi.useRealTimers();
    await cancel;
    expect(process.kill).toHaveBeenCalledWith(-child.pid, "SIGKILL");
    expect(child.alive).toBe(false);
    expect(manager.stats().active).toBe(0);
  });
});
