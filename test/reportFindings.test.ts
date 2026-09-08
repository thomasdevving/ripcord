/**
 * The overview projection.
 *
 * The thing worth pinning is not that a list appears — it is that the list
 * never says more than the report did. Three properties carry that:
 *
 *  1. `"0"` AND `null` MUST NOT MERGE. A measured zero notice is a demonstrated
 *     finding; an unestablished one is unresolved. Collapsing them is this
 *     project's oldest failure shape, and a table of contents is a cheap place
 *     to rebuild it.
 *  2. AN UNRESOLVED ENTRY IS NEVER DROPPED. A clean-looking overview over a
 *     report full of gaps is a false-clean reached through presentation.
 *  3. A LINK NAMES A DESTINATION, NOT A CLAIM — and when it names a node it
 *     must be the address the finding is about.
 */
import { describe, it, expect } from "vitest";
import { deriveReportFindings } from "../server/shared/findings.js";
import type { Report } from "../src/report/schema.js";

/** A report is large; each test states only the fields its property depends on. */
function reportWith(parts: Record<string, unknown>): Report {
  return parts as unknown as Report;
}

const route = (parts: Record<string, unknown>) => ({
  label: "owner",
  rolePrivilege: "not_a_role",
  rolePrivilegeNote: "",
  root: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  effectiveController: null,
  effectiveControllerType: null,
  terminationReason: "eoa",
  noticeStatus: "immediate",
  noticeSeconds: "0",
  nominalDelaySeconds: null,
  timelock: null,
  categories: [],
  confidence: "high",
  note: "terminates at an EOA",
  confirmationMethod: "static",
  restrictionState: null,
  ...parts,
});

describe("deriveReportFindings", () => {
  it("reports a measured zero notice as demonstrated, and links to the address it names", () => {
    const findings = deriveReportFindings(
      reportWith({ exitWindow: { routes: [route({ noticeSeconds: "0" })], checksPerformed: [] } }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("demonstrated");
    expect(findings[0]!.link.tab).toBe("power");
    expect(findings[0]!.link.node).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("does NOT read an unestablished notice as a zero one", () => {
    const findings = deriveReportFindings(
      reportWith({ exitWindow: { routes: [route({ noticeSeconds: null, noticeStatus: "undetermined" })], checksPerformed: [] } }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("unresolved");
    expect(findings[0]!.title).toMatch(/No notice could be established/);
  });

  it("leaves a route with a real delay out of both lists rather than describing it", () => {
    // The route is not a finding: the exit-window section states its delay in
    // full, and restating it here would be this file making a judgement.
    const findings = deriveReportFindings(
      reportWith({ exitWindow: { routes: [route({ noticeSeconds: "172800", noticeStatus: "delayed" })], checksPerformed: [] } }),
    );
    expect(findings).toHaveLength(0);
  });

  it("keeps every gap, and never lets an incomplete run produce an empty list", () => {
    const findings = deriveReportFindings(
      reportWith({
        enumeration: { complete: false, gaps: [{ where: "target", site: { kind: "target", id: "" }, reason: "role scan partial" }], note: "" },
        errors: [{ stage: "accessControl", message: "provider timed out" }],
        capabilities: { findings: [], needsManualVerification: [], unmatchedSelectors: ["0x12345678"] },
      }),
    );
    expect(findings.every((f) => f.severity === "unresolved")).toBe(true);
    expect(findings.map((f) => f.source).sort()).toEqual(["Capabilities", "Enumeration", "Infrastructure"]);
  });

  it("routes a fork-confirmed restrictor to the fork pane, at its own candidate", () => {
    const findings = deriveReportFindings(
      reportWith({
        exitRestriction: {
          attempted: true,
          baseline: { status: "established", note: "" },
          candidates: [
            { selector: "0x1", signature: "pause(bool)", guardingParty: "0xBBBB", result: "restrictor", detail: "exit closed", args: "", evidence: [] },
          ],
          evaluationGaps: [],
        },
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("demonstrated");
    expect(findings[0]!.link).toMatchObject({ tab: "fork", anchor: "candidate-0", node: "0xbbbb" });
  });

  it("orders demonstrated entries before unresolved ones", () => {
    const findings = deriveReportFindings(
      reportWith({
        exitWindow: { routes: [route({ noticeSeconds: null, noticeStatus: "undetermined" }), route({})], checksPerformed: [] },
      }),
    );
    expect(findings.map((f) => f.severity)).toEqual(["demonstrated", "unresolved"]);
  });
});
