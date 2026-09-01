/**
 * Verdict composition tests.
 *
 * `composeVerdict` is a pure function precisely so its rules can be tested
 * exhaustively without a network, because the rules — not the readings — are
 * what an auditor will argue with. The cases below are the arguments:
 * a dead heat is trapped, uncertainty can push toward caution but never away
 * from it, and a zero window collapses the comparison instead of computing it.
 */
import { describe, expect, it } from "vitest";
import { composeVerdict, humanDuration } from "../src/report/verdict.js";
import type { ExitWindow, ExitWindowAssessment, TimeToExit } from "../src/report/schema.js";

function window(assessment: ExitWindowAssessment): ExitWindow {
  return {
    rulesVersion: "0.1.0",
    assessment,
    routes: [],
    bypasses: [],
    checksPerformed: [],
    evidence: [],
  };
}

function exit(overrides: Partial<TimeToExit>): TimeToExit {
  return {
    rulesVersion: "0.1.0",
    status: "measured",
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

const binding = (seconds: string) =>
  window({ status: "binding", windowSeconds: seconds, confidence: "high", statement: "w" });

describe("verdict composition", () => {
  it("states the comparison directly when both sides are known and the exit is faster", () => {
    const v = composeVerdict(binding("172800"), exit({ atLeastSeconds: "0", tight: true }));
    expect(v.status).toBe("can_exit_in_time");
    expect(v.marginSeconds).toBe("172800");
    expect(v.statement).toContain("2 days");
    // Capability, not intent.
    expect(v.statement).toContain("CAN change");
    expect(v.statement).not.toMatch(/\bwill change\b/);
  });

  it("reports TRAPPED when leaving takes longer than the notice", () => {
    const v = composeVerdict(binding("86400"), exit({ atLeastSeconds: "604800", tight: true }));
    expect(v.status).toBe("trapped");
    expect(v.marginSeconds).toBe("-518400");
    expect(v.statement).toContain("cannot exit before the rules CAN change");
  });

  it("treats an EXACT tie as trapped, and says it is a dead heat", () => {
    // The live case this rule exists for: sUSDe's 86400s cooldown against its
    // owner-timelock's 86400s minimum delay. You finish leaving at the instant
    // the change becomes effective, which is not leaving before it.
    const v = composeVerdict(binding("86400"), exit({ atLeastSeconds: "86400", tight: true }));
    expect(v.status).toBe("trapped");
    expect(v.marginSeconds).toBe("0");
    expect(v.statement).toContain("Dead heat");
  });

  it("collapses the comparison — not computes it — when the window is zero", () => {
    const v = composeVerdict(
      window({ status: "no_notice", confidence: "high", statement: "zero" }),
      exit({ atLeastSeconds: "0", tight: true }),
    );
    expect(v.status).toBe("no_notice");
    expect(v.exitWindowSeconds).toBe("0");
    // No margin is published, because no arithmetic was performed.
    expect(v.marginSeconds).toBeNull();
  });

  it("refuses 'can exit in time' when the exit bound is not tight — uncertainty must not buy a good verdict", () => {
    const v = composeVerdict(
      binding("172800"),
      exit({
        status: "lower_bound",
        atLeastSeconds: "3600",
        tight: false,
        unmeasuredLegs: [{ name: "requestWithdrawals → claimWithdrawals", reason: "queue length unreadable" }],
      }),
    );
    expect(v.status).toBe("undetermined");
    expect(v.missing.join(" ")).toContain("unmeasured leg");
    expect(v.statement).toContain("not a zero-length one");
  });

  it("STILL reports trapped on a non-tight exit bound that already exceeds the window — uncertainty may push toward caution", () => {
    const v = composeVerdict(
      binding("86400"),
      exit({ status: "lower_bound", atLeastSeconds: "604800", tight: false, unmeasuredLegs: [{ name: "x", reason: "y" }] }),
    );
    expect(v.status).toBe("trapped");
  });

  it("can conclude trapped even against an UNPROVEN delay, because the real window can only be shorter", () => {
    const v = composeVerdict(
      window({
        status: "not_proven_binding",
        nominalDelaySeconds: "86400",
        missing: ["mutator guard unreadable"],
        confidence: "medium",
        statement: "s",
      }),
      exit({ atLeastSeconds: "172800", tight: true }),
    );
    expect(v.status).toBe("trapped");
    // The window itself is still never asserted as a number.
    expect(v.exitWindowSeconds).toBeNull();
    expect(v.statement).toContain("can only make the real window SHORTER");
  });

  it("degrades to undetermined when an unproven delay is LONGER than the exit", () => {
    const v = composeVerdict(
      window({
        status: "not_proven_binding",
        nominalDelaySeconds: "604800",
        missing: ["mutator guard unreadable"],
        confidence: "medium",
        statement: "s",
      }),
      exit({ atLeastSeconds: "3600", tight: true }),
    );
    expect(v.status).toBe("undetermined");
    expect(v.missing).toContain("mutator guard unreadable");
  });

  it("degrades honestly when the exit side is undetermined", () => {
    const v = composeVerdict(binding("172800"), exit({ status: "undetermined", atLeastSeconds: null, tight: false }));
    expect(v.status).toBe("undetermined");
    expect(v.exitWindowSeconds).toBeNull();
    expect(v.missing.join(" ")).toContain("time to exit could not be determined");
  });

  it("names what is missing when a stage did not run at all", () => {
    const v = composeVerdict(null, exit({}));
    expect(v.status).toBe("undetermined");
    expect(v.missing.join(" ")).toContain("exit-window stage did not run");
  });

  it("carries no_rule_change_route_found through with its caveats", () => {
    const v = composeVerdict(
      window({
        status: "no_rule_change_route_found",
        caveats: ["not a proof of immutability"],
        confidence: "medium",
        statement: "s",
      }),
      exit({}),
    );
    expect(v.status).toBe("no_rule_change_route_found");
    expect(v.statement).toContain("not a proof of immutability");
  });

  it("appends the exit-blockability warning to any verdict, including a healthy one", () => {
    const v = composeVerdict(
      binding("172800"),
      exit({ blockable: { status: "blockable", by: ["0x0000000000000000000000000000000000000001"], note: "", evidence: [] } }),
    );
    expect(v.status).toBe("can_exit_in_time");
    expect(v.statement).toContain("the exit itself can be closed");
  });

  it("says exit is currently halted when it is", () => {
    const v = composeVerdict(
      binding("172800"),
      exit({ status: "blocked", tight: false, blockable: { status: "currently_blocked", by: [], note: "", evidence: [] } }),
    );
    expect(v.statement).toContain("HALTED at the pinned block");
  });

  it("takes the weakest confidence of its inputs", () => {
    const w = window({ status: "binding", windowSeconds: "172800", confidence: "high", statement: "w" });
    expect(composeVerdict(w, exit({ confidence: "low" })).confidence).toBe("low");
    expect(composeVerdict(w, exit({ confidence: "medium" })).confidence).toBe("medium");
    expect(composeVerdict(w, exit({ confidence: "high" })).confidence).toBe("high");
  });

  it("attaches every input with its confidence and source as evidence for the verdict", () => {
    const v = composeVerdict(binding("172800"), exit({}));
    const names = v.inputs.map((i) => i.name);
    expect(names).toContain("exitWindow.assessment.status");
    expect(names).toContain("exitWindow.windowSeconds");
    expect(names).toContain("timeToExit.atLeastSeconds");
    expect(names).toContain("timeToExit.liquidity.modelled");
    expect(v.inputs.every((i) => i.source.length > 0)).toBe(true);
  });

  it("never claims a window value in a status that has none", () => {
    const v = composeVerdict(
      window({ status: "not_proven_binding", nominalDelaySeconds: "86400", missing: [], confidence: "low", statement: "s" }),
      exit({ atLeastSeconds: "0", tight: true }),
    );
    const windowInput = v.inputs.find((i) => i.name === "exitWindow.windowSeconds")!;
    expect(windowInput.value).toBeNull();
    expect(windowInput.source).toContain("never expressed as a window");
  });
});

describe("humanDuration", () => {
  it("renders whole days, hours and seconds without inventing precision", () => {
    expect(humanDuration(0n)).toBe("0s");
    expect(humanDuration(86_400n)).toBe("1 day");
    expect(humanDuration(172_800n)).toBe("2 days");
    expect(humanDuration(129_600n)).toBe("1.5 days");
    expect(humanDuration(3_600n)).toBe("1 hour");
    expect(humanDuration(90n)).toBe("90s");
  });
});
