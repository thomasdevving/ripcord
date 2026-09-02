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
import type { EnumerationCompleteness, ExitWindow, ExitWindowAssessment, TimeToExit } from "../src/report/schema.js";

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

const WITNESS = { complete: true as const, basis: "every enumeration site reported complete" };
/** "Enumeration was complete" — the precondition a reassuring verdict now requires. */
const COMPLETE: EnumerationCompleteness = { complete: true, gaps: [], note: "complete" };
/** "Enumeration was partial" — one unseen role scan is enough. */
const PARTIAL: EnumerationCompleteness = {
  complete: false,
  gaps: [
    {
      where: "authority:0xabc (depth 1, via owner)",
      site: { kind: "authority", id: "0xabc" },
      reason: "covered only a recent window",
    },
  ],
  note: "partial",
};

const binding = (seconds: string) =>
  window({ status: "binding", windowSeconds: seconds, enumeration: WITNESS, confidence: "high", statement: "w" });

describe("verdict composition", () => {
  it("states the comparison directly when both sides are known and the exit is faster", () => {
    const v = composeVerdict(binding("172800"), exit({ atLeastSeconds: "0", tight: true }), COMPLETE);
    expect(v.status).toBe("can_exit_in_time");
    expect(v.marginSeconds).toBe("172800");
    expect(v.statement).toContain("2 days");
    // Capability, not intent.
    expect(v.statement).toContain("CAN change");
    expect(v.statement).not.toMatch(/\bwill change\b/);
  });

  it("reports TRAPPED when leaving takes longer than the notice", () => {
    const v = composeVerdict(binding("86400"), exit({ atLeastSeconds: "604800", tight: true }), COMPLETE);
    expect(v.status).toBe("trapped");
    expect(v.marginSeconds).toBe("-518400");
    expect(v.statement).toContain("cannot exit before the rules CAN change");
  });

  it("treats an EXACT tie as trapped, and says it is a dead heat", () => {
    // The live case this rule exists for: sUSDe's 86400s cooldown against its
    // owner-timelock's 86400s minimum delay. You finish leaving at the instant
    // the change becomes effective, which is not leaving before it.
    const v = composeVerdict(binding("86400"), exit({ atLeastSeconds: "86400", tight: true }), COMPLETE);
    expect(v.status).toBe("trapped");
    expect(v.marginSeconds).toBe("0");
    expect(v.statement).toContain("Dead heat");
  });

  it("collapses the comparison — not computes it — when the window is zero", () => {
    const v = composeVerdict(
      window({ status: "no_notice", confidence: "high", statement: "zero" }),
      exit({ atLeastSeconds: "0", tight: true }),
      COMPLETE,
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
      COMPLETE,
    );
    expect(v.status).toBe("undetermined");
    expect(v.missing.join(" ")).toContain("unmeasured leg");
    expect(v.statement).toContain("not a zero-length one");
  });

  it("STILL reports trapped on a non-tight exit bound that already exceeds the window — uncertainty may push toward caution", () => {
    const v = composeVerdict(
      binding("86400"),
      exit({ status: "lower_bound", atLeastSeconds: "604800", tight: false, unmeasuredLegs: [{ name: "x", reason: "y" }] }),
      COMPLETE,
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
      COMPLETE,
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
      COMPLETE,
    );
    expect(v.status).toBe("undetermined");
    expect(v.missing).toContain("mutator guard unreadable");
  });

  it("degrades honestly when the exit side is undetermined", () => {
    const v = composeVerdict(binding("172800"), exit({ status: "undetermined", atLeastSeconds: null, tight: false }), COMPLETE);
    expect(v.status).toBe("undetermined");
    expect(v.exitWindowSeconds).toBeNull();
    expect(v.missing.join(" ")).toContain("time to exit could not be determined");
  });

  it("names what is missing when a stage did not run at all", () => {
    const v = composeVerdict(null, exit({}), COMPLETE);
    expect(v.status).toBe("undetermined");
    expect(v.missing.join(" ")).toContain("exit-window stage did not run");
  });

  it("leads an immutable_within_checks verdict with its BASIS and keeps its caveats in missing[]", () => {
    // The day-5 epistemic split: this status is a positive claim, so the
    // sentence must state what was ESTABLISHED, and the bound must survive into
    // `missing` rather than being dropped because the verdict looks clean.
    const v = composeVerdict(
      window({
        status: "immutable_within_checks",
        enumeration: WITNESS,
        basis: ["no DELEGATECALL in the runtime bytecode"],
        caveats: ["12 selector(s) were NOT evaluated for privilege"],
        confidence: "medium",
        statement: "s",
      }),
      exit({}),
      COMPLETE,
    );
    expect(v.status).toBe("immutable_within_checks");
    expect(v.statement).toContain("no DELEGATECALL in the runtime bytecode");
    expect(v.statement).toContain("Within the checks Ripcord performs");
    // Never opens with a reassurance — the regression this test exists for.
    expect(v.statement).not.toContain("No exit-window risk was identified");
    expect(v.missing).toContain("12 selector(s) were NOT evaluated for privilege");
  });

  it("appends the exit-blockability warning to any verdict, including a healthy one", () => {
    const v = composeVerdict(
      binding("172800"),
      exit({ blockable: { status: "blockable", by: ["0x0000000000000000000000000000000000000001"], note: "", evidence: [] } }),
      COMPLETE,
    );
    expect(v.status).toBe("can_exit_in_time");
    expect(v.statement).toContain("the exit itself can be closed");
  });

  it("says exit is currently halted when it is", () => {
    const v = composeVerdict(
      binding("172800"),
      exit({ status: "blocked", tight: false, blockable: { status: "currently_blocked", by: [], note: "", evidence: [] } }),
      COMPLETE,
    );
    expect(v.statement).toContain("HALTED at the pinned block");
  });

  it("takes the weakest confidence of its inputs", () => {
    const w = window({ status: "binding", windowSeconds: "172800", enumeration: WITNESS, confidence: "high", statement: "w" });
    expect(composeVerdict(w, exit({ confidence: "low" }), COMPLETE).confidence).toBe("low");
    expect(composeVerdict(w, exit({ confidence: "medium" }), COMPLETE).confidence).toBe("medium");
    expect(composeVerdict(w, exit({ confidence: "high" }), COMPLETE).confidence).toBe("high");
  });

  it("attaches every input with its confidence and source as evidence for the verdict", () => {
    const v = composeVerdict(binding("172800"), exit({}), COMPLETE);
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
      COMPLETE,
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

// --- enumeration completeness reaches the verdict (day 5.5) ---

describe("verdict × enumeration completeness", () => {
  it("never leaves missing[] empty while an enumeration was incomplete", () => {
    // The self-contradiction guard: a report used to be able to assert
    // `missing: []` while one of its own reconstruction blocks said the role set
    // might be incomplete. That is a credibility problem quite apart from the
    // false-clean it enabled.
    const v = composeVerdict(binding("172800"), exit({ atLeastSeconds: "0", tight: true }), PARTIAL);
    expect(v.missing.length).toBeGreaterThan(0);
    expect(v.missing.join(" ")).toContain("could not be shown complete");
  });

  it("keeps a BAD finding intact under partial enumeration — caution only, never the reverse", () => {
    // Unseen routes can only ADD ways to change the rules, and an extra route can
    // only lower the minimum notice. So `no_notice` and `trapped` stand; only the
    // reassuring branches are capped.
    const zero = composeVerdict(
      window({ status: "no_notice", confidence: "high", statement: "zero" }),
      exit({ atLeastSeconds: "0", tight: true }),
      PARTIAL,
    );
    expect(zero.status).toBe("no_notice");

    const trapped = composeVerdict(
      window({ status: "not_proven_binding", nominalDelaySeconds: "86400", missing: ["x"], confidence: "low", statement: "n" }),
      exit({ atLeastSeconds: "86400", tight: true }),
      PARTIAL,
    );
    expect(trapped.status).toBe("trapped");
  });

  it("names each gap ONCE when the assessment CITED that site", () => {
    // The assessment degrades over a gap and names that site in its own words;
    // appending a second near-identical sentence for the same site makes the
    // report look careless on exactly the finding it exists to communicate.
    // Suppression is keyed on the cited SITE KEY, never on the prose.
    const where = "authority:0xabc (depth 1, via owner)";
    const v = composeVerdict(
      window({
        status: "not_proven_binding",
        nominalDelaySeconds: "86400",
        missing: [`role enumeration at ${where} could not be shown complete, so a route with less notice may exist`],
        citedGapSites: ["authority:0xabc"],
        confidence: "low",
        statement: "n",
      }),
      exit({ atLeastSeconds: "0", tight: true }),
      PARTIAL,
    );
    expect(v.missing.filter((m) => m.includes(where))).toHaveLength(1);
  });

  it("does NOT suppress a gap the assessment merely mentions in prose without citing it", () => {
    // The structural tighten (day 6). Prose is not an identifier: an assessment
    // that talks about a site but does not CITE it has made no claim the verdict
    // can rely on, so the gap must still be named. Under the old substring
    // dedup this case was silently swallowed.
    const where = "authority:0xabc (depth 1, via owner)";
    const v = composeVerdict(
      window({
        status: "not_proven_binding",
        nominalDelaySeconds: "86400",
        missing: [`something incidental about ${where} that is not an enumeration claim`],
        citedGapSites: [],
        confidence: "low",
        statement: "n",
      }),
      exit({ atLeastSeconds: "0", tight: true }),
      PARTIAL,
    );
    expect(v.missing.some((m) => m.startsWith("role enumeration at"))).toBe(true);
  });

  it("cannot be fooled by an unrelated missing[] entry that happens to contain the site word", () => {
    // The exact collision the tighten removes. A gap whose `where` is the bare
    // word "target" sits beside an unrelated caveat that also says "target".
    // Substring dedup would suppress a REAL enumeration gap — under-reporting
    // what was not seen, which is the failure this subsystem exists to prevent,
    // reached through a cosmetic tidy-up.
    const partialTarget = {
      complete: false,
      gaps: [
        {
          where: "target",
          site: { kind: "target" as const, id: "" },
          reason: "the role scan covered only a recent window",
        },
      ],
      note: "incomplete",
    };
    const v = composeVerdict(
      window({
        status: "undetermined",
        missing: ["the target is a confirmed proxy but no authority route could be resolved"],
        citedGapSites: [],
        confidence: "low",
        statement: "n",
      }),
      exit({ atLeastSeconds: "0", tight: true }),
      partialTarget,
    );
    expect(v.missing.some((m) => m.startsWith("role enumeration at target"))).toBe(true);
  });

  it("still names a gap the assessment did NOT mention", () => {
    const v = composeVerdict(
      window({ status: "no_notice", confidence: "high", statement: "zero" }),
      exit({ atLeastSeconds: "0", tight: true }),
      PARTIAL,
    );
    expect(v.missing.join(" ")).toContain("authority:0xabc");
  });

  it("records completeness as a first-class verdict input, either way", () => {
    for (const [e, expected] of [
      [COMPLETE, "true"],
      [PARTIAL, "false"],
    ] as const) {
      const v = composeVerdict(binding("172800"), exit({ atLeastSeconds: "0", tight: true }), e);
      const input = v.inputs.find((i) => i.name === "enumeration.complete");
      expect(input?.value).toBe(expected);
    }
  });
});
