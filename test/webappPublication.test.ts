import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { publicValue, rpcSecrets } from "../server/sanitize.js";
import { TransportObserver } from "../server/jobs/observer.js";
import { forkBlocksFromReport, forkTransactions, preferLiveBlocks } from "../server/shared/fork.js";
import { formatTokenUnits } from "../web/src/report-types.js";
import { reportStructure } from "../server/report-structure.js";
import { layout } from "../web/src/components/PowerMap.js";
import type { Report } from "../src/report/schema.js";
import type { JobEventPayload } from "../server/shared/dto.js";
const report = (name: string): Report => JSON.parse(readFileSync(`calibration/reports/${name}.json`, "utf8"));

describe("web publication and evidence regressions", () => {
  it("removes nested provider credentials without changing public hex evidence", () => {
    const credential = "synthetic-provider-credential";
    const url = `https://rpc.invalid/v2/${credential}`;
    const original = { block: { hash: `0x${"ab".repeat(32)}` }, address: `0x${"cd".repeat(20)}`, errors: [{ message: `request failed ${url}` }], unknowns: [{ reason: `provider credential ${credential}` }], rawValue: "0x1234", delta: "39744687928433" };
    const projected = publicValue(original, rpcSecrets([url]));
    expect(JSON.stringify(projected)).not.toContain(credential);
    expect(projected.block).toEqual(original.block);
    expect(projected.address).toEqual(original.address);
    expect(projected.rawValue).toBe("0x1234");
    expect(original.errors[0]?.message).toContain(url);
  });
  it("does not leak capability-derived relations through a blocked report's graph or stage errors", () => {
    const r = report("paid-network-token-proxy-2");
    expect(r.disclosure.publishable).toBe(false);
    const events: JobEventPayload[] = [];
    const o = new TransportObserver(r.target.address, event => events.push(event));
    o.onPowerHolders(r.powerHolders);
    o.onAuthority(r.authorityResolution);
    o.onStageEnd({ stage: "capabilities", outcome: "degraded", detail: "PRIVATE_CAPABILITY_SIGNATURE", metrics: {} });
    expect(JSON.stringify(events)).not.toContain("capability:");
    expect(JSON.stringify(events)).not.toContain("PRIVATE_CAPABILITY_SIGNATURE");
  });
  it("restores the historical re-exit without treating the old partial baseline as a full economic proof", () => {
    const r = report("compound-comet-cusdcv3");
    const f = forkBlocksFromReport(r)!;
    expect(f.baseline?.legacy).toBe(true);
    expect(f.baseline?.established).toBeNull();
    expect(f.baseline?.transactions.some(tx => /candidate|guardian pause/.test(tx.action))).toBe(false);
    expect(f.mutation?.transactions.every(tx => tx.action === "guardian pause withdraw")).toBe(true);
    expect(f.reexit?.transactions.some(tx => tx.action === "holder withdraw after candidate")).toBe(true);
    expect(f.reexit?.detail).toBe(r.exitRestriction!.candidates[0]!.detail);
    const merged = preferLiveBlocks({ baseline: null, mutation: f.mutation, reexit: null }, r);
    expect(merged.baseline).not.toBeNull(); expect(merged.reexit).not.toBeNull();
  });
  it("restores the recorded fork guardian in the shared report graph", () => {
    const r = report("compound-comet-cusdcv3");
    const graph = reportStructure(r)!;
    const candidate = r.exitRestriction!.candidates[0]!;
    expect(graph.nodes.some(n => n.address.toLowerCase() === candidate.guardingParty?.toLowerCase())).toBe(true);
    expect(graph.edges.some(e => e.from.toLowerCase() === candidate.guardingParty?.toLowerCase() && e.label.includes("fork-confirmed"))).toBe(true);
  });
  it("does not convert an absent receipt status into a revert or a mainnet call into a fork transaction", () => {
    const e = { params: { method: "eth_sendTransaction", forkOnly: true }, rawValue: { receipt: {} } };
    expect(forkTransactions([e])[0]?.status).toBe("unknown");
    expect(forkTransactions([{ ...e, params: { method: "eth_sendTransaction" } }])).toEqual([]);
  });
  it.each([["39744687928433", 6, "39744687.928433"], ["1000000000000000001", 18, "1.000000000000000001"], ["123456789", 8, "1.23456789"], ["-1200000", 6, "-1.2"], ["90071992547409930000", 0, "90071992547409930000"]])("formats %s units losslessly", (raw, decimals, expected) => {
    expect(formatTokenUnits(String(raw), Number(decimals))).toBe(expected);
  });
  it("labels missing decimals instead of inventing token units", () => { expect(formatTokenUnits("1234", undefined)).toBe("1234 raw units"); });
  it.each(["cbeth", "lido-withdrawal-queue"])("keeps every edge connected after checksum normalization: %s", name => {
    const graph = reportStructure(report(name))!;
    const { nodes, edges } = layout(graph, null);
    expect(edges.length).toBe(graph.edges.length);
    const ids = new Set(nodes.map(n => n.id));
    expect(edges.every(e => ids.has(e.source) && ids.has(e.target))).toBe(true);
    expect(graph.nodes.some(n => n.evidence?.length)).toBe(true);
  });
});
