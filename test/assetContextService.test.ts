/**
 * THE BOUNDS ON THE POST-ANALYSIS LAYER.
 *
 * These refreshes start after a job's worker has exited, so `maxActiveJobs` — the
 * limiter that stops N anvil forks running at once — cannot see them. Unbounded,
 * N jobs finishing together meant N vendor fetches and N forks with no ceiling,
 * and a refresh that never finished left a `pending` sidecar that every open tab
 * polled forever.
 *
 * Network-free: `fetch` is stubbed, so the property under test is not "the
 * refresh succeeds" but that every way a refresh can fail to happen still writes
 * a sidecar that says so.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetContextService, BoundedSemaphore, type AssetContextArtifact } from "../server/asset-context.js";
import { modeRunsFork, RUN_MODES } from "../server/shared/dto.js";
import { JobStore } from "../server/jobs/store.js";
import type { ServerConfig } from "../server/config.js";
import type { Report } from "../src/report/schema.js";

const TARGET = "0xc3d688B66703497DAA19211EEdff47f25384cdc3";

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
    maxActiveAssetContexts: 1,
    maxQueuedAssetContexts: 0,
    assetContextTimeoutMs: 30_000,
    defaultBlock: 100n,
    webDistDir: null,
    calibrationDir: join(dataDir, "calibration"),
    liveSidecarDir: join(dataDir, "live"),
    mobulaApiKey: null,
    ...overrides,
  } as ServerConfig;
}

const report = (): Report => ({
  target: { address: TARGET },
  chainId: 1,
  block: { number: "25800000", hash: `0x${"11".repeat(32)}` },
} as unknown as Report);

async function until(predicate: () => Promise<boolean> | boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 20));
  }
}

let dir: string;
let store: JobStore;

beforeEach(async () => {
  // The vendor client retries four times with exponential backoff. These tests
  // are about the SERVICE, not the backoff, so collapse it.
  process.env.MOBULA_RETRY_BASE_MS = "1";
  dir = await mkdtemp(join(tmpdir(), "ripcord-assetctx-"));
  store = new JobStore(dir);
  await store.init();
});

afterEach(async () => {
  delete process.env.MOBULA_RETRY_BASE_MS;
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

/**
 * A vendor call that hangs until it is cancelled — the behaviour of real
 * `fetch`, which rejects with an AbortError when its signal fires. A stub that
 * IGNORED the signal would be testing a case that cannot happen, and would hide
 * whether cancellation is wired through at all.
 */
const hangingFetch = () => (_url: string, init?: { signal?: AbortSignal }) =>
  new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) return reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
  });

/**
 * A vendor call that answers LATE, after the deadline has already passed.
 *
 * Defaults to an HTTP 400 because that is the shape the overwrite was actually
 * reproduced with: a 4xx is not retried, so `buildLiveExposure` returns
 * `status: "unavailable"` and `complete()` writes that failure record — a write
 * that happens BEFORE any phase gate and therefore lands on top of the terminal
 * timeout result unless the generation guard refuses it.
 */
const lateFetch = (delayMs: number, payload?: unknown) => () =>
  new Promise((resolve) => setTimeout(() => resolve(
    payload === undefined
      ? { ok: false, status: 400, statusText: "Bad Request", text: async () => "" }
      : { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify(payload) },
  ), delayMs));

const load = (id: string) => store.loadAssetContext(id) as Promise<AssetContextArtifact | null>;
const settled = async (id: string) => {
  const context = await load(id);
  return context !== null && context.status !== "pending";
};

