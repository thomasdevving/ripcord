/**
 * The disclosure decision, the public projection, and boot recovery — all pure,
 * because these are the rules that decide whether a live-contract observation
 * reaches the internet and they should be arguable without a filesystem.
 *
 * The one subtlety worth stating loudly, because it is the easy thing to get
 * wrong: THE GATE READS THE RAW PER-FORK RESULTS, NOT THE AGREED VIEW.
 * `agreeAcrossForks` collapses a positive that only one fork produced into
 * `inconclusive` — correct for evidential weight, and catastrophic here. A
 * single fork observing that an unattributed caller can close the exit is
 * exactly the moment secrecy has to start; reading the agreed view instead would
 * publish precisely the observation the quarantine exists for, on the grounds
 * that it had not been reproduced yet.
 */
import {
  AI_SIDECAR_PENDING_MESSAGE,
  AI_SIDECAR_REVIEW_MESSAGE,
  AI_SIDECAR_SCOPE_NOTES,
  type AiPublicCandidate,
  type AiSidecarPublicView,
  type AiSidecarStatus,
} from "../shared/ai-disclosure.js";
import { MAX_EXPERIMENT_STEPS } from "./plan.js";
import type { AiSelectorArtifact } from "./artifact.js";

/**
 * Redacts anything address- or payload-shaped from free text on its way out.
 *
 * Structured fields (selector, calldata) are published deliberately and are
 * untouched. This is for PROSE — notes, gaps, skip reasons — which is generated
 * by code whose wording nobody re-audits when it changes. Today's
 * `effect_confirmed` note happens to contain no address; that is an accident of
 * phrasing, and a caught leak in the projection test proved how thin the
 * accident is. Redaction is by SHAPE, not by an allowlist of known fields, for
 * the same reason sanitize.ts redacts by shape: a field list fails open on the
 * next field somebody adds.
 */
export function redactProse(text: string): string {
  return text.replace(/0x[0-9a-fA-F]{8,}/g, "[redacted]");
}

/** Statuses that must never be visible outside the process. */
const QUARANTINE_TRIGGERS = new Set(["unattributed_caller_restriction_observed"]);

export interface AiSidecarRecord {
  reportId: string;
  status: AiSidecarStatus;
  /** Generic, log-safe. Never names a selector, address, signature or payload. */
  reason: string;
  updatedAt: string;
  /** Which private directory holds the artifact, if one was written at all. */
  artifactLocation: "private" | "quarantine" | null;
}

export interface DisclosureDecision {
  status: Extract<AiSidecarStatus, "publishable" | "review_required" | "unavailable">;
  reason: string;
  /** Where the artifact must be written. Decided BEFORE the write, so no move is needed. */
  location: "private" | "quarantine";
}

/**
 * Does any fork run, on its own, contain an observation that must not be
 * published? Deliberately scans `runs` rather than `reproduction`.
 */
export function triggersQuarantine(artifact: AiSelectorArtifact): boolean {
  return artifact.runs.some((run) =>
    run.candidates.some((candidate) => QUARANTINE_TRIGGERS.has(candidate.status)) ||
    run.steps.some((step) => QUARANTINE_TRIGGERS.has(step.classification.status)));
}

/**
 * The gate. Quarantine is checked FIRST — before completeness, before anything —
 * because an incomplete run that saw a restriction still saw it, and answering
 * `unavailable` there would put a real observation behind a message that invites
 * a retry.
 */
export function decideDisclosure(artifact: AiSelectorArtifact): DisclosureDecision {
  if (triggersQuarantine(artifact)) {
    return {
      status: "review_required",
      // Log-safe: the reason a human reads in a log names no contract detail.
      reason: "a fork observation requires manual review before publication",
      location: "quarantine",
    };
  }
  if (!artifact.complete || artifact.completedAt === null) {
    return {
      status: "unavailable",
      reason: "the run did not complete, so no sidecar was produced",
      location: "private",
    };
  }
  return {
    status: "publishable",
    reason: "the run completed and produced no observation requiring review",
    location: "private",
  };
}

/**
 * Recovery after a crash or restart.
 *
 * A run interrupted mid-flight is never resumed and never completed. If its
 * artifact survived and contains a quarantine trigger, the quarantine still
 * applies — an interruption cannot un-see an observation. Otherwise the run is
 * `unavailable`. There is deliberately no path from here to `publishable`:
 * publication requires a decision over a finished artifact, and by definition
 * this one has neither.
 */
