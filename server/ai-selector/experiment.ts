/**
 * Classifying what a fork differential actually showed — pure, so the rules an
 * auditor will argue with are testable without anvil.
 *
 * THREE BRANCHES, EVALUATED THE SAME WAY:
 *
 *   control        neutral transaction, then the exit. Establishes that the exit
 *                  is open AT ALL, and occupies the mutation's block and sender
 *                  nonce so every branch reaches its exit at the same fork
 *                  clock. Without it a per-second-accruing protocol makes the
 *                  branches two different states and the difference gets
 *                  attributed to the mutation.
 *   unattributed   a caller Ripcord found no privilege for sends the candidate
 *                  call, then the exit. Classifies REACHABILITY.
 *   controller     the identified controller sends it, then the exit.
 *
 * THE SYMMETRY IS LOAD-BEARING. The first version special-cased the
 * unattributed branch at the END of a controller-shaped flow, and it cost two
 * live defects at once: a reverting controller call returned `mutation_reverted`
 * while the unattributed caller had already closed the exit (the disclosure
 * event vanished), and the unattributed branch was never held to the clock
 * parity the controller branch was. Both reproduced. So every branch now goes
 * through `evaluateBranchAgainstControl`, which enforces the identical
 * requirements, and only the COMBINATION step knows which branch is which.
 *
 * A fourth branch replaying the same snapshot was considered and rejected: anvil
 * is deterministic, so replaying identical transactions from an identical
 * snapshot returns an identical result BY CONSTRUCTION. Repeatability that means
 * something has to vary what should not matter — see `agreeAcrossForks`, which
 * requires two forks with different run ids over identical pinned state.
 *
 * THE ASYMMETRY IS THE POINT:
 *   positive  control exits + mutation succeeds + the identical exit stops
 *             working = a demonstrated capability.
 *   negative  our arguments produced no effect = a statement about THOSE
 *             arguments, on THAT exit, in THAT state. Never "the selector is
 *             safe", and never enough to close an enumeration gap.
 */
import type { AiBehaviorStatus } from "../shared/ai-selector.js";

export type ExperimentBranch = "control" | "unattributed" | "controller";

/**
 * What the exit transaction actually did.
 *
 * A boolean was not enough, and the reason is the middle three members: a
 * transaction that SUCCEEDS and moves nothing is as real a blockade as one that
 * reverts, while an out-of-gas failure is our own gas cap and evidence of
 * nothing. Collapsing all of those into `verified: false` gave the layer a
 * weaker positive standard than the day-7 engine it sits beside.
 */
export type ExitOutcome =
  | "full_exit_verified"
  | "partial_exit"
  | "successful_noop"
  | "transaction_reverted"
  | "out_of_gas"
  | "read_failed";

export interface PositionSnapshot {
  tokens: string;
  supplied: string;
  borrowed: string;
  principal: string;
}

export interface ExitObservation {
  outcome: ExitOutcome;
  receiptStatus: "success" | "reverted";
  revertData: string | null;
  /** Local fork block and timestamp. Parity across branches is required. */
  block: string;
  timestamp: string;
  /** The exit call itself, so two branches can be SHOWN to have run the identical exit. */
  exitTo: string;
  exitCalldata: string;
  positionBefore: PositionSnapshot;
  positionAfter: PositionSnapshot;
}

export interface BranchRecord {
  branch: ExperimentBranch;
  caller: string;
  /** `not_applicable` only for the control branch, which sends no candidate call. */
  mutation: "not_applicable" | "succeeded" | "reverted";
  mutationRevertData?: string | null;
  /** Position observed after the mutation and before the exit. */
  positionAfterMutation: PositionSnapshot | null;
  exit: ExitObservation | null;
}

export type BranchEvaluationStatus =
  | "control_unusable"
  | "mutation_reverted"
  | "incomplete"
  | "clock_mismatch"
  | "different_exit"
  | "position_removed_by_mutation"
  | "exit_unaffected"
  | "exit_restricted";

export interface BranchEvaluation {
  branch: ExperimentBranch;
  status: BranchEvaluationStatus;
  note: string;
}

function samePosition(a: PositionSnapshot, b: PositionSnapshot): boolean {
  return a.tokens === b.tokens && a.supplied === b.supplied && a.borrowed === b.borrowed && a.principal === b.principal;
}

function sameExitCall(a: ExitObservation, b: ExitObservation): boolean {
  return a.exitTo.toLowerCase() === b.exitTo.toLowerCase() && a.exitCalldata.toLowerCase() === b.exitCalldata.toLowerCase();
}

/**
 * The one place a branch is judged. Identical requirements for every branch, so
 * a disclosure-relevant observation cannot be lost to evaluation order.
 */
