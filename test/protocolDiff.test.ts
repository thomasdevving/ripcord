import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { compareReports } from "../server/protocol-diff.js";
import type { Report } from "../src/report/schema.js";

const report = (name: string): Report => {
  const value = JSON.parse(readFileSync(`calibration/reports/${name}.json`, "utf8")) as Record<string, any>;
  // Calibration artifacts preserve the schema that produced them. This test
  // exercises today's comparator, so add only the current metadata fields; it
  // does not rewrite any interpreted finding used by the assertions below.
  value.budget ??= null;
  const analyzer = { name: "evmole", version: "0.9.3" };
  if (value.capabilities) value.capabilities.selectorAnalyzer ??= analyzer;
  for (const token of value.dependencies?.tokens ?? []) token.capabilities.selectorAnalyzer ??= analyzer;
  return value as Report;
};
const compare = (before: Report, after: Report) => compareReports({
  targetId: "target_0123456789abcdef",
  label: "Target",
  beforeReportId: "rep_before",
  afterReportId: "rep_after",
  before,
  after,
});

describe("semantic protocol comparison", () => {
  it("ignores transport time and evidence ordering when the interpreted state is unchanged", () => {
    const before = report("compound-comet-cusdcv3");
    const after = structuredClone(before);
    after.generatedAt = "2099-01-01T00:00:00.000Z";
    after.proxy.evidence.reverse();
    after.exitWindow?.evidence.reverse();
    expect(compare(before, after).changes).toEqual([]);
  });

  it("records implementation, authority and capability-guard changes separately", () => {
    const before = report("paid-network-token-proxy-2");
    const after = structuredClone(before);
    after.proxy.implementation = `0x${"11".repeat(20)}`;
    if (!after.authority.owner) throw new Error("fixture must carry an owner");
    after.authority.owner.address = `0x${"22".repeat(20)}`;
    const capability = after.capabilities.findings[0];
    if (!capability || capability.guard.status !== "attributed") throw new Error("fixture must carry an attributed capability");
    capability.guard.holders = [`0x${"33".repeat(20)}`];

    const changes = compare(before, after).changes;
    expect(changes.map((item) => item.kind)).toEqual(expect.arrayContaining(["proxy", "authority", "capability"]));
    expect(changes.every((item) => item.attention === "high")).toBe(true);
    expect(changes.find((item) => item.kind === "capability")?.after).toContain("333333");
  });

  it("records role membership and analysis coverage without treating either as missing", () => {
    const before = report("aave-v3-acl-manager");
    const after = structuredClone(before);
    const role = after.authority.accessControl?.roles[0];
    if (!role) throw new Error("fixture must carry a role");
    role.members.push(`0x${"44".repeat(20)}`);
    after.capabilities.unmatchedSelectors.push("0x12345678");

    const changes = compare(before, after).changes;
    expect(changes.some((item) => item.kind === "role_membership")).toBe(true);
    const coverage = changes.find((item) => item.kind === "analysis_coverage");
    expect(coverage?.after).toContain("unmatched selector");
  });

  it("does not lose a privilege change one hop down in a dependency", () => {
    const before = report("compound-comet-cusdcv3");
    const after = structuredClone(before);
    const dependency = after.dependencies.tokens[0];
    if (!dependency) throw new Error("fixture must carry a token dependency");
    dependency.proxy.admin = `0x${"66".repeat(20)}`;
    expect(compare(before, after).changes.some((item) => item.kind === "dependency")).toBe(true);
  });

  it("refuses to compare artifacts for different targets", () => {
    const before = report("weth9");
    const after = structuredClone(before);
    after.target.address = `0x${"55".repeat(20)}`;
    expect(() => compare(before, after)).toThrow(/same chain and target/);
  });
});
