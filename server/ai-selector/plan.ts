/**
 * Turning verified candidates into a BOUNDED experiment plan.
 *
 * Pure: no chain, no fork, no model. Everything the fork runner is allowed to do
 * is decided here, where it can be argued with in a unit test — the same reason
 * report/verdict.ts is a pure function.
 *
 * THREE RULES, and each is a direction rather than a preference:
 *
 *  1. NOTHING IS DELETED FOR LOOKING WRONG. An arity mismatch, an unhelpful
 *     capability hint and an exotic argument list all change the ORDER of the
 *     queue and never its membership. A candidate that gets no steps is recorded
 *     in `skipped` with the reason, because a silently absent candidate is
 *     indistinguishable from one that was tested and cleared.
 *
 *  2. EXHAUSTIVE IS A CLAIM, SO IT MUST BE EARNED. `exhaustive` is true only
 *     where every representable argument vector is in the plan, which in
 *     practice means an all-boolean signature of at most five inputs — 32
 *     vectors. Everything else is SAMPLED, and a negative result on a sampled
 *     candidate can only ever mean "these vectors produced no effect". This is
 *     what keeps a clean run from drifting toward "this selector is safe".
 *
 *  3. SAMPLING IS ONE-AT-A-TIME, NOT A CARTESIAN PRODUCT. From an all-zero
 *     baseline each input is varied through its sample values while the others
 *     stay zero: O(n·k) steps instead of k^n. It is a weaker sweep and says so.
 *     A product over three addresses and two uints would exhaust any fork budget
 *     on one candidate and starve every other selector in the report.
 *
 * The priority function is a BUDGET HEURISTIC and nothing else. It decides what
 * gets tested first when the budget is smaller than the queue; it never decides
 * what a result means, and the model's `capabilityHint` reaches no further than
 * this ordering.
 */
import { createHash } from "node:crypto";
import { encodeAbiParameters, parseAbiItem, type AbiFunction, type Hex } from "viem";
import type { AiCapabilityHint, AiSelectorCandidate } from "../shared/ai-selector.js";

export const planVersion = "ai-selector-plan/0.1.0";

/**
 * Total argument VECTORS one report may run, across every candidate.
 *
 * Not a count of fork transactions, and the difference is large enough that
 * calling it one would be a resource claim we cannot keep: each vector costs a
 * mutation plus an exit in the unattributed branch, the same again in the
 * controller branch, and the whole thing once more on the second fork required
 * for independent reproduction. Budget accordingly.
 */
export const MAX_EXPERIMENT_STEPS = 64;
/** 2^5, the all-boolean exhaustive case. Also the cap for a sampled candidate. */
export const MAX_STEPS_PER_CANDIDATE = 32;
/** Beyond this an all-boolean signature stops being exhaustively enumerable. */
export const MAX_ENUMERABLE_BOOLEANS = 5;

export interface ExperimentStep {
  /** Human-readable argument vector, e.g. "true,true,false,false,false". */
  label: string;
  calldata: Hex;
}

export interface CandidateExperimentPlan {
  selector: string;
  canonicalSignature: string;
  inputTypes: string[];
  /** Queue order only. Never an input to what a result means. */
  priority: number;
  /** True only when every representable argument vector is present. */
  exhaustive: boolean;
  steps: ExperimentStep[];
  note: string;
}

export interface SkippedCandidate {
  selector: string;
  canonicalSignature: string | null;
  reason: string;
}

export interface ExperimentPlan {
  version: string;
  plans: CandidateExperimentPlan[];
  /** Every candidate that received no steps, with why. Never silently dropped. */
  skipped: SkippedCandidate[];
  totalSteps: number;
  budgetExhausted: boolean;
  /** Identity of the executable content, for cross-fork agreement. */
  planHash: string;
}

/**
 * Ordering weight for the model's hint. Deliberately coarse: it separates "look
 * here first" from "look here later" and nothing finer, because a finer scale
 * would invite reading it as a confidence.
 */
const HINT_WEIGHT: Record<AiCapabilityHint, number> = {
  pause_or_freeze: 40,
  exit_or_withdrawal: 40,
  role_or_ownership: 25,
  upgrade: 25,
  parameter_change: 15,
  asset_recovery: 15,
  mint_or_burn: 10,
  unknown: 0,
};

export function candidatePriority(candidate: AiSelectorCandidate, exhaustive: boolean): number {
  let score = HINT_WEIGHT[candidate.capabilityHint] ?? 0;
  if (candidate.arityCompatibility === "compatible_observed") score += 20;
  if (candidate.arityCompatibility === "mismatch_observed") score -= 30;
  // An exhaustively enumerable candidate is worth testing early because its
  // negative result is the only kind that is worth much.
  if (exhaustive) score += 10;
  return score;
}