export function evaluateBranchAgainstControl(control: BranchRecord, branch: BranchRecord): BranchEvaluation {
  const out = (status: BranchEvaluationStatus, note: string): BranchEvaluation => ({ branch: branch.branch, status, note });

  if (!control.exit || control.exit.outcome !== "full_exit_verified") {
    return out("control_unusable", "The control branch did not complete a fully verified exit, so there is no open exit for any later failure to be measured against.");
  }
  if (!control.positionAfterMutation) {
    return out("control_unusable", "The control branch recorded no position before its exit, so no branch can be shown to have started from the same state.");
  }
  if (branch.mutation === "reverted") {
    return out("mutation_reverted", "The candidate call reverted, so nothing was learned. A mutation that fails is NOT evidence that the exit is safe; it is an absence of evidence in either direction.");
  }
  if (branch.mutation === "not_applicable" || !branch.exit || !branch.positionAfterMutation) {
    return out("incomplete", "The branch did not produce both a completed mutation and an exit observation.");
  }
  if (branch.exit.block !== control.exit.block || branch.exit.timestamp !== control.exit.timestamp) {
    return out("clock_mismatch", `The exits ran at different fork clocks (control ${control.exit.block}/${control.exit.timestamp}, ${branch.branch} ${branch.exit.block}/${branch.exit.timestamp}), so a difference between them is not attributable to the mutation.`);
  }
  if (!sameExitCall(control.exit, branch.exit)) {
    return out("different_exit", "The two branches did not send the identical exit call, so they are not comparable.");
  }
  if (!samePosition(control.positionAfterMutation, branch.positionAfterMutation)) {
    return out("position_removed_by_mutation", "The mutation itself changed the holder's position, so a later exit failure could follow from the position rather than from a restriction.");
  }

  switch (branch.exit.outcome) {
    case "full_exit_verified":
      return out("exit_unaffected", "The identical exit still recovered the position after the mutation.");
    case "read_failed":
      return out("incomplete", "The exit result could not be read, so the branch establishes nothing.");
    case "out_of_gas":
      // Our own gas cap is not the contract's decision. Fail closed rather than
      // count a configuration failure as a demonstrated restriction.
      return out("incomplete", "The exit ran out of gas. That is a property of the gas limit Ripcord chose, not a demonstrated restriction, so nothing is concluded.");
    case "transaction_reverted":
      return out("exit_restricted", "The identical exit reverted after the mutation, with the position unchanged and the fork clock matched.");
    case "partial_exit":
      return out("exit_restricted", "The identical exit succeeded but recovered only part of the position, with the position otherwise unchanged and the fork clock matched.");
    case "successful_noop":
      return out("exit_restricted", "The identical exit succeeded and moved nothing. A transaction that reports success while recovering no assets closes the exit as effectively as a revert.");
  }
}

export interface StepClassification {
  status: AiBehaviorStatus;
  note: string;
  /** Named reasons the step fell short. Never empty on a non-conclusion. */
  gaps: string[];
  evaluations: BranchEvaluation[];
}

/**
 * Classifies ONE argument vector.
 *
 * The unattributed branch is DOMINANT: if a caller with no found privilege
 * closed the exit, that is the finding, whatever the controller branch did.
 */
