import { describe, expect, it } from "vitest";
import { decodeAbiParameters, parseAbiParameters, toFunctionSelector, type Hex } from "viem";
import {
  MAX_EXPERIMENT_STEPS,
  MAX_STEPS_PER_CANDIDATE,
  hashPlan,
  planExperiments,
} from "../server/ai-selector/plan.js";
import { verifyModelProposals } from "../server/ai-selector/verify.js";
import { deriveArity } from "../server/ai-selector/arity.js";
import type { AiArityOutcome, AiCapabilityHint, AiSelectorCandidate } from "../server/shared/ai-selector.js";

const TARGET: Hex = ("0x" + "aa".repeat(20)) as Hex;
const PAUSE5 = "pause(bool,bool,bool,bool,bool)";

/**
 * Builds candidates the only way production can: through the verifier, from a
 * signature whose real selector is derived rather than asserted. A test that
 * hand-assembles a candidate can create a selector/signature pair that
 * `verifyModelProposals` would never emit.
 */
function candidatesFor(
  signatures: { signature: string; capabilityHint?: AiCapabilityHint }[],
  arity?: Map<string, ReturnType<typeof deriveArity>>,
): AiSelectorCandidate[] {
  const proposals = signatures.map(({ signature, capabilityHint }) => ({
    selector: toFunctionSelector(signature),
    signature,
    capabilityHint: capabilityHint ?? ("unknown" as const),
    rationale: "test",
  }));
  return verifyModelProposals({ proposals }, proposals.map((proposal) => proposal.selector), arity);
}

const obs = (outcomes: AiArityOutcome[]) => deriveArity(outcomes.map((outcome, words) => ({ words, outcome })));

describe("planExperiments — exhaustive is earned, sampled is admitted", () => {
  it("enumerates all 32 vectors for a five-boolean signature and calls it exhaustive", () => {
    const [entry] = planExperiments(candidatesFor([{ signature: PAUSE5 }]), TARGET).plans;

    expect(entry?.exhaustive).toBe(true);
    expect(entry?.steps).toHaveLength(32);
    const decoded = entry!.steps.map((step) =>
      decodeAbiParameters(parseAbiParameters("bool,bool,bool,bool,bool"), `0x${step.calldata.slice(10)}` as Hex).join(","));
    expect(new Set(decoded).size).toBe(32);
  });

  it("puts the most-true boolean vector first, as a budget heuristic only", () => {
    const plan = planExperiments(candidatesFor([{ signature: PAUSE5 }]), TARGET);
    expect(plan.plans[0]?.steps[0]?.label).toBe("true,true,true,true,true");
  });

  it("samples a mixed signature one argument at a time and refuses to call it exhaustive", () => {
    const [entry] = planExperiments(candidatesFor([{ signature: "grantRole(bytes32,address)" }]), TARGET).plans;

    expect(entry?.exhaustive).toBe(false);
    expect(entry!.steps.length).toBeGreaterThan(1);
    expect(entry!.steps.length).toBeLessThanOrEqual(MAX_STEPS_PER_CANDIDATE);
    expect(entry?.note).toContain("NOT swept");
  });

  it("treats a zero-argument signature as its own complete argument space", () => {
    const [entry] = planExperiments(candidatesFor([{ signature: "pause()" }]), TARGET).plans;
    expect(entry).toMatchObject({ exhaustive: true });
    expect(entry?.steps).toEqual([{ label: "(no arguments)", calldata: toFunctionSelector("pause()") }]);
  });
});

describe("planExperiments — argument construction", () => {
  it("derives a uintN maximum from its declared width instead of crashing on a narrow type", () => {
    // A fixed 2^255-1 threw IntegerOutOfRangeError here and took the whole plan
    // with it, so one narrow candidate deleted every other candidate's run.
    const plan = planExperiments(candidatesFor([{ signature: "f(uint8)" }]), TARGET);
    const labels = plan.plans[0]!.steps.map((step) => step.label);
    expect(labels).toEqual(["0", "1", "255"]);
  });

  it("derives an intN maximum as 2^(N-1)-1", () => {
    const plan = planExperiments(candidatesFor([{ signature: "f(int8)" }]), TARGET);
    expect(plan.plans[0]!.steps.map((step) => step.label)).toEqual(["0", "1", "127"]);
  });

  it("keeps one unencodable candidate from taking the rest of the plan down with it", () => {
    const good = candidatesFor([{ signature: PAUSE5 }]);
    const unencodable = candidatesFor([{ signature: "f(uint256[])" }]);
    const plan = planExperiments([...unencodable, ...good], TARGET);

    expect(plan.plans.map((entry) => entry.canonicalSignature)).toEqual([PAUSE5]);
    expect(plan.skipped[0]?.reason).toContain("untested");
  });

  it("deduplicates vectors on calldata, so a repeated transaction cannot inflate the count", () => {
    // The zero-address "variation" of an all-zero baseline is the same call.
    const address = planExperiments(candidatesFor([{ signature: "f(address)" }]), TARGET).plans[0]!;
    expect(address.steps).toHaveLength(2);
    expect(new Set(address.steps.map((step) => step.calldata)).size).toBe(2);

    const bytes32 = planExperiments(candidatesFor([{ signature: "f(bytes32)" }]), TARGET).plans[0]!;
    expect(new Set(bytes32.steps.map((step) => step.calldata)).size).toBe(bytes32.steps.length);
  });
});

