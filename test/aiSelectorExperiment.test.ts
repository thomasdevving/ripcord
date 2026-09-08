import { describe, expect, it } from "vitest";
import {
  agreeAcrossForks,
  classifyCandidate,
  classifyStep,
  evaluateBranchAgainstControl,
  type BranchRecord,
  type CandidateOutcome,
  type ExitObservation,
  type ExitOutcome,
  type ForkIdentity,
  type ForkRunOutcome,
  type PositionSnapshot,
  type StepClassification,
} from "../server/ai-selector/experiment.js";

const CLOCK = { block: "18000000", timestamp: "1700000000" };
const EXIT_CALL = { exitTo: "0xc3d688b66703497daa19211eedff47f25384cdc3", exitCalldata: "0xf3fef3a3" };
const FUNDED: PositionSnapshot = { tokens: "0", supplied: "50000", borrowed: "0", principal: "50000" };
const CLEARED: PositionSnapshot = { tokens: "50000", supplied: "0", borrowed: "0", principal: "0" };

function exit(outcome: ExitOutcome, over: Partial<ExitObservation> = {}): ExitObservation {
  return {
    outcome,
    receiptStatus: outcome === "transaction_reverted" || outcome === "out_of_gas" ? "reverted" : "success",
    revertData: null,
    ...CLOCK,
    ...EXIT_CALL,
    positionBefore: FUNDED,
    positionAfter: outcome === "full_exit_verified" ? CLEARED : FUNDED,
    ...over,
  };
}

const control = (outcome: ExitOutcome = "full_exit_verified"): BranchRecord => ({
  branch: "control", caller: "0xguardian", mutation: "not_applicable", positionAfterMutation: FUNDED, exit: exit(outcome),
});
const branch = (name: "unattributed" | "controller", over: Partial<BranchRecord> = {}): BranchRecord => ({
  branch: name, caller: name === "controller" ? "0xguardian" : "0xstranger",
  mutation: "succeeded", positionAfterMutation: FUNDED, exit: exit("transaction_reverted"), ...over,
});

describe("evaluateBranchAgainstControl — one rule set for every branch", () => {
  it("applies the identical requirements to the unattributed and controller branches", () => {
    // Same record, only the branch label differs — the verdict must not.
    const drift = { exit: exit("transaction_reverted", { block: "18000001" }) };
    for (const name of ["unattributed", "controller"] as const) {
      expect(evaluateBranchAgainstControl(control(), branch(name, drift)).status).toBe("clock_mismatch");
      expect(evaluateBranchAgainstControl(control(), branch(name)).status).toBe("exit_restricted");
      expect(evaluateBranchAgainstControl(control(), branch(name, { mutation: "reverted" })).status).toBe("mutation_reverted");
      expect(evaluateBranchAgainstControl(control(), branch(name, { positionAfterMutation: CLEARED })).status).toBe("position_removed_by_mutation");
    }
  });

  it("refuses to compare when the branches did not send the identical exit call", () => {
    const other = branch("controller", { exit: exit("transaction_reverted", { exitCalldata: "0xdeadbeef" }) });
    expect(evaluateBranchAgainstControl(control(), other).status).toBe("different_exit");
  });

  it("requires a FULLY verified control exit, not merely a successful one", () => {
    for (const weak of ["partial_exit", "successful_noop", "transaction_reverted"] as const) {
      expect(evaluateBranchAgainstControl(control(weak), branch("controller")).status).toBe("control_unusable");
    }
  });

  it("counts a successful no-op and a partial exit as restriction, not as a working exit", () => {
    for (const blocked of ["successful_noop", "partial_exit"] as const) {
      expect(evaluateBranchAgainstControl(control(), branch("controller", { exit: exit(blocked) })).status).toBe("exit_restricted");
    }
  });

  it("treats out-of-gas and an unreadable result as our own failure, never as a restriction", () => {
    for (const weak of ["out_of_gas", "read_failed"] as const) {
      expect(evaluateBranchAgainstControl(control(), branch("controller", { exit: exit(weak) })).status).toBe("incomplete");
    }
  });
});

