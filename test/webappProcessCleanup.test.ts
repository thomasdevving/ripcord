/** Real OS regression: unlike the model-based concurrency suite, this must
 * kill a live descendant that ignores TERM. No RPC or blockchain is involved. */
import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { JobManager } from "../server/jobs/manager.js";
import { JobStore } from "../server/jobs/store.js";
import { loadConfig } from "../server/config.js";
it("kills the owned process group, including a TERM-resistant descendant, before releasing capacity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ripcord-process-tree-"));
  const store = new JobStore(dir); await store.init();
  const config = loadConfig({ RIPCORD_DATA_DIR: dir, RPC_URL_1: "https://rpc.invalid" });
  const manager = new JobManager(config, store, fileURLToPath(new URL("./fixtures/process-tree-worker.mjs", import.meta.url)));
  await manager.init();
  try {
    const job = await manager.createJob({ address: `0x${"ab".repeat(20)}`, chainId: 1, mode: "scan", block: "100" }, 100n, "explicit");
    const deadline = Date.now() + 5000;
    while (!job.record.phases[0]?.metrics?.descendantPid && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
    const metrics = job.record.phases[0]?.metrics!;
    expect(metrics?.descendantPid).toBeGreaterThan(0);
    const cancel = manager.cancel(job.record.jobId, job.controlToken);
    expect(manager.stats().active).toBe(1);
    await cancel;
    expect(manager.stats().active).toBe(0);
    expect(job.record.state).toBe("cancelled");
    // Unix may briefly retain a terminated orphan as a zombie until init reaps
    // it; /proc identifies that as dead without confusing it with a live child.
    for (const pid of [Number(metrics.workerPid), Number(metrics.descendantPid)]) {
      let alive = true;
      for (let i = 0; i < 40 && alive; i++) {
        try {
          process.kill(pid, 0);
          if (process.platform === "linux") {
            const { readFile } = await import("node:fs/promises");
            const status = await readFile(`/proc/${pid}/status`, "utf8");
            if (/^State:\s+Z/m.test(status)) alive = false;
          }
        } catch (err) { if (["ESRCH", "ENOENT"].includes((err as NodeJS.ErrnoException).code ?? "")) alive = false; else throw err; }
        if (alive) await new Promise(r => setTimeout(r, 25));
      }
      expect(alive).toBe(false);
    }
  } finally { await manager.shutdown(); await rm(dir, { recursive: true, force: true }); }
});