function parseCandidate(candidate: AiSelectorCandidate): AbiFunction | null {
  if (!candidate.canonicalSignature) return null;
  try {
    const item = parseAbiItem(`function ${candidate.canonicalSignature}`);
    return item.type === "function" ? item : null;
  } catch {
    return null;
  }
}

/**
 * Returns null instead of throwing. A value this adapter cannot encode is a
 * missing vector, never a reason for the whole plan to fail: one exotic
 * candidate must not be able to remove every other candidate's experiment.
 */
function encode(abi: AbiFunction, selector: string, values: readonly unknown[]): Hex | null {
  try {
    const encoded = encodeAbiParameters(abi.inputs, values as never);
    return `${selector}${encoded.slice(2)}` as Hex;
  } catch {
    return null;
  }
}

/**
 * Vectors are deduplicated ON CALLDATA, because that is what actually gets
 * sent. A zero address "variation" of an all-zero baseline is the same
 * transaction twice: it burns fork budget and, worse, inflates the count of
 * vectors a null result claims to have covered.
 */
function pushUnique(steps: ExperimentStep[], seen: Set<string>, label: string, calldata: Hex | null): void {
  if (!calldata || seen.has(calldata)) return;
  seen.add(calldata);
  steps.push({ label, calldata });
}

const ZERO_ADDRESS: Hex = "0x0000000000000000000000000000000000000000";

/**
 * Sample values per type, from an all-zero baseline. `target` is included for
 * address inputs because a self-reference is a common shape for an
 * allow/deny-list entry; no other live address is ever substituted in.
 */
function sampleValues(type: string, target: Hex): unknown[] {
  if (type === "bool") return [true];
  if (type === "address") return [target, ZERO_ADDRESS];
  // The maximum MUST be derived from the declared width. A fixed 2^255-1 threw
  // IntegerOutOfRangeError on the first `uint8` candidate and took the whole
  // plan down with it — a hash-matched selector crashing the planner is the
  // loudest possible version of "one candidate can starve every other".
  const unsigned = /^uint(\d*)$/.exec(type);
  if (unsigned) {
    const bits = BigInt(unsigned[1] || "256");
    return [1n, (1n << bits) - 1n];
  }
  const signed = /^int(\d*)$/.exec(type);
  if (signed) {
    const bits = BigInt(signed[1] || "256");
    return [1n, (1n << (bits - 1n)) - 1n];
  }
  const fixedBytes = /^bytes(\d+)$/.exec(type);
  if (fixedBytes) {
    const width = Number(fixedBytes[1]);
    return [`0x${"ff".repeat(width)}` as Hex];
  }
  return [];
}

function zeroValue(type: string): unknown {
  if (type === "bool") return false;
  if (type === "address") return ZERO_ADDRESS;
  if (/^u?int\d*$/.test(type)) return 0n;
  if (/^bytes\d+$/.test(type)) return `0x${"00".repeat(Number(type.slice(5)))}` as Hex;
  if (type === "bytes") return "0x";
  if (type === "string") return "";
  return null;
}

function labelOf(values: readonly unknown[]): string {
  return values.map((value) => (typeof value === "bigint" ? value.toString() : String(value))).join(",");
}

/** All 2^n boolean vectors, most-true first so a restrictive combination is reached early. */
function booleanVectors(count: number): boolean[][] {
  const vectors: boolean[][] = [];
  for (let mask = 0; mask < 1 << count; mask++) {
    vectors.push(Array.from({ length: count }, (_, bit) => Boolean(mask & (1 << bit))));
  }
  return vectors.sort((a, b) => b.filter(Boolean).length - a.filter(Boolean).length);
}

