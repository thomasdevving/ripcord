import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rpc = vi.hoisted(() => ({
  hash: `0x${"ab".repeat(32)}`,
  client: {
    getBlockNumber: vi.fn(async () => 100n),
    getChainId: vi.fn(async () => 1),
    getBlock: vi.fn(async () => ({ number: 100n, hash: `0x${"ab".repeat(32)}` })),
    getCode: vi.fn(async () => "0x6000"),
  },
}));
vi.mock("viem", async (importOriginal) => ({
  ...(await importOriginal<typeof import("viem")>()),
  createPublicClient: () => rpc.client,
  http: () => ({}),
}));

import { JobStore } from "../server/jobs/store.js";
import { JobManager } from "../server/jobs/manager.js";
import { ReportService } from "../server/reports.js";
import { ProtocolStore } from "../server/protocol-store.js";
import { registerRoutes } from "../server/routes.js";
import { loadConfig } from "../server/config.js";

const WORKER = resolve(fileURLToPath(new URL("./fixtures/fake-worker.mjs", import.meta.url)));
const address = (suffix: string) => `0x${"0".repeat(38)}${suffix}`;

let dir: string;
let app: ReturnType<typeof Fastify>;
let manager: JobManager;

beforeEach(async () => {
  rpc.client.getBlock.mockResolvedValue({ number: 100n, hash: rpc.hash });
  dir = await mkdtemp(join(tmpdir(), "ripcord-protocol-routes-"));
  const jobs = new JobStore(dir); await jobs.init();
  const protocolStore = new ProtocolStore(dir); await protocolStore.init();
  const config = loadConfig({
    RIPCORD_DATA_DIR: dir,
    RIPCORD_ENABLE_LIVE_RUNS: "true",
    RIPCORD_MAX_ACTIVE_JOBS: "1",
    RIPCORD_MAX_QUEUED_JOBS: "3",
    RPC_URL_1: "https://rpc.invalid/fixture",
  });
  manager = new JobManager(config, jobs, WORKER); await manager.init();
  const reports = new ReportService(jobs, join(dir, "calibration")); await reports.init();
  app = Fastify(); registerRoutes(app, { config, manager, reports, protocolStore, anvil: { available: false, version: null } });
});

afterEach(async () => {
  await manager.shutdown();
  await app.close();
  await rm(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

async function untilComplete(protocolId: string): Promise<any> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await app.inject({ method: "GET", url: `/api/protocols/${protocolId}` });
    const body = response.json();
    if (!["queued", "running"].includes(body.scans[0]?.state)) return body;
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error("protocol scan did not finish");
}

describe("protocol scan routes", () => {
  it("pins one block identity across the batch and deduplicates a retried start", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/protocols",
      payload: { name: "Batch", targets: [{ label: "One", address: address("01") }, { label: "Two", address: address("06") }] },
    });
    const protocolId = created.json().protocol.id as string;
    const [first, retry] = await Promise.all([
      app.inject({ method: "POST", url: `/api/protocols/${protocolId}/scans`, payload: { idempotencyKey: "batch_request_1" } }),
      app.inject({ method: "POST", url: `/api/protocols/${protocolId}/scans`, payload: { idempotencyKey: "batch_request_1" } }),
    ]);
    expect(first.statusCode).toBe(202);
    expect(first.json().scan.targets).toHaveLength(2);
    const firstScanId = first.json().scan.id;

    expect(retry.statusCode).toBe(202);
    expect(retry.json().scan.id).toBe(firstScanId);

    const finished = await untilComplete(protocolId);
    expect(finished.scans).toHaveLength(1);
    expect(finished.scans[0].state, JSON.stringify(finished.scans[0], null, 2)).toBe("completed");
    expect(new Set(finished.scans[0].targets.map((target: any) => target.block))).toEqual(new Set(["100"]));
    expect(rpc.client.getBlockNumber).toHaveBeenCalledOnce();
    expect(rpc.client.getBlock).toHaveBeenCalledTimes(3); // batch pin + one identity check per target
  });

  it("refuses a target if the pinned block hash changes during batch admission", async () => {
    const changedHash = `0x${"cd".repeat(32)}`;
    rpc.client.getBlock
      .mockResolvedValueOnce({ number: 100n, hash: rpc.hash })
      .mockResolvedValueOnce({ number: 100n, hash: changedHash });
    const created = await app.inject({ method: "POST", url: "/api/protocols", payload: { name: "Reorg", targets: [{ address: address("01") }] } });
    const protocolId = created.json().protocol.id as string;
    const response = await app.inject({ method: "POST", url: `/api/protocols/${protocolId}/scans`, payload: { idempotencyKey: "reorg_request" } });
    expect(response.statusCode).toBe(202);
    expect(response.json().scan.state).toBe("failed");
    expect(response.json().scan.targets[0].jobId).toBeNull();
    expect(response.json().scan.targets[0].error.message).toMatch(/identity changed/i);
  });
});