describe("classifyStep — the unattributed branch is dominant", () => {
  it("reports the disclosure event even when the controller call reverted", () => {
    const result = classifyStep([control(), branch("unattributed"), branch("controller", { mutation: "reverted", exit: null })]);
    expect(result.status).toBe("unattributed_caller_restriction_observed");
  });

  it("reports the disclosure event even when the controller call had no effect", () => {
    const result = classifyStep([control(), branch("unattributed"), branch("controller", { exit: exit("full_exit_verified") })]);
    expect(result.status).toBe("unattributed_caller_restriction_observed");
  });

  it("does not claim the caller is unauthorised, only that no authority was found", () => {
    const result = classifyStep([control(), branch("unattributed"), branch("controller")]);
    expect(result.note).toContain("found no privilege for");
    expect(result.note).toContain("not proof that the caller is unauthorised");
  });

  it("holds the unattributed branch to the same clock parity as the controller branch", () => {
    const drifted = branch("unattributed", { exit: exit("transaction_reverted", { block: "999", timestamp: "999" }) });
    const result = classifyStep([control(), drifted, branch("controller")]);
    expect(result.status).toBe("effect_confirmed");
    expect(result.gaps.some((gap) => gap.startsWith("reachability not established"))).toBe(true);
  });
});

describe("classifyStep — a confirmation needs every leg", () => {
  it("confirms when control exits, the controller's call succeeds, and the identical exit then fails", () => {
    const result = classifyStep([control(), branch("unattributed", { mutation: "reverted", exit: null }), branch("controller")]);
    expect(result.status).toBe("effect_confirmed");
    expect(result.note).not.toMatch(/\bsafe\b|secure|vulnerab/i);
  });

  it("refuses to confirm without a fully verified control exit", () => {
    expect(classifyStep([control("successful_noop"), branch("controller")]).status).toBe("baseline_unestablished");
  });

  it("treats a reverted controller mutation as an absence of evidence", () => {
    const result = classifyStep([control(), branch("controller", { mutation: "reverted", exit: null })]);
    expect(result.status).toBe("mutation_reverted");
    expect(result.note).toContain("NOT evidence that the exit is safe");
  });

  it("records a reachability gap whenever the unattributed branch did not run", () => {
    const result = classifyStep([control(), branch("controller")]);
    expect(result.status).toBe("effect_confirmed");
    expect(result.gaps).toContain("reachability not tested: no unattributed-caller branch was run");
  });

  it("reports a still-working exit as a statement about the vector, not the selector", () => {
    const result = classifyStep([control(), branch("controller", { exit: exit("full_exit_verified") })]);
    expect(result.status).toBe("no_exit_effect_observed");
    expect(result.note).toContain("supports no conclusion about the selector");
  });
});

describe("classifyCandidate — positive wins, negative stays weak", () => {
  const ID = { selector: "0x44c35d07", canonicalSignature: "pause(bool,bool,bool,bool,bool)" };
  const step = (label: string, status: string, gaps: string[] = []) =>
    ({ label, calldata: `0x44c35d07${label}`, classification: { status, note: "n", gaps, evaluations: [] } as unknown as StepClassification });

  it("lets one confirmed vector stand even when other vectors were inconclusive", () => {
    const outcome = classifyCandidate(ID, [step("a", "inconclusive", ["controller mutation reverted"]), step("b", "effect_confirmed")], false);
    expect(outcome.status).toBe("effect_confirmed");
    expect(outcome.confirmedBy.map((vector) => vector.label)).toEqual(["b"]);
  });

  it("promotes an unattributed observation above an ordinary confirmation", () => {
    const outcome = classifyCandidate(ID, [step("a", "effect_confirmed"), step("b", "unattributed_caller_restriction_observed")], true);
    expect(outcome.status).toBe("unattributed_caller_restriction_observed");
  });

  it("refuses a clean outcome while any vector is inconclusive", () => {
    const outcome = classifyCandidate(ID, [step("a", "no_exit_effect_observed"), step("b", "inconclusive", ["controller mutation reverted"])], true);
    expect(outcome.status).toBe("inconclusive");
  });

  it("does not let a reachability gap alone block a clean outcome, but keeps it recorded", () => {
    const outcome = classifyCandidate(ID, [step("a", "no_exit_effect_observed", ["reachability not tested: no unattributed-caller branch was run"])], true);
    expect(outcome.status).toBe("no_exit_effect_observed");
    expect(outcome.gaps[0]).toContain("reachability not tested");
  });

  it("keeps a sampled null result explicitly scoped and carrying its gap", () => {
    const outcome = classifyCandidate(ID, [step("a", "no_exit_effect_observed")], false);
    expect(outcome.gaps).toContain("argument space sampled, not exhausted");
    expect(outcome.note).toContain("not evidence");
  });

  it("states the bound even on an exhaustive null result", () => {
    const outcome = classifyCandidate(ID, [step("a", "no_exit_effect_observed")], true);
    expect(outcome.note).toContain("remain untested");
    expect(outcome.note).not.toMatch(/\bsafe\b|cannot restrict/i);
  });

  it("reports an empty run as not attempted rather than as no effect", () => {
    expect(classifyCandidate(ID, [], true).status).toBe("not_attempted");
  });
});

