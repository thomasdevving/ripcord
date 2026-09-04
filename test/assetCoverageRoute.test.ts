/**
 * THE COVERAGE ROUTE, END TO END OVER HTTP.
 *
 * Every link in the second Mobula layer had unit tests; the SEAM between them
 * had none. `/api/reports/:id/coverage` is where the sidecar, the committed
 * snapshot and the publication gate meet, and it makes a real decision: WHICH
 * snapshot the reader is shown. Getting that wrong shows a stale vendor
 * observation under a fresh run's heading.
 *
 * Network-free: the route composes artifacts that already exist and performs no
 * fetch, chain read or fork.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore } from "../server/jobs/store.js";
import { JobManager } from "../server/jobs/manager.js";
import { ReportService } from "../server/reports.js";
import { registerRoutes } from "../server/routes.js";
import { loadConfig } from "../server/config.js";
import type { AssetContextArtifact } from "../server/asset-context.js";

const TARGET = "0xc3d688B66703497DAA19211EEdff47f25384cdc3";
const LINK = "0x514910771af9ca656af840dff83e8264ecf986ca";

let dir: string;
let app: ReturnType<typeof Fastify>;
let store: JobStore;
let manager: JobManager;
let report: Record<string, unknown>;

const exposure = (fetchedAt: string, symbol: string) => ({
  liveLayerVersion: "0.4.0",
  fetchedAt,
  target: TARGET,
  chainId: 1,
  status: "ok" as const,
  reason: null,
  exposureUsd: null,
  countedHoldings: 1,
  vendorReportedTotalUsd: null,
  holdingsCount: 1,
  chainCount: 1,
  chains: ["evm:1"],
  holdings: [{
    chainId: "evm:1", address: LINK, isNative: false,
    unverifiedSymbol: symbol, unverifiedName: symbol, logo: null,
    amount: 1, valuation: { basis: "single_source", usd: 1, source: "test" },
    holdingsQuoteUsd: 1, priceQuoteUsd: 1, liquidityUsd: null, chains: [], outsideCuratedList: true,
  }],
  withheld: [],
  concentration: null,
  floorUsd: 1,
  cap: 12,
  endpoints: { holdings: true, price: true, metadata: true },
  notes: [],
});

const sidecar = (over: Partial<AssetContextArtifact> = {}): AssetContextArtifact => ({
  assetContextVersion: "0.1.0",
  runId: "run-1",
  reportId: "rep_live",
  target: TARGET,
  chainId: 1,
  block: { number: "25800000", hash: "0xblockhash" },
  requestedAt: "2026-09-04T10:00:00.000Z",
  completedAt: "2026-09-04T10:00:05.000Z",
  status: "complete",
  exposure: exposure("2026-09-04T10:00:00.000Z", "FRESH") as never,
  candidates: [],
  counts: { displayed: 1, eligible: 0, verified: 0, failed: 0 },
  forkScenarios: { requested: false, status: "not_requested", batch: null, note: "not requested" },
  notes: ["fresh run"],
  ...over,
});

const coverage = async (id: string) => {
  const response = await app.inject({ method: "GET", url: `/api/reports/${id}/coverage` });
  return { status: response.statusCode, body: response.body, json: () => response.json() };
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ripcord-coverage-route-"));
  store = new JobStore(dir);
  await store.init();
  const config = loadConfig({ RIPCORD_DATA_DIR: dir });
  manager = new JobManager(config, store, "unused-worker");
  await manager.init();
  // A COMMITTED snapshot for this target, so "fall back to old data" is a
  // branch that can actually be taken. Without one, `committed` is always null
  // and the fallback assertions below would pass no matter what the route did.
  const liveDir = join(dir, "live");
  await mkdir(liveDir, { recursive: true });
  await writeFile(join(liveDir, "committed.json"), JSON.stringify(exposure("2020-01-01T00:00:00.000Z", "STALE")), "utf8");
  const reports = new ReportService(store, join(dir, "calibration"), undefined, liveDir);
  await reports.init();
  await reports.indexLiveSidecars();
  app = Fastify();
  registerRoutes(app, { config, manager, reports, anvil: { available: false, version: null } } as never);
  report = JSON.parse(await readFile("calibration/reports/compound-comet-cusdcv3.json", "utf8"));
});

afterEach(async () => {
  await manager.shutdown();
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("GET /api/reports/:id/coverage", () => {
  it("serves coverage for a stored publishable report with no sidecar at all", async () => {
    await store.saveReport("rep_live", report, { id: "rep_live", publishable: true } as never);
    const result = await coverage("rep_live");

    expect(result.status).toBe(200);
    const provenance = result.json().coverage.provenance;
    // No refresh was requested, so the panel must say exactly that — never
    // "pending", which would make a browser poll for something never started.
    expect(provenance.candidateVerification.status).toBe("not_requested");
    expect(provenance.candidateFork.status).toBe("not_requested");
    expect(provenance.analysisBlock).toBe(report.block!["number" as never]);
  });

  it("reports a requested-but-missing sidecar as pending rather than as absent", async () => {
    await store.saveReport("rep_live", report, { id: "rep_live", publishable: true, refreshAssetContext: true } as never);
    const result = await coverage("rep_live");
    expect(result.json().coverage.provenance.candidateVerification.status).toBe("pending");
  });

  it("shows the committed snapshot while a refresh is pending, and the fresh one once it completes", async () => {
    await store.saveReport("rep_live", report, { id: "rep_live", publishable: true, refreshAssetContext: true } as never);

    // Pending: the fresh snapshot does not exist yet, so nothing may be shown
    // under its heading. The committed one is absent here, so the panel simply
    // reports no vendor data rather than inventing some.
    await store.saveAssetContext("rep_live", sidecar({ status: "pending", exposure: null, completedAt: null }));
    const pending = await coverage("rep_live");
    expect(pending.json().coverage.provenance.candidateVerification.status).toBe("pending");
    // The committed snapshot may still be shown WHILE the refresh runs — but
    // under its own, older timestamp, never the new run's.
    expect(pending.json().coverage.provenance.mobulaFetchedAt).toBe("2020-01-01T00:00:00.000Z");
    expect(pending.body).toContain("STALE");

    // Complete: the run's OWN snapshot is authoritative, with its OWN timestamp.
    await store.saveAssetContext("rep_live", sidecar());
    const complete = await coverage("rep_live");
    const provenance = complete.json().coverage.provenance;
    expect(provenance.candidateVerification.status).toBe("complete");
    expect(provenance.mobulaFetchedAt).toBe("2026-09-04T10:00:00.000Z");
    expect(complete.body).toContain("FRESH");
    expect(complete.body).not.toContain("STALE");
  });

  it("does not silently fall back to older data when the refresh was unavailable", async () => {
    // THE TWO-CLOCK RULE. An unavailable refresh must read as unavailable. If
    // it quietly reverted to a committed snapshot, the page would show an old
    // observation as though it belonged to this run.
    await store.saveReport("rep_live", report, { id: "rep_live", publishable: true, refreshAssetContext: true } as never);
    await store.saveAssetContext("rep_live", sidecar({ status: "unavailable", exposure: null, notes: ["vendor down"] }));

    const result = await coverage("rep_live");
    const provenance = result.json().coverage.provenance;
    expect(provenance.candidateVerification.status).toBe("unavailable");
    // The decisive assertion: the older committed snapshot is NOT substituted.
    expect(provenance.mobulaFetchedAt).toBeNull();
    expect(provenance.mobulaStatus).toBe("absent");
    expect(result.body).not.toContain("STALE");
    expect(result.body).not.toContain("FRESH");
  });

  it("keeps the candidate fork labelled experimental over the wire", async () => {
    await store.saveReport("rep_live", report, { id: "rep_live", publishable: true, refreshAssetContext: true } as never);
    await store.saveAssetContext("rep_live", sidecar());
    expect((await coverage("rep_live")).json().coverage.provenance.candidateFork.experimental).toBe(true);
  });

  it("withholds coverage for a disclosure-blocked report, sidecar or not", async () => {
    // The gate is enforced once, for every outward transport. A sidecar must
    // not become a side channel around it.
    await store.saveReport(
      "rep_blocked",
      { ...report, disclosure: { publishable: false } },
      { id: "rep_blocked", publishable: false, refreshAssetContext: true } as never,
    );
    await store.saveAssetContext("rep_blocked", sidecar({ reportId: "rep_blocked" }));

    const result = await coverage("rep_blocked");
    expect(result.status).toBe(451);
    // Not one byte of the sidecar's content, including the vendor's own labels.
    expect(result.body).not.toContain("FRESH");
    expect(result.body).not.toContain(LINK);
    expect(result.json().coverage).toBeUndefined();
  });

  it("answers 404 for an unknown report so a browser stops polling", async () => {
    const result = await coverage("rep_missing");
    expect(result.status).toBe(404);
  });

  it("never exposes the run id or any server-side path to the browser", async () => {
    await store.saveReport("rep_live", report, { id: "rep_live", publishable: true, refreshAssetContext: true } as never);
    await store.saveAssetContext("rep_live", sidecar());
    const body = (await coverage("rep_live")).body;
    expect(body).not.toContain("run-1");
    expect(body).not.toContain(dir);
  });

  it("serves the enriched assessment beside the coverage, with the verdict untouched", async () => {
    await store.saveReport("rep_live", report, { id: "rep_live", publishable: true, refreshAssetContext: true } as never);
    await store.saveAssetContext("rep_live", sidecar());

    const result = await coverage("rep_live");
    const body = result.json();
    expect(body.enriched).toBeDefined();
    expect(body.enriched.changesVerdict).toBe(false);
    // Quoted from the report, so the two artifacts cannot drift apart.
    expect(body.enriched.provenance.reportVerdict).toBe((report as { verdict: { status: string } }).verdict.status);
    // The report body served elsewhere is untouched by any of this.
    const raw = await app.inject({ method: "GET", url: "/api/reports/rep_live" });
    expect(raw.json().report.verdict.status).toBe((report as { verdict: { status: string } }).verdict.status);
  });

  it("withholds the enriched assessment for a blocked report too", async () => {
    await store.saveReport(
      "rep_blocked",
      { ...report, disclosure: { publishable: false } },
      { id: "rep_blocked", publishable: false, refreshAssetContext: true } as never,
    );
    await store.saveAssetContext("rep_blocked", sidecar({ reportId: "rep_blocked" }));
    const result = await coverage("rep_blocked");
    expect(result.status).toBe(451);
    expect(result.json().enriched).toBeUndefined();
  });
});