export function classifyStep(branches: readonly BranchRecord[]): StepClassification {
  const control = branches.find((record) => record.branch === "control");
  const unattributed = branches.find((record) => record.branch === "unattributed");
  const controller = branches.find((record) => record.branch === "controller");

  if (!control) {
    return { status: "baseline_unestablished", note: "No control branch was recorded.", gaps: ["control branch missing"], evaluations: [] };
  }

  const evaluations: BranchEvaluation[] = [];
  const evalUnattributed = unattributed ? evaluateBranchAgainstControl(control, unattributed) : null;
  const evalController = controller ? evaluateBranchAgainstControl(control, controller) : null;
  if (evalUnattributed) evaluations.push(evalUnattributed);
  if (evalController) evaluations.push(evalController);

  if (evalUnattributed?.status === "control_unusable" || evalController?.status === "control_unusable") {
    const reason = (evalUnattributed?.status === "control_unusable" ? evalUnattributed : evalController)!;
    return { status: "baseline_unestablished", note: reason.note, gaps: ["control exit not fully verified"], evaluations };
  }

  // Dominant, and evaluated under the identical requirements as the controller
  // branch — that symmetry is what keeps it from being lost to ordering.
  if (evalUnattributed?.status === "exit_restricted") {
    return {
      status: "unattributed_caller_restriction_observed",
      note: `${unattributed!.caller} — an address Ripcord found no privilege for — sent the same call and the identical exit then failed. ${evalUnattributed.note} This is the shape of a restriction reachable by a party outside the found power map, and it is a disclosure question before it is a reporting one. It is not proof that the caller is unauthorised; only that no authority for it was found.`,
      gaps: [],
      evaluations,
    };
  }

  if (!evalController) {
    return { status: "inconclusive", note: "The controller branch did not run.", gaps: ["controller branch missing"], evaluations };
  }

  // A reachability gap never blocks a controller confirmation, but it is always
  // recorded: not knowing whether anyone else can call it is a real hole.
  const reachabilityGaps = !evalUnattributed
    ? ["reachability not tested: no unattributed-caller branch was run"]
    // `exit_restricted` cannot appear here: it returned above as the dominant
    // disclosure outcome, so reaching this line means the branch did not
    // restrict the exit or did not produce a usable observation.
    : evalUnattributed.status === "exit_unaffected"
      ? []
      : [`reachability not established: the unattributed-caller branch ended as ${evalUnattributed.status}`];

  switch (evalController.status) {
    case "mutation_reverted":
      return { status: "mutation_reverted", note: evalController.note, gaps: ["controller mutation reverted", ...reachabilityGaps], evaluations };
    case "exit_restricted":
      return {
        status: "effect_confirmed",
        note: `A control exit that recovered the position, the controller's call succeeding, and the identical exit at the same fork clock then failing with the position intact. ${evalController.note} The capability is demonstrated; nothing is claimed about the function's name or about intent.`,
        gaps: reachabilityGaps,
        evaluations,
      };
    case "exit_unaffected":
      return {
        status: "no_exit_effect_observed",
        note: "The controller's call succeeded and the identical exit still recovered the position. This describes THIS argument vector against THIS exit action in THIS state, and supports no conclusion about the selector.",
        gaps: reachabilityGaps,
        evaluations,
      };
    default:
      return { status: "inconclusive", note: evalController.note, gaps: [`controller branch ended as ${evalController.status}`, ...reachabilityGaps], evaluations };
  }
}

export interface ConfirmingVector {
  label: string;
  calldata: string;
}

export interface CandidateOutcome {
  selector: string;
  canonicalSignature: string;
  status: AiBehaviorStatus;
  note: string;
  gaps: string[];
  /** The exact vectors that produced the winning observation, by calldata. */
  confirmedBy: ConfirmingVector[];
  stepsRun: number;
}

/**
 * Aggregates the steps for one candidate.
 *
 * Any single confirmed effect wins, and it wins over an incomplete sweep: an
 * untested vector can only add ways to close the exit, never remove the one
 * already demonstrated. The clean direction is the inverse and is deliberately
 * hard — every step must positively say "no effect" AND the plan must have been
 * exhaustive, or the outcome carries its gap.
 */
export function classifyCandidate(
  candidate: { selector: string; canonicalSignature: string },
  steps: readonly { label: string; calldata: string; classification: StepClassification }[],
  exhaustive: boolean,
): CandidateOutcome {
  const base = { selector: candidate.selector, canonicalSignature: candidate.canonicalSignature };
  if (steps.length === 0) {
    return { ...base, status: "not_attempted", note: "No argument vector was run for this candidate.", gaps: ["no steps run"], confirmedBy: [], stepsRun: 0 };
  }

  const vectors = (matching: typeof steps) => matching.map((step) => ({ label: step.label, calldata: step.calldata }));

  const unattributed = steps.filter((step) => step.classification.status === "unattributed_caller_restriction_observed");
  if (unattributed.length > 0) {
    return { ...base, status: "unattributed_caller_restriction_observed", note: unattributed[0]!.classification.note, gaps: [], confirmedBy: vectors(unattributed), stepsRun: steps.length };
  }

  const confirmed = steps.filter((step) => step.classification.status === "effect_confirmed");
  if (confirmed.length > 0) {
    return {
      ...base,
      status: "effect_confirmed",
      note: confirmed[0]!.classification.note,
      gaps: [...new Set(confirmed.flatMap((step) => step.classification.gaps))],
      confirmedBy: vectors(confirmed),
      stepsRun: steps.length,
    };
  }

  const gaps = [...new Set(steps.flatMap((step) => step.classification.gaps))];
  const blocking = gaps.filter((gap) => !gap.startsWith("reachability not"));
  if (blocking.length > 0) {
    return { ...base, status: "inconclusive", note: "At least one argument vector did not reach a conclusion, so this candidate's sweep is incomplete and its silence means nothing.", gaps, confirmedBy: [], stepsRun: steps.length };
  }
  if (!exhaustive) {
    return {
      ...base,
      status: "no_exit_effect_observed",
      note: `Every vector tried (${steps.length}) left the exit working, but the argument space was SAMPLED rather than swept. This is not evidence that the selector cannot restrict the exit.`,
      gaps: [...gaps, "argument space sampled, not exhausted"],
      confirmedBy: [],
      stepsRun: steps.length,
    };
  }
  return {
    ...base,
    status: "no_exit_effect_observed",
    note: `All ${steps.length} representable argument vectors left the exit working. That covers this signature's argument space against the tested exit action only — call ordering, protocol state and every other exit route remain untested.`,
    gaps,
    confirmedBy: [],
    stepsRun: steps.length,
  };
}

