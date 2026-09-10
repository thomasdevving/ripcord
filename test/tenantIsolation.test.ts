import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore } from "../server/jobs/store.js";
import { JobManager } from "../server/jobs/manager.js";
import { ProtocolStore } from "../server/protocol-store.js";
import { ReportService } from "../server/reports.js";
import { registerRoutes } from "../server/routes.js";
import { loadConfig } from "../server/config.js";
import { OTHER_ORGANIZATION_ID, TEST_ORGANIZATION_ID, testAuth } from "./helpers/auth.js";

const address = `0x${"41".repeat(20)}`;
const headersFor = (organizationId: string) => ({ "x-test-organization": organizationId });

let dir: string;
let app: ReturnType<typeof Fastify>;
let jobs: JobStore;
let manager: JobManager;
let protocols: ProtocolStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ripcord-tenants-"));
  jobs = new JobStore(dir); await jobs.init();
  protocols = new ProtocolStore(dir); await protocols.init();
  const config = loadConfig({ RIPCORD_DATA_DIR: dir });
  manager = new JobManager(config, jobs, "unused-worker"); await manager.init();
  const reports = new ReportService(jobs, join(dir, "calibration")); await reports.init();
  app = Fastify();
  registerRoutes(app, { config, manager, reports, protocolStore: protocols, auth: testAuth, anvil: { available: false, version: null } });
});

afterEach(async () => {
  await manager.shutdown();
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("organization isolation", () => {
  it("requires authentication before accepting private work", async () => {
    const result = await app.inject({ method: "POST", url: "/api/protocols", headers: { "x-test-auth": "anonymous" }, payload: { name: "Hidden", targets: [{ address }] } });
    expect(result.statusCode).toBe(401);
    expect((await protocols.listProtocols(TEST_ORGANIZATION_ID))).toEqual([]);
  });

  it("does not reveal another organization's protocol or scan through detail or listing", async () => {
    const created = await app.inject({ method: "POST", url: "/api/protocols", headers: headersFor(TEST_ORGANIZATION_ID), payload: { name: "Private protocol", targets: [{ address }] } });
    const protocolId = created.json().protocol.id as string;
    const protocol = await protocols.getProtocol(protocolId, TEST_ORGANIZATION_ID);
    const scan = await protocols.createScan(protocol!, "tenant_scan");
    expect(scan.scan.organizationId).toBe(TEST_ORGANIZATION_ID);

    const foreignDetail = await app.inject({ method: "GET", url: `/api/protocols/${protocolId}`, headers: headersFor(OTHER_ORGANIZATION_ID) });
    const foreignList = await app.inject({ method: "GET", url: "/api/protocols", headers: headersFor(OTHER_ORGANIZATION_ID) });
    expect(foreignDetail.statusCode).toBe(404);
    expect(foreignList.json().protocols).toEqual([]);
    expect(foreignDetail.body).not.toContain("Private protocol");
  });

  it("returns 404 and no bytes for foreign jobs and live reports", async () => {
    await jobs.saveJob({ jobId: "job_private", organizationId: TEST_ORGANIZATION_ID, state: "completed", createdAt: new Date().toISOString(), reportId: "rep_private" } as never);
    await jobs.saveReport(
      "rep_private",
      { disclosure: { publishable: true }, marker: "TENANT_SECRET_REPORT" },
      { id: "rep_private", organizationId: TEST_ORGANIZATION_ID, publishable: true, generatedAt: new Date().toISOString() } as never,
    );

    const foreignJob = await app.inject({ method: "GET", url: "/api/jobs/job_private", headers: headersFor(OTHER_ORGANIZATION_ID) });
    const foreignReport = await app.inject({ method: "GET", url: "/api/reports/rep_private", headers: headersFor(OTHER_ORGANIZATION_ID) });
    const foreignList = await app.inject({ method: "GET", url: "/api/reports", headers: headersFor(OTHER_ORGANIZATION_ID) });
    expect(foreignJob.statusCode).toBe(404);
    expect(foreignReport.statusCode).toBe(404);
    expect(foreignReport.body).not.toContain("TENANT_SECRET_REPORT");
    expect(foreignList.json().reports).toEqual([]);

    const ownerReport = await app.inject({ method: "GET", url: "/api/reports/rep_private", headers: headersFor(TEST_ORGANIZATION_ID) });
    expect(ownerReport.statusCode).toBe(200);
    expect(ownerReport.body).toContain("TENANT_SECRET_REPORT");
  });

  it("does not follow a protocol scan reference into another organization's job", async () => {
    const protocol = await protocols.createProtocol(TEST_ORGANIZATION_ID, "Owned protocol", [{ label: "Core", address, chainId: 1 }]);
    const scan = await protocols.createScan(protocol, "cross_tenant_reference");
    await jobs.saveJob({
      jobId: "job_foreign_reference",
      organizationId: OTHER_ORGANIZATION_ID,
      state: "completed",
      createdAt: new Date().toISOString(),
      reportId: "rep_foreign_reference",
      block: "123456",
      disclosure: { publishable: true, message: "FOREIGN_DISCLOSURE" },
    } as never);
    await protocols.saveScanTarget(scan.scan, { targetId: protocol.targets[0].id, jobId: "job_foreign_reference", submissionError: null });

    const detail = await app.inject({ method: "GET", url: `/api/protocols/${protocol.id}`, headers: headersFor(TEST_ORGANIZATION_ID) });
    expect(detail.statusCode).toBe(200);
    const target = detail.json().scans[0].targets[0];
    expect(target.state).toBe("interrupted");
    expect(target.reportId).toBeNull();
    expect(target.block).toBeNull();
    expect(detail.body).not.toContain("FOREIGN_DISCLOSURE");
  });

  it("claims pre-auth records only for the explicitly configured organization", async () => {
    await jobs.saveJob({ jobId: "job_legacy", state: "completed", createdAt: new Date().toISOString(), reportId: null } as never);
    await jobs.saveReport("rep_legacy", { disclosure: { publishable: true } }, { id: "rep_legacy", publishable: true, generatedAt: new Date().toISOString() } as never);
    const legacy = await protocols.createProtocol("temporary-owner", "Legacy", [{ label: "Core", address, chainId: 1 }]);
    const legacyScan = await protocols.createScan(legacy, "legacy_scan");
    // Recreate the actual pre-auth JSON shape: ownership did not exist on either record.
    for (const path of [join(protocols.protocolsDir, `${legacy.id}.json`), join(protocols.scansDir, `${legacyScan.scan.id}.json`)]) {
      const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      delete value.organizationId;
      await writeFile(path, JSON.stringify(value, null, 2), "utf8");
    }
    const protocolMigration = await protocols.claimUnowned(TEST_ORGANIZATION_ID);
    const migration = await jobs.claimUnowned(TEST_ORGANIZATION_ID);
    expect(protocolMigration).toEqual({ protocols: 1, scans: 1 });
    expect(migration).toEqual({ jobs: 1, reports: 1 });
    expect((await jobs.loadJob("job_legacy"))?.organizationId).toBe(TEST_ORGANIZATION_ID);
    expect((await jobs.loadReportMeta("rep_legacy"))?.organizationId).toBe(TEST_ORGANIZATION_ID);
    expect((await protocols.getProtocol(legacy.id, TEST_ORGANIZATION_ID))?.id).toBe(legacy.id);
    expect((await protocols.listScans(legacy.id, TEST_ORGANIZATION_ID))[0]?.id).toBe(legacyScan.scan.id);
    expect(await protocols.getProtocol(legacy.id, "temporary-owner")).toBeNull();
  });
});