function buildSteps(abi: AbiFunction, selector: string, target: Hex): { steps: ExperimentStep[]; exhaustive: boolean; note: string } | null {
  const types = abi.inputs.map((input) => input.type);

  if (types.length === 0) {
    return { steps: [{ label: "(no arguments)", calldata: selector as Hex }], exhaustive: true, note: "The signature takes no arguments, so the single possible call is the whole argument space." };
  }

  if (types.every((type) => type === "bool") && types.length <= MAX_ENUMERABLE_BOOLEANS) {
    const steps: ExperimentStep[] = [];
    const seen = new Set<string>();
    for (const values of booleanVectors(types.length)) pushUnique(steps, seen, labelOf(values), encode(abi, selector, values));
    // Exhaustive is a claim, so it survives only if every vector encoded.
    if (steps.length !== 1 << types.length) return null;
    return {
      steps,
      exhaustive: true,
      note: `All ${steps.length} boolean vectors are present, so no argument combination of this signature is untested. Which flag means what is never assumed — it is read off the differential.`,
    };
  }

  const baseline = types.map(zeroValue);
  if (baseline.some((value) => value === null)) return null;

  const steps: ExperimentStep[] = [];
  const seen = new Set<string>();
  pushUnique(steps, seen, labelOf(baseline), encode(abi, selector, baseline));
  for (let index = 0; index < types.length && steps.length < MAX_STEPS_PER_CANDIDATE; index++) {
    for (const value of sampleValues(types[index]!, target)) {
      if (steps.length >= MAX_STEPS_PER_CANDIDATE) break;
      const values = [...baseline];
      values[index] = value;
      pushUnique(steps, seen, labelOf(values), encode(abi, selector, values));
    }
  }
  if (steps.length === 0) return null;
  return {
    steps,
    exhaustive: false,
    note: `Sampled one argument at a time from an all-zero baseline (${steps.length} distinct vectors). The argument space is NOT swept: combinations, other values and any state precondition remain untested, so no effect here supports no conclusion about this selector.`,
  };
}

/**
 * Builds the plan. `target` is the address the experiment will call, used only
 * as a sample value for address inputs.
 */
export function planExperiments(
  candidates: readonly AiSelectorCandidate[],
  target: Hex,
  opts: { maxSteps?: number } = {},
): ExperimentPlan {
  const maxSteps = opts.maxSteps ?? MAX_EXPERIMENT_STEPS;
  const plans: CandidateExperimentPlan[] = [];
  const skipped: SkippedCandidate[] = [];

  for (const candidate of candidates) {
    if (candidate.validationStatus !== "selector_hash_matched") {
      skipped.push({
        selector: candidate.selector,
        canonicalSignature: candidate.canonicalSignature,
        reason: "the proposal did not parse to a signature whose Keccak hash equals the selector, so there is no calldata to send",
      });
      continue;
    }
    const abi = parseCandidate(candidate);
    if (!abi) {
      skipped.push({ selector: candidate.selector, canonicalSignature: candidate.canonicalSignature, reason: "the canonical signature could not be re-parsed for encoding" });
      continue;
    }
    const built = buildSteps(abi, candidate.selector, target);
    if (!built) {
      skipped.push({
        selector: candidate.selector,
        canonicalSignature: candidate.canonicalSignature,
        reason: "the signature takes an argument type this bounded adapter cannot construct or encode a value for; the selector remains untested rather than guessed at",
      });
      continue;
    }
    plans.push({
      selector: candidate.selector,
      canonicalSignature: candidate.canonicalSignature!,
      inputTypes: abi.inputs.map((input) => input.type),
      priority: candidatePriority(candidate, built.exhaustive),
      exhaustive: built.exhaustive,
      steps: built.steps,
      note: built.note,
    });
  }

  // Stable order: priority, then selector, then signature. Never vendor or model
  // order, which would pick a different set on the next response.
  plans.sort((a, b) =>
    b.priority - a.priority ||
    a.selector.localeCompare(b.selector) ||
    a.canonicalSignature.localeCompare(b.canonicalSignature));

  const admitted: CandidateExperimentPlan[] = [];
  let totalSteps = 0;
  let budgetExhausted = false;
  for (const plan of plans) {
    if (totalSteps + plan.steps.length > maxSteps) {
      budgetExhausted = true;
      skipped.push({
        selector: plan.selector,
        canonicalSignature: plan.canonicalSignature,
        reason: `the whole-report budget of ${maxSteps} argument vectors was reached before this candidate; it is untested, not cleared`,
      });
      continue;
    }
    admitted.push(plan);
    totalSteps += plan.steps.length;
  }

  const plan: ExperimentPlan = { version: planVersion, plans: admitted, skipped, totalSteps, budgetExhausted, planHash: "" };
  return { ...plan, planHash: hashPlan(plan) };
}

/**
 * Identifies WHAT was run, so two fork runs can be shown to have executed the
 * same experiment. Covers only the executable content — the admitted plans and
 * their calldata — so a difference in skip prose cannot make two identical
 * experiments look different.
 */
export function hashPlan(plan: Pick<ExperimentPlan, "version" | "plans">): string {
  const canonical = JSON.stringify({
    version: plan.version,
    plans: plan.plans.map((entry) => ({
      selector: entry.selector,
      canonicalSignature: entry.canonicalSignature,
      exhaustive: entry.exhaustive,
      calldata: entry.steps.map((step) => step.calldata),
    })),
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}