describe("planExperiments — nothing is deleted for looking wrong", () => {
  it("keeps an arity-mismatched candidate in the plan and only lowers its priority", () => {
    const boundary = new Map([[toFunctionSelector(PAUSE5), obs(["empty_revert", "empty_revert", "empty_revert", "empty_revert", "empty_revert", "revert_with_data"])]]);
    const compatible = candidatesFor([{ signature: PAUSE5, capabilityHint: "pause_or_freeze" }], boundary);
    expect(compatible[0]?.arityCompatibility).toBe("compatible_observed");

    const mismatchBoundary = new Map([[toFunctionSelector("pause()"), obs(["empty_revert", "empty_revert", "revert_with_data"])]]);
    const mismatched = candidatesFor([{ signature: "pause()", capabilityHint: "pause_or_freeze" }], mismatchBoundary);
    expect(mismatched[0]?.arityCompatibility).toBe("mismatch_observed");

    const plan = planExperiments([...mismatched, ...compatible], TARGET);
    expect(plan.plans).toHaveLength(2);
    expect(plan.plans.map((entry) => entry.canonicalSignature)).toEqual([PAUSE5, "pause()"]);
  });

  it("records a rejected proposal in skipped with a reason rather than omitting it", () => {
    const wrong = verifyModelProposals(
      { proposals: [{ selector: toFunctionSelector(PAUSE5), signature: "pause(bool)", capabilityHint: "unknown", rationale: "t" }] },
      [toFunctionSelector(PAUSE5)],
    );
    const plan = planExperiments(wrong, TARGET);
    expect(plan.plans).toHaveLength(0);
    expect(plan.skipped[0]?.reason).toContain("Keccak");
  });
});

describe("planExperiments — the budget is a ceiling with a receipt", () => {
  it("stops admitting candidates at the step budget and names each one it did not run", () => {
    const many = ["f(bool,bool,bool,bool,bool)", "g(bool,bool,bool,bool,bool)", "h(bool,bool,bool,bool,bool)", "i(bool,bool,bool,bool,bool)"]
      .flatMap((signature) => candidatesFor([{ signature }]));
    const plan = planExperiments(many, TARGET, { maxSteps: 64 });

    expect(plan.totalSteps).toBeLessThanOrEqual(64);
    expect(plan.plans).toHaveLength(2);
    expect(plan.budgetExhausted).toBe(true);
    expect(plan.skipped).toHaveLength(2);
    for (const entry of plan.skipped) expect(entry.reason).toContain("untested, not cleared");
  });

  it("never exceeds the whole-report default ceiling", () => {
    const many = Array.from({ length: 20 }, (_, index) => candidatesFor([{ signature: `f${index}(bool,bool,bool,bool,bool)` }])).flat();
    expect(planExperiments(many, TARGET).totalSteps).toBeLessThanOrEqual(MAX_EXPERIMENT_STEPS);
  });
});

describe("planExperiments — identity and determinism", () => {
  it("produces the identical plan regardless of the order the model returned candidates in", () => {
    const all = candidatesFor([
      { signature: PAUSE5, capabilityHint: "pause_or_freeze" },
      { signature: "pause()", capabilityHint: "unknown" },
      { signature: "unpause()", capabilityHint: "upgrade" },
    ]);
    const forward = planExperiments(all, TARGET);
    const reversed = planExperiments([...all].reverse(), TARGET);
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
  });

  it("hashes the executable content, so two runs can be shown to have run the same experiment", () => {
    const plan = planExperiments(candidatesFor([{ signature: PAUSE5 }]), TARGET);
    expect(plan.planHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hashPlan(plan)).toBe(plan.planHash);
  });

  it("changes the plan hash when the calldata changes, and not when only skip prose differs", () => {
    const five = planExperiments(candidatesFor([{ signature: PAUSE5 }]), TARGET);
    const none = planExperiments(candidatesFor([{ signature: "pause()" }]), TARGET);
    expect(five.planHash).not.toBe(none.planHash);

    const withSkip = planExperiments([...candidatesFor([{ signature: PAUSE5 }]), ...candidatesFor([{ signature: "f(uint256[])" }])], TARGET);
    expect(withSkip.skipped.length).toBeGreaterThan(0);
    expect(withSkip.planHash).toBe(five.planHash);
  });
});