/**
 * Identity of one fork run. Two runs are independent only if these say so — a
 * `CandidateOutcome` alone carries nothing that distinguishes a second fork from
 * the same object handed over twice.
 */
export interface ForkIdentity {
  runId: string;
  chainId: number;
  blockNumber: string;
  blockHash: string;
  targetCodeHash: string;
  planHash: string;
}

export interface ForkRunOutcome {
  forkIdentity: ForkIdentity;
  candidates: CandidateOutcome[];
}

export interface ForkAgreement {
  independent: boolean;
  gaps: string[];
  candidates: CandidateOutcome[];
}

const POSITIVE: ReadonlySet<AiBehaviorStatus> = new Set<AiBehaviorStatus>(["effect_confirmed", "unattributed_caller_restriction_observed"]);

function identityGaps(a: ForkIdentity, b: ForkIdentity): string[] {
  const gaps: string[] = [];
  if (a.runId === b.runId) gaps.push("both results carry the same run id, so they are one run reported twice rather than an independent reproduction");
  for (const [field, first, second] of [
    ["chainId", String(a.chainId), String(b.chainId)],
    ["blockNumber", a.blockNumber, b.blockNumber],
    ["blockHash", a.blockHash, b.blockHash],
    ["targetCodeHash", a.targetCodeHash, b.targetCodeHash],
    ["planHash", a.planHash, b.planHash],
  ] as const) {
    if (first !== second) gaps.push(`the two runs disagree on ${field} (${first} vs ${second}), so they did not test the same thing`);
  }
  return gaps;
}

/**
 * Requires two INDEPENDENT fork runs over identical pinned state to agree before
 * any positive outcome stands.
 *
 * A matching status is not enough for a positive result: fork 1 confirming
 * vector `a` and fork 2 confirming vector `b` means no single vector was
 * reproduced. At least one identical calldata must appear in both.
 * Disagreement collapses to `inconclusive` in BOTH directions — including when
 * one run confirmed and the other did not, where taking the confirmation would
 * be choosing the answer we prefer.
 */
export function agreeAcrossForks(first: ForkRunOutcome, second: ForkRunOutcome): ForkAgreement {
  const gaps = identityGaps(first.forkIdentity, second.forkIdentity);
  const collapse = (candidate: CandidateOutcome, reason: string): CandidateOutcome => ({
    ...candidate,
    status: "inconclusive",
    note: reason,
    gaps: [...new Set([...candidate.gaps, reason])],
    confirmedBy: [],
  });

  if (gaps.length > 0) {
    return { independent: false, gaps, candidates: first.candidates.map((candidate) => collapse(candidate, gaps[0]!)) };
  }

  const byKey = new Map(second.candidates.map((candidate) => [`${candidate.selector}|${candidate.canonicalSignature}`, candidate]));
  const candidates = first.candidates.map((candidate) => {
    const other = byKey.get(`${candidate.selector}|${candidate.canonicalSignature}`);
    if (!other) return collapse(candidate, "the second fork run did not evaluate this candidate, so its result was not reproduced");
    if (other.status !== candidate.status) {
      return collapse(candidate, `two independent forks at the same block disagreed (${candidate.status} versus ${other.status}), so neither result is reproducible and neither is reported`);
    }
    if (POSITIVE.has(candidate.status)) {
      const shared = new Set(other.confirmedBy.map((vector) => vector.calldata.toLowerCase()));
      const reproduced = candidate.confirmedBy.filter((vector) => shared.has(vector.calldata.toLowerCase()));
      if (reproduced.length === 0) {
        return collapse(candidate, "both runs reached the same status but on different argument vectors, so no single vector was independently reproduced");
      }
      return { ...candidate, confirmedBy: reproduced, gaps: [...new Set([...candidate.gaps, ...other.gaps])] };
    }
    return { ...candidate, gaps: [...new Set([...candidate.gaps, ...other.gaps])] };
  });

  return { independent: true, gaps: [], candidates };
}
