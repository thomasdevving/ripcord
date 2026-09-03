import { afterEach, beforeEach, expect, it } from "vitest";
import Fastify from "fastify";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore } from "../server/jobs/store.js";
import { JobManager } from "../server/jobs/manager.js";
import { ReportService } from "../server/reports.js";
import { registerRoutes } from "../server/routes.js";
import { loadConfig } from "../server/config.js";
let dir: string, app: ReturnType<typeof Fastify>, store: JobStore, manager: JobManager;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ripcord-http-")); store = new JobStore(dir); await store.init();
  const config = loadConfig({ RIPCORD_DATA_DIR: dir });
  manager = new JobManager(config, store, "unused-worker"); await manager.init();
  const reports = new ReportService(store, join(dir, "calibration")); await reports.init();
  app = Fastify(); registerRoutes(app, { config, manager, reports, anvil: { available: false, version: null } });
});
afterEach(async () => { await manager.shutdown(); await app.close(); await rm(dir, { recursive: true, force: true }); });
it("enforces the same publication projection on JSON and download without removing evidence", async () => {
  const report = JSON.parse(await readFile("calibration/reports/compound-comet-cusdcv3.json", "utf8"));
  const marker = "SYNTHETIC_RPC_CREDENTIAL";
  report.errors.push({ stage: "block", message: `viem failed at https://rpc.invalid/v2/${marker}` });
  await store.saveReport("rep_test", report, { id: "rep_test", publishable: true } as any);
  const response = await app.inject({ method: "GET", url: "/api/reports/rep_test" });
  const download = await app.inject({ method: "GET", url: "/api/reports/rep_test/download" });
  expect(response.statusCode).toBe(200); expect(download.statusCode).toBe(200);
  expect(response.body + download.body).not.toContain(marker);
  expect(response.json().report.block.hash).toBe(report.block.hash);
  expect(response.json().structure.nodes.length).toBeGreaterThan(1);
  expect(download.json().target.address).toBe(report.target.address);
});
it("never returns a blocked body or graph even if the sidecar falsely says publishable", async () => {
  await store.saveReport("rep_blocked", { disclosure: { publishable: false }, findings: "WITHHELD_PAYLOAD" }, { id: "rep_blocked", publishable: true } as any);
  for (const url of ["/api/reports/rep_blocked", "/api/reports/rep_blocked/download"]) {
    const response = await app.inject({ method: "GET", url });
    expect(response.statusCode).toBe(451); expect(response.body).not.toContain("WITHHELD_PAYLOAD"); expect(response.json().structure).toBeUndefined();
  }
});