export function recoverOnBoot(
  record: AiSidecarRecord,
  artifact: AiSelectorArtifact | null,
): AiSidecarRecord {
  if (record.status !== "pending_private") return record;
  if (artifact && triggersQuarantine(artifact)) {
    return { ...record, status: "review_required", reason: "a fork observation requires manual review before publication", artifactLocation: "quarantine" };
  }
  return {
    ...record,
    status: "unavailable",
    reason: "the run was interrupted before it finished and is never resumed or completed",
    artifactLocation: artifact ? "private" : null,
  };
}

function publicCandidate(artifact: AiSelectorArtifact, selector: string, signature: string): AiPublicCandidate | null {
  const candidate = artifact.candidates.find(
    (entry) => entry.selector === selector && entry.canonicalSignature === signature);
  if (!candidate) return null;
  const plan = artifact.plan.plans.find((entry) => entry.selector === selector && entry.canonicalSignature === signature);
  const arity = artifact.arity.find((entry) => entry.selector === selector);
  // The reproduced view when there is one: an unreproduced positive has already
  // been collapsed to inconclusive there, which is the right thing to publish.
  const outcome =
    artifact.reproduction?.candidates.find((entry) => entry.selector === selector && entry.canonicalSignature === signature) ??
    artifact.runs[0]?.candidates.find((entry) => entry.selector === selector && entry.canonicalSignature === signature);

  return {
    selector,
    canonicalSignature: signature,
    validationStatus: candidate.validationStatus,
    // Summary only. The per-length probe evidence stays private: it is a map of
    // how the contract answers malformed calldata, which is not something to
    // publish for the convenience of a reader.
    arity: arity ? { status: arity.arity.status, minimumWords: arity.arity.minimumWords } : null,
    behaviorStatus: outcome?.status ?? candidate.behaviorStatus,
    exhaustive: plan?.exhaustive ?? false,
    vectorsRun: outcome?.stepsRun ?? 0,
    // Structured and deliberately published: the calldata IS the statement of
    // what was tested, and a reader cannot check the claim without it.
    confirmedBy: outcome?.confirmedBy ?? [],
    gaps: (outcome?.gaps ?? []).map(redactProse),
    note: redactProse(outcome?.note ?? candidate.behaviorNote),
  };
}

/**
 * Projects the public view. The public shape is DERIVED, never a stored copy —
 * so there is no file anywhere that a route could serve by mistake, and adding a
 * field to the private artifact cannot publish it by accident.
 */
export function projectPublicView(
  record: AiSidecarRecord,
  artifact: AiSelectorArtifact | null,
): AiSidecarPublicView {
  switch (record.status) {
    case "not_requested":
      return { status: "not_requested" };
    case "pending_private":
      return { status: "pending_private", message: AI_SIDECAR_PENDING_MESSAGE };
    case "review_required":
      return { status: "review_required", message: AI_SIDECAR_REVIEW_MESSAGE };
    case "unavailable":
      return { status: "unavailable", reason: record.reason };
    case "publishable":
      break;
  }

  // Belt and braces. A record can only reach `publishable` through
  // `decideDisclosure`, but this projection is the last thing between an
  // artifact and a browser, so it re-runs the gate rather than trusting a status
  // that may have been written by an older version of this code.
  if (!artifact) return { status: "unavailable", reason: "the sidecar record is present but its artifact is missing" };
  const recheck = decideDisclosure(artifact);
  if (recheck.status !== "publishable") {
    return recheck.status === "review_required"
      ? { status: "review_required", message: AI_SIDECAR_REVIEW_MESSAGE }
      : { status: "unavailable", reason: recheck.reason };
  }

  const candidates = artifact.plan.plans
    .map((plan) => publicCandidate(artifact, plan.selector, plan.canonicalSignature))
    .filter((candidate): candidate is AiPublicCandidate => candidate !== null);

  const resolved = new Set(artifact.candidates
    .filter((candidate) => candidate.validationStatus === "selector_hash_matched")
    .map((candidate) => candidate.selector));

  return {
    status: "publishable",
    chainId: artifact.chainId,
    block: artifact.block,
    planHash: artifact.plan.planHash,
    vectorBudget: { max: MAX_EXPERIMENT_STEPS, used: artifact.plan.totalSteps, exhausted: artifact.plan.budgetExhausted },
    independentlyReproduced: artifact.reproduction?.independent === true,
    candidates,
    skipped: artifact.plan.skipped.map((entry) => ({ selector: entry.selector, reason: redactProse(entry.reason) })),
    unresolvedSelectors: artifact.submittedSelectors.filter((selector) => !resolved.has(selector)).length,
    gaps: artifact.gaps.map(redactProse),
    scopeNotes: AI_SIDECAR_SCOPE_NOTES,
  };
}
