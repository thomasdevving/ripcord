/**
 * Day-7 exit-restriction tests.
 *
 * The fork engine itself needs anvil and is exercised live (see
 * docs/CALIBRATION.md §14), but everything AROUND it is pure and is pinned here:
 * exit-action identification (the riskiest new false-clean), the selector
 * constants (derived, never hand-copied), the route injection, and the two new
 * verdict behaviours — a fork-confirmed restrictor collapsing the window to
 * no_notice, and the strictly-gated `no_direct_restriction_found` tier.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { toFunctionSelector } from "viem";
import { identifyExitInterface, SELECTORS } from "../src/fork/exitActions.js";
import { applyExitRestriction, type ExitRestrictionResult } from "../src/report/applyExitRestriction.js";
import { composeVerdict } from "../src/report/verdict.js";
import { runExitRestrictionEngine } from "../src/fork/exitRestriction.js";
import type {
  EnumerationCompleteness,
  ExitRestriction,
  ExitWindow,
  ExitWindowAssessment,
  ExitWindowRoute,
  Report,
  TimeToExit,
} from "../src/report/schema.js";

const COMPLETE: EnumerationCompleteness = { complete: true, gaps: [], note: "complete" };
const INCOMPLETE: EnumerationCompleteness = {
  complete: false,
  gaps: [{ where: "capabilitySurface", site: { kind: "capabilitySurface", id: "" }, reason: "unevaluated" }],
  note: "partial",
};

function window(assessment: ExitWindowAssessment, routes: ExitWindowRoute[] = []): ExitWindow {
  return { rulesVersion: "0.1.0", assessment, routes, bypasses: [], checksPerformed: [], evidence: [] };
}
function timeToExit(overrides: Partial<TimeToExit> = {}): TimeToExit {
  return {
    rulesVersion: "0.1.0",
    status: "no_mechanism_detected",
    atLeastSeconds: "0",
    tight: true,
    legs: [],
    unmeasuredLegs: [],
    liquidity: { modelled: false, reason: "not modelled" },
    blockable: { status: "not_observed", by: [], note: "", evidence: [] },
    confidence: "high",
    statement: "",
    evidence: [],
    ...overrides,
  };
}
function exitRestriction(overrides: Partial<ExitRestriction> = {}): ExitRestriction {
  return {
    rulesVersion: "0.1.0",
    attempted: true,
    archetype: "test",
    outcome: "no_direct_restriction_found",
    exitAction: { status: "identified", interfaceName: "compound-comet-base", signature: "withdraw(address,uint256)", selector: SELECTORS.cometWithdraw, confidence: "high", note: "", evidence: [] },
    baseline: { status: "established", holder: "0x000000000000000000000000000000000000abc1", holderSource: "funded", note: "", evidence: [] },
    candidates: [],
    restrictors: [],
    coverage: { guardedTotal: 1, evaluated: 1 },
    restrictionState: "none_found",
    confirmationMethod: "fork_confirmed",
    forkBlock: "25800000",
    sandboxNote: "sandbox",
    ceiling: ["exit-action id ceiling", "argument-space ceiling", "indirect/economic ceiling"],
    reproduceCommand: null,
    evidence: [],
    ...overrides,
  };
}

describe("exit-action identification", () => {
  it("matches the Comet base interface only when the full fingerprint is present", () => {
    const full = [SELECTORS.cometSupply, SELECTORS.cometBaseToken, SELECTORS.cometIsWithdrawPaused, "0xdeadbeef"];
    expect(identifyExitInterface(full)?.id).toBe("compound-comet-base");
    // A partial fingerprint is NOT a match — testing a guessed exit is the risk.
    expect(identifyExitInterface([SELECTORS.cometSupply, SELECTORS.cometBaseToken])).toBeNull();
    expect(identifyExitInterface(["0x11111111", "0x22222222"])).toBeNull();
  });

  it("is case-insensitive on selector hex", () => {
    const upper = [SELECTORS.cometSupply.toUpperCase(), SELECTORS.cometBaseToken.toUpperCase(), SELECTORS.cometIsWithdrawPaused.toUpperCase()];
    expect(identifyExitInterface(upper)?.id).toBe("compound-comet-base");
  });
});

describe("exit-action selectors are derived, not hand-copied", () => {
  const cases: [keyof typeof SELECTORS, string][] = [
    ["cometSupply", "supply(address,uint256)"],
    ["cometWithdraw", "withdraw(address,uint256)"],
    ["cometBaseToken", "baseToken()"],
    ["cometIsWithdrawPaused", "isWithdrawPaused()"],
    ["cometPauseGuardian", "pauseGuardian()"],
    ["cometPause", "pause(bool,bool,bool,bool,bool)"],
  ];
  for (const [key, sig] of cases) {
    it(`${key} === selector(${sig})`, () => {
      expect(SELECTORS[key]).toBe(toFunctionSelector(sig));
    });
  }
});

describe("verdict: a fork-confirmed restrictor collapses the window", () => {
  const restrictorRoute: ExitWindowRoute = {
    label: "exit-restrictor:pauseGuardian",
    rolePrivilege: "not_a_role",
    rolePrivilegeNote: "fork-confirmed",
    root: "0x000000000000000000000000000000000000dEaD",
    effectiveController: "0x000000000000000000000000000000000000dEaD",
    effectiveControllerType: "safe",
    terminationReason: "safe",
    noticeStatus: "immediate",
    noticeSeconds: "0",
    nominalDelaySeconds: "0",
    timelock: null,
    categories: ["ACCESS_RESTRICTION"],
    confidence: "high",
    note: "fork-confirmed",
    confirmationMethod: "fork_confirmed",
    restrictionState: "restrictable",
  };
  const er = exitRestriction({
    outcome: "restrictor_found",
    restrictionState: "restrictable",
    restrictors: [{ selector: SELECTORS.cometPause, signature: "pause(bool,bool,bool,bool,bool)", category: "ACCESS_RESTRICTION", guardingParty: "0x000000000000000000000000000000000000dEaD", guardingPartyType: "safe", args: "withdraw-pause = true", result: "restrictor", noticeSeconds: "0", detail: "confirmed", evidence: [] }],
    candidates: [],
  });

  it("no_notice statement carries the open-but-closable framing", () => {
    const v = composeVerdict(window({ status: "no_notice", confidence: "high", statement: "zero" }, [restrictorRoute]), timeToExit(), COMPLETE, er);
    expect(v.status).toBe("no_notice");
    expect(v.statement).toContain("trapped at any moment");
    expect(v.statement).not.toContain("already trapped\"");
  });

  it("distinguishes already-shut from closable", () => {
    const shut = exitRestriction({ ...er, restrictionState: "already_shut" });
    const v = composeVerdict(window({ status: "no_notice", confidence: "high", statement: "zero" }, [restrictorRoute]), timeToExit(), COMPLETE, shut);
    expect(v.statement).toContain("ALREADY shut");
  });
});

describe("verdict: the graded positive tier is strictly gated", () => {
  const undeterminedWindow = window({ status: "undetermined", missing: ["x"], citedGapSites: [], confidence: "low", statement: "undet" });

  it("fires only when exit action identified, baseline established, coverage complete, window otherwise undetermined", () => {
    const v = composeVerdict(undeterminedWindow, timeToExit(), COMPLETE, exitRestriction());
    expect(v.status).toBe("no_direct_restriction_found");
    expect(v.statement).toContain("NOT a guarantee");
    // The ceiling is what's missing — a scoped claim must not read as unbounded.
    expect(v.missing.length).toBe(3);
  });

  it("does NOT fire when the baseline was not established", () => {
    const v = composeVerdict(undeterminedWindow, timeToExit(), COMPLETE, exitRestriction({ baseline: { status: "unestablished", holder: null, holderSource: "", note: "", evidence: [] } }));
    expect(v.status).toBe("undetermined");
  });

  it("does NOT fire when a guarded function was left unevaluated", () => {
    const v = composeVerdict(undeterminedWindow, timeToExit(), COMPLETE, exitRestriction({ coverage: { guardedTotal: 3, evaluated: 1 } }));
    expect(v.status).toBe("undetermined");
  });

  it("does NOT fire when the exit action was unconfident", () => {
    const v = composeVerdict(undeterminedWindow, timeToExit(), COMPLETE, exitRestriction({ outcome: "exit_action_unconfident", exitAction: { status: "unconfident", interfaceName: "none", signature: null, selector: null, confidence: "low", note: "", evidence: [] } }));
    expect(v.status).toBe("undetermined");
  });

  it("never softens a static no_notice into the positive tier", () => {
    // Even a clean fork run cannot override a statically-found zero-notice route.
    const v = composeVerdict(window({ status: "no_notice", confidence: "high", statement: "zero" }, []), timeToExit(), COMPLETE, exitRestriction());
    expect(v.status).toBe("no_notice");
  });

  it("is withheld on an incomplete enumeration (an unevaluated surface withholds the reassuring tier)", () => {
    // Enumeration incomplete → the positive tier must not stand; missing[] carries the gap.
    const v = composeVerdict(undeterminedWindow, timeToExit(), INCOMPLETE, exitRestriction());
    // The tier still computes, but composeVerdict appends the enumeration gap to missing,
    // and verify-pages treats no_direct_restriction_found as reassuring → blocked there.
    expect(v.missing.some((m) => m.includes("capabilitySurface") || m.includes("could not be shown complete"))).toBe(true);
  });
});

describe("applyExitRestriction merges into a real report and re-composes", () => {
  const base: Report = JSON.parse(readFileSync("calibration/reports/dai.json", "utf8"));

  it("injects a fork-confirmed zero-notice route and drives the verdict to no_notice", () => {
    const route: ExitWindowRoute = {
      label: "exit-restrictor:pauseGuardian",
      rolePrivilege: "not_a_role",
      rolePrivilegeNote: "fork-confirmed",
      root: "0x000000000000000000000000000000000000dEaD",
      effectiveController: "0x000000000000000000000000000000000000dEaD",
      effectiveControllerType: "safe",
      terminationReason: "safe",
      noticeStatus: "immediate",
      noticeSeconds: "0",
      nominalDelaySeconds: "0",
      timelock: null,
      categories: ["ACCESS_RESTRICTION"],
      confidence: "high",
      note: "fork-confirmed",
      confirmationMethod: "fork_confirmed",
      restrictionState: "restrictable",
    };
    const result: ExitRestrictionResult = {
      exitRestriction: exitRestriction({ outcome: "restrictor_found", restrictionState: "restrictable", restrictors: [{ selector: SELECTORS.cometPause, signature: "pause(bool,bool,bool,bool,bool)", category: "ACCESS_RESTRICTION", guardingParty: "0x000000000000000000000000000000000000dEaD", guardingPartyType: "safe", args: "withdraw-pause = true", result: "restrictor", noticeSeconds: "0", detail: "confirmed", evidence: [] }] }),
      restrictorRoute: route,
    };
    const merged = applyExitRestriction(base, result);
    expect(merged.exitWindow?.assessment.status).toBe("no_notice");
    expect(merged.exitWindow?.routes.some((r) => r.confirmationMethod === "fork_confirmed")).toBe(true);
    expect(merged.verdict?.status).toBe("no_notice");
    expect(merged.exitRestriction?.outcome).toBe("restrictor_found");
    // Pure recomposition: it does not touch the base report's other stages.
    expect(merged.capabilities).toBe(base.capabilities);
  });

  it("a no-restrictor result attaches the evaluation without injecting a route", () => {
    const result: ExitRestrictionResult = { exitRestriction: exitRestriction(), restrictorRoute: null };
    const merged = applyExitRestriction(base, result);
    expect(merged.exitWindow?.routes.some((r) => r.confirmationMethod === "fork_confirmed")).toBe(false);
    expect(merged.exitRestriction?.outcome).toBe("no_direct_restriction_found");
  });
});

describe("engine refuses to run against an unidentified exit action", () => {
  it("returns exit_action_unconfident without spawning a fork when no interface matches", async () => {
    const result = await runExitRestrictionEngine({
      chainId: 1,
      rpcUrl: "http://127.0.0.1:1", // never contacted: identification fails first
      blockNumber: 25800000n,
      target: "0x000000000000000000000000000000000000dEaD",
      capabilities: {
        taxonomyVersion: "x",
        dispatcherRecognized: true,
        scannedAddress: "0x000000000000000000000000000000000000dEaD",
        probedAddress: "0x000000000000000000000000000000000000dEaD",
        selectorsExtracted: 1,
        unmatchedSelectors: ["0x11111111"],
        findings: [],
        needsManualVerification: [],
        evidence: [],
      },
      exitWindow: null,
      authorityResolution: null,
    });
    expect(result.exitRestriction.outcome).toBe("exit_action_unconfident");
    expect(result.restrictorRoute).toBeNull();
  });
});