describe("agreeAcrossForks — independence has to be shown, not assumed", () => {
  const identity: ForkIdentity = {
    runId: "run-a", chainId: 1, blockNumber: "25800000", blockHash: "0xbb", targetCodeHash: "0xcc", planHash: "sha256:plan",
  };
  const candidate = (over: Partial<CandidateOutcome> = {}): CandidateOutcome => ({
    selector: "0x44c35d07", canonicalSignature: "pause(bool,bool,bool,bool,bool)",
    status: "effect_confirmed", note: "n", gaps: [],
    confirmedBy: [{ label: "true,true,true,true,true", calldata: "0xaa" }], stepsRun: 32, ...over,
  });
  const run = (id: Partial<ForkIdentity>, candidates: CandidateOutcome[]): ForkRunOutcome =>
    ({ forkIdentity: { ...identity, ...id }, candidates });

  it("refuses the same run reported twice", () => {
    const agreement = agreeAcrossForks(run({}, [candidate()]), run({}, [candidate()]));
    expect(agreement.independent).toBe(false);
    expect(agreement.gaps[0]).toContain("same run id");
    expect(agreement.candidates[0]?.status).toBe("inconclusive");
  });

  it("accepts two different runs over identical pinned state that confirmed the same vector", () => {
    const agreement = agreeAcrossForks(run({}, [candidate()]), run({ runId: "run-b" }, [candidate()]));
    expect(agreement.independent).toBe(true);
    expect(agreement.candidates[0]?.status).toBe("effect_confirmed");
  });

  it("rejects a positive confirmed on DIFFERENT vectors in each run", () => {
    const second = candidate({ confirmedBy: [{ label: "false,true,true,true,true", calldata: "0xbb" }] });
    const agreement = agreeAcrossForks(run({}, [candidate()]), run({ runId: "run-b" }, [second]));
    expect(agreement.candidates[0]?.status).toBe("inconclusive");
    expect(agreement.candidates[0]?.gaps.some((gap) => gap.includes("different argument vectors"))).toBe(true);
  });

  it("refuses runs that did not test the same state or the same plan", () => {
    for (const drift of [{ blockHash: "0xff" }, { targetCodeHash: "0xff" }, { planHash: "sha256:other" }, { blockNumber: "1" }]) {
      const agreement = agreeAcrossForks(run({}, [candidate()]), run({ runId: "run-b", ...drift }, [candidate()]));
      expect(agreement.independent).toBe(false);
      expect(agreement.candidates[0]?.status).toBe("inconclusive");
    }
  });

  it("discards a confirmation the second run did not reproduce, in either direction", () => {
    const clean = candidate({ status: "no_exit_effect_observed", confirmedBy: [] });
    expect(agreeAcrossForks(run({}, [candidate()]), run({ runId: "b" }, [clean])).candidates[0]?.status).toBe("inconclusive");
    expect(agreeAcrossForks(run({}, [clean]), run({ runId: "b" }, [candidate()])).candidates[0]?.status).toBe("inconclusive");
  });

  it("collapses a candidate the second run never evaluated", () => {
    const agreement = agreeAcrossForks(run({}, [candidate()]), run({ runId: "run-b" }, []));
    expect(agreement.candidates[0]?.status).toBe("inconclusive");
    expect(agreement.candidates[0]?.gaps.some((gap) => gap.includes("did not evaluate"))).toBe(true);
  });
});