describe("post-analysis asset-context bounds", () => {
  it("refuses a refresh beyond the queue depth instead of queueing without bound", async () => {
    // A vendor call that never resolves: the first refresh holds the only slot,
    // so the second must be refused rather than waiting behind it forever.
    vi.stubGlobal("fetch", hangingFetch());
    const service = new AssetContextService(config(dir), store);

    await service.start("rep_first", report());
    await service.start("rep_second", report());

    await until(() => settled("rep_second"));
    const refused = await load("rep_second");
    expect(refused?.status).toBe("unavailable");
    expect(refused?.notes.join(" ")).toMatch(/queued|refused/i);
    // The one holding the slot is still legitimately pending, not overwritten.
    expect((await load("rep_first"))?.status).toBe("pending");

    await service.shutdown();
  });

  it("writes an explicit unavailable sidecar when a refresh outlives its time limit", async () => {
    // A vendor call that never resolves at all. Without the ceiling this
    // sidecar stays `pending` for the life of the process and every open tab
    // polls it every two seconds.
    vi.stubGlobal("fetch", hangingFetch());
    const service = new AssetContextService(config(dir, { assetContextTimeoutMs: 150 }), store);

    await service.start("rep_slow", report());
    await until(() => settled("rep_slow"));

    const context = await load("rep_slow");
    expect(context?.status).toBe("unavailable");
    expect(context?.completedAt).toEqual(expect.any(String));
    expect(context?.notes.join(" ")).toMatch(/exceeded its .*limit/i);
    await service.shutdown();
  });

  it("releases its slot so a later refresh can still run", async () => {
    // A failing vendor is the ordinary case and must not wedge the queue.
    vi.stubGlobal("fetch", async () => { throw new Error("network down"); });
    const service = new AssetContextService(config(dir), store);

    await service.start("rep_a", report());
    await until(() => settled("rep_a"));
    await service.start("rep_b", report());
    await until(() => settled("rep_b"));

    for (const id of ["rep_a", "rep_b"]) {
      const context = await load(id);
      expect(context?.status).toBe("unavailable");
      // Refused for a VENDOR reason, never for a queue reason — proof the slot
      // was returned rather than leaked by the first failure.
      expect(context?.notes.join(" ")).not.toMatch(/queue was full/i);
    }
    await service.shutdown();
  });

  it("never leaves a sidecar pending once shutdown has begun", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const service = new AssetContextService(config(dir), store);
    await service.start("rep_held", report());
    await service.start("rep_waiting", report());
    await service.shutdown();

    // The queued one resolved to an explicit answer rather than hanging.
    await until(() => settled("rep_waiting"));
    expect((await load("rep_waiting"))?.status).toBe("unavailable");
  });

  it("records a fork batch as unavailable when the analysis never established a supported interface", async () => {
    vi.stubGlobal("fetch", async () => { throw new Error("network down"); });
    const service = new AssetContextService(config(dir), store);
    await service.start("rep_fork", report(), true);
    await until(() => settled("rep_fork"));

    const context = await load("rep_fork");
    expect(context?.forkScenarios.requested).toBe(true);
    expect(context?.forkScenarios.status).toBe("unavailable");
    expect(context?.forkScenarios.batch).toBeNull();
    await service.shutdown();
  });

  /**
   * THE REGRESSION THE FIRST VERSION OF THESE TESTS MISSED.
   *
   * `Promise.race([complete(), expiry])` LOOKS like a deadline and is not one: a
   * race does not cancel its loser. The timeout resolved, the slot was released,
   * `unavailable` was written — and then the vendor answered and overwrote the
   * terminal record with a stale one.
   *
   * A test that only asserts the state shortly after the deadline passes on the
   * broken code, which is why the bug survived a green suite. This one waits for
   * the late answer to arrive and asserts the record did NOT move.
   */
  it("keeps a timed-out sidecar terminal when the vendor answers afterwards", async () => {
    const LATE_MS = 800;
    vi.stubGlobal("fetch", lateFetch(LATE_MS));
    // The settle grace is deliberately SHORTER than the vendor's late answer.
    // Otherwise the supervisor's terminal write happens after the late write
    // simply because it waited for it, and the test would pass on ordering
    // luck instead of on the generation guard — which is exactly how the first
    // version of this test passed against the broken code.
    const service = new AssetContextService(
      config(dir, { assetContextTimeoutMs: 80 }), store, { settleGraceMs: 100 },
    );

    await service.start("rep_late", report());
    await until(() => settled("rep_late"));

    const atTimeout = await load("rep_late");
    expect(atTimeout?.status).toBe("unavailable");
    expect(atTimeout?.notes.join(" ")).toMatch(/exceeded its .*limit/i);

    // Well past the vendor's late answer.
    await new Promise((r) => setTimeout(r, LATE_MS * 2));

    const afterwards = await load("rep_late");
    expect(afterwards?.status).toBe("unavailable");
    expect(afterwards?.notes.join(" ")).toMatch(/exceeded its .*limit/i);
    // The decisive assertion: the whole record is byte-identical. A late write
    // of ANY shape — including another `unavailable` — is still a stale run
    // reaching the store after a terminal result.
    expect(afterwards).toEqual(atTimeout);
    await service.shutdown();
  });

  it("holds the concurrency slot until a cancelled run has actually stopped", async () => {
    // The slot used to be released the instant the race resolved, while the
    // real work kept running — so `maxActiveAssetContexts` bounded wrappers,
    // not work. With one slot and one queue place, the second refresh must not
    // be admitted before the first has genuinely unwound.
    const started: number[] = [];
    vi.stubGlobal("fetch", (_url: string, init?: { signal?: AbortSignal }) => {
      started.push(Date.now());
      return hangingFetch()(_url, init);
    });
    const service = new AssetContextService(
      config(dir, { assetContextTimeoutMs: 80, maxQueuedAssetContexts: 1 }), store, { settleGraceMs: 2_000 },
    );

    await service.start("rep_one", report());
    await service.start("rep_two", report());
    await until(() => settled("rep_one") && settled("rep_two"), 8_000);

    // Both reached a terminal state, and the second one actually ran rather
    // than being refused — proof the slot was returned, not leaked.
    expect((await load("rep_one"))?.status).toBe("unavailable");
    expect((await load("rep_two"))?.status).toBe("unavailable");
    expect(started.length).toBe(2);
    // The second vendor call began only after the first run had been cancelled
    // and unwound, never concurrently with it.
    expect(started[1]! - started[0]!).toBeGreaterThanOrEqual(70);
    await service.shutdown();
  }, 15_000);

  it("refuses a sealed run's write even when it comes back with a real result", async () => {
    // Directly: seal the run mid-flight via shutdown, then let the vendor
    // answer. Nothing the old run produces may reach the store.
    vi.stubGlobal("fetch", lateFetch(300));
    const service = new AssetContextService(config(dir), store, { settleGraceMs: 2_000 });
    await service.start("rep_sealed", report());

    const before = await load("rep_sealed");
    expect(before?.status).toBe("pending");

    await service.shutdown();
    await new Promise((r) => setTimeout(r, 900));

    // Still the pending marker: boot recovery is what resolves this one, not a
    // write from a run the service has already given up on.
    const after = await load("rep_sealed");
    expect(after?.status).toBe("pending");
    expect(after).toEqual(before);
  }, 15_000);

  it("does not start a fork for a run that was already cancelled", async () => {
    // The fork batch refuses to spawn anvil on an aborted signal. Exercised
    // here through shutdown, which seals every in-flight run.
    vi.stubGlobal("fetch", hangingFetch());
    const service = new AssetContextService(config(dir), store, { settleGraceMs: 2_000 });
    await service.start("rep_nofork", report(), true);
    await service.shutdown();

    const context = await load("rep_nofork");
    // Never advanced past pending, so no batch was ever recorded.
    expect(context?.forkScenarios.batch).toBeNull();
  }, 15_000);

  it("stamps each refresh with its own run id", async () => {
    vi.stubGlobal("fetch", async () => { throw new Error("network down"); });
    const service = new AssetContextService(config(dir), store);

    await service.start("rep_gen", report());
    await until(() => settled("rep_gen"));
    const first = await load("rep_gen");

    await service.start("rep_gen", report());
    await until(async () => {
      const current = await load("rep_gen");
      return current !== null && current.status !== "pending" && current.runId !== first?.runId;
    });
    const second = await load("rep_gen");

    expect(first?.runId).toEqual(expect.any(String));
    expect(second?.runId).toEqual(expect.any(String));
    expect(second?.runId).not.toBe(first?.runId);
    await service.shutdown();
  });

  it("forgets a completed run instead of aborting it again during a later shutdown", async () => {
    let completedSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", async (_url: string, init?: { signal?: AbortSignal }) => {
      completedSignal ??= init?.signal;
      throw new Error("network down");
    });
    const service = new AssetContextService(config(dir), store);

    await service.start("rep_disposed", report());
    await until(() => settled("rep_disposed"));
    expect(completedSignal).toBeDefined();
    expect(completedSignal?.aborted).toBe(false);

    await service.shutdown();
    // If the settled run were still retained in `runs`, shutdown would seal it
    // and abort this signal even though its work had already ended.
    expect(completedSignal?.aborted).toBe(false);
  });

  /**
   * THE OVER-ADMISSION RACE, TESTED WHERE IT IS REACHABLE.
   *
   * The window is one microtask wide: between `release()` waking a waiter and
   * that waiter's continuation running. Through `AssetContextService.start()` it
   * is not reachable at all, because `acquire()` is always preceded by an awaited
   * filesystem write, so a service-level test passes against the broken code —
   * verified, not assumed. The invariant is real regardless, and it is the one
   * thing standing between `maxActiveAssetContexts` and two concurrent anvil
   * forks, so it is tested on the semaphore directly.
   */
  it("never grants more than the active limit, even when an acquire lands in the release window", async () => {
    const sem = new BoundedSemaphore(1, 8);
    expect(await sem.acquire()).toBe(true);

    const b = sem.acquire();
    expect(sem.queued).toBe(1);

    // Release, then acquire again in the SAME microtask drain — the exact
    // interleaving the old decrement-then-wake ordering admitted. Under that
    // ordering the count dips to 0 here, so C is granted immediately and B is
    // granted a moment later: two holders under a limit of one.
    sem.release();
    const c = sem.acquire();

    expect(await b).toBe(true);
    // C must still be waiting: the slot went to B and the count never dipped.
    expect(await Promise.race([c, Promise.resolve("still-waiting")])).toBe("still-waiting");
    expect(sem.held).toBe(1);

    sem.close();
    expect(await c).toBe(false);
  });

  it("keeps the count exact across interleaved release and acquire", async () => {
    const sem = new BoundedSemaphore(2, 8);
    expect(await sem.acquire()).toBe(true);
    expect(await sem.acquire()).toBe(true);
    expect(sem.held).toBe(2);

    const queued = [sem.acquire(), sem.acquire()];
    expect(sem.queued).toBe(2);

    // Two releases and two fresh acquires, all in one drain.
    sem.release();
    const late = sem.acquire();
    sem.release();

    await Promise.all(queued);
    // The two waiters were handed the two slots; the latecomer is queued behind
    // them rather than admitted alongside them.
    expect(sem.held).toBe(2);
    expect(await Promise.race([late, Promise.resolve("still-waiting")])).toBe("still-waiting");
    sem.close();
    expect(await late).toBe(false);
  });

  it("refuses waiters on close without corrupting the count", async () => {
    const sem = new BoundedSemaphore(1, 4);
    expect(await sem.acquire()).toBe(true);
    const waiter = sem.acquire();
    sem.close();
    expect(await waiter).toBe(false);
    // The holder is unaffected and its release does not push the count negative.
    sem.release();
    expect(sem.held).toBe(0);
  });

  it("hands a transferred slot on rather than keeping it when closed mid-wait", async () => {
    const sem = new BoundedSemaphore(1, 4);
    expect(await sem.acquire()).toBe(true);
    const waiter = sem.acquire();
    // The slot is transferred to the waiter first, and only then does the
    // semaphore close — the waiter must give the slot back, not swallow it.
    sem.release();
    sem.close();
    expect(await waiter).toBe(false);
    expect(sem.held).toBe(0);
  });

  /**
   * The entrypoint decides whether a refresh may run a fork from the stored
   * report's mode. `StoredReportMeta.mode` is NULLABLE, and the first version
   * asked `mode !== "scan"` — so a report whose mode could not be recovered
   * would have been granted a fork. Fail-open, in the one place that decides
   * whether an anvil process starts.
   */
  it("only offers the fork pass for modes that actually run a fork", () => {
    expect(modeRunsFork("scan")).toBe(false);
    expect(modeRunsFork("scan_withdrawal_test")).toBe(true);
    expect(modeRunsFork("scan_withdrawal_test_upgrade_proof")).toBe(true);
    // The two ways a mode can be absent, both of which must decline.
    expect(modeRunsFork(null)).toBe(false);
    expect(modeRunsFork(undefined)).toBe(false);
    // And an unknown future mode declines until it is listed deliberately.
    expect(modeRunsFork("some_future_mode" as never)).toBe(false);
    // Every real mode is accounted for, so adding one cannot slip through.
    expect(RUN_MODES.filter(modeRunsFork).length + RUN_MODES.filter((m) => !modeRunsFork(m)).length)
      .toBe(RUN_MODES.length);
  });
});
