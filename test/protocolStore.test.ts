import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProtocolStore, validateProtocolInput } from "../server/protocol-store.js";
import { JobStore } from "../server/jobs/store.js";

let dir: string;
let store: ProtocolStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ripcord-protocols-"));
  store = new ProtocolStore(dir);
  await store.init();
});

afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("protocol store", () => {
  it("persists one baseline and deduplicates a repeated heavyweight submission", async () => {
    const protocol = await store.createProtocol("Test protocol", [{ label: "Core", address: `0x${"11".repeat(20)}`, chainId: 1 }]);
    const first = await store.createScan(protocol, "request_key");
    expect(first.scan.kind).toBe("baseline");
    expect(first.scan.targets[0]?.submissionError?.message).toContain("stopped before");

    await store.saveScanTarget(first.scan, { targetId: protocol.targets[0]!.id, jobId: "job_1", submissionError: null });
    const retry = await store.createScan(protocol, "request_key");
    expect(retry.deduplicated).toBe(true);
    expect(retry.scan.id).toBe(first.scan.id);
    expect(retry.scan.targets[0]?.jobId).toBe("job_1");

    const second = await store.createScan(protocol, "request_key_2");
    expect(second.scan.kind).toBe("rescan");
    expect(second.scan.sequence).toBe(2);
  });

  it("rejects duplicate contracts and unsupported chains at the boundary", () => {
    const address = `0x${"22".repeat(20)}`;
    expect(validateProtocolInput({ name: "A", targets: [{ address }] }).ok).toBe(false);
    expect(validateProtocolInput({ name: "Valid", targets: [{ address }, { address: address.toUpperCase().replace("0X", "0x") }] }).ok).toBe(false);
    expect(validateProtocolInput({ name: "Valid", targets: [{ address, chainId: 8453 }] }).ok).toBe(false);
  });

  it("keeps jobs and reports that a durable protocol timeline references", async () => {
    const jobs = new JobStore(dir); await jobs.init();
    const protocol = await store.createProtocol("Retained", [{ label: "Core", address: `0x${"33".repeat(20)}`, chainId: 1 }]);
    const scan = await store.createScan(protocol, "retention_key");
    await store.saveScanTarget(scan.scan, { targetId: protocol.targets[0]!.id, jobId: "job_kept", submissionError: null });
    await jobs.saveJob({ jobId: "job_kept", state: "completed", createdAt: "2026-01-01T00:00:00Z", reportId: "rep_kept" } as any);
    await jobs.saveReport("rep_kept", { disclosure: { publishable: true } }, { id: "rep_kept", generatedAt: "2026-01-01T00:00:00Z" } as any);

    const protectedJobIds = await store.referencedJobIds();
    await jobs.prune({ maxJobs: 0, maxReports: 0, protectedJobIds, protectedReportIds: new Set(["rep_kept"]) });
    expect(await jobs.loadJob("job_kept")).not.toBeNull();
    expect(await jobs.loadReport("rep_kept")).not.toBeNull();
  });
});
