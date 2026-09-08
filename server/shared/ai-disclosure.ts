/**
 * THE AI-SIDECAR DISCLOSURE BOUNDARY.
 *
 * The selector-hypothesis layer can discover something the core report's own
 * gate was never built to catch: a restriction on a holder's exit that a caller
 * OUTSIDE the found power map could reach. That is not a finding to render, it
 * is a live-contract disclosure question — so the sidecar is private for the
 * whole of its run and only ever becomes public by a decision, never by default.
 *
 * THE STATE MACHINE:
 *
 *   not_requested
 *     └─▶ pending_private ──▶ publishable
 *                         ├─▶ review_required
 *                         └─▶ unavailable
 *
 * The rules that make it worth having:
 *
 *  - PRIVATE THROUGHOUT. Nothing leaves the process while a run is in flight.
 *    A partially-finished sidecar has, by construction, not been through the
 *    decision, and a decision is the only route to `publishable`.
 *  - QUARANTINE DOES NOT WAIT FOR REPRODUCTION. One fork observing a possible
 *    unattributed-caller restriction is enough to move to `review_required`.
 *    Independent reproduction decides EVIDENTIAL WEIGHT; it has nothing to do
 *    with secrecy, and waiting for it would publish the window in between.
 *  - `review_required` DISCLOSES NOTHING. No selector, signature, calldata,
 *    address, revert payload or caller — describing the finding is the finding.
 *    The same reasoning as `reports.ts`'s BLOCKED_MESSAGE, one layer out.
 *  - THE CORE REPORT IS UNTOUCHED. It passed its own gate or it did not; this
 *    decision neither publishes nor withholds it. Two artifacts, two gates.
 *  - A CRASH NEVER PUBLISHES. Recovery from `pending_private` resolves to
 *    `review_required` or `unavailable`, never to `publishable` — the same rule
 *    jobs/store.ts applies when a running job is found after a restart.
 *
 * Browser-safe: types and constants only, no Node imports.
 */
import type { AiArityStatus, AiBehaviorStatus, AiCandidateValidationStatus } from "./ai-selector.js";

export type AiSidecarStatus =
  | "not_requested"
  | "pending_private"
  | "publishable"
  | "review_required"
  | "unavailable";

/**
 * Says only that something is withheld and why that is unavoidable. It names no
 * selector, contract, caller or payload, because a message specific enough to be
 * satisfying would leak the observation it exists to hold back — and it states
 * plainly that withholding is not itself a claim that a vulnerability exists.
 */
export const AI_SIDECAR_REVIEW_MESSAGE =
  "The experimental selector-hypothesis sidecar for this report is withheld pending manual review. A fork observation in it could not be cleared for publication, and describing it further would disclose the very thing being withheld. This says nothing about whether a vulnerability exists. It does not affect the analysis report itself, which is published or withheld under its own separate gate.";

export const AI_SIDECAR_PENDING_MESSAGE =
  "The experimental selector-hypothesis sidecar is still running and is private until it finishes. Nothing about it is published before a disclosure decision has been taken.";

/** One candidate as it may be shown once the sidecar is cleared for publication. */
export interface AiPublicCandidate {
  selector: string;
  canonicalSignature: string;
  validationStatus: AiCandidateValidationStatus;
  /** Summary only — the raw per-length probe evidence stays private. */
  arity: { status: AiArityStatus; minimumWords: number | null } | null;
  behaviorStatus: AiBehaviorStatus;
  /** True only where every representable argument vector was run. */
  exhaustive: boolean;
  vectorsRun: number;
  confirmedBy: { label: string; calldata: string }[];
  gaps: string[];
  note: string;
}

export interface AiPublicSidecar {
  status: "publishable";
  chainId: number;
  block: { number: string; hash: string };
  planHash: string;
  vectorBudget: { max: number; used: number; exhausted: boolean };
  /** Whether two independent fork runs over identical pinned state agreed. */
  independentlyReproduced: boolean;
  candidates: AiPublicCandidate[];
  /** Candidates that received no experiment, each with its reason. Never omitted. */
  skipped: { selector: string; reason: string }[];
  /** Selectors the model produced no usable hypothesis for. Still enumeration gaps. */
  unresolvedSelectors: number;
  gaps: string[];
  scopeNotes: string[];
}

export type AiSidecarPublicView =
  | { status: "not_requested" }
  | { status: "pending_private"; message: string }
  | { status: "review_required"; message: string }
  | { status: "unavailable"; reason: string }
  | AiPublicSidecar;

/**
 * Travels with every published sidecar. The layer's bound is part of its output,
 * not a disclaimer under it — the same rule the exit-restriction engine follows.
 */
export const AI_SIDECAR_SCOPE_NOTES = [
  "A model proposed these signatures; Keccak eliminated the impossible ones and a fork determined what the calls could do. A hash match proves a signature produces the observed selector, never that the function has the meaning its name suggests.",
  "4-byte collisions exist. Even a matched signature is a hypothesis about the source-level name, and every conclusion here rests on observed behaviour instead.",
  "Nothing here changes the analysis report or its verdict. This sidecar is a separate artifact and is computed after the report is stored.",
  "A candidate that produced no effect is a statement about the argument vectors actually tried, against the one exit action tested, in that one protocol state. It is never evidence that the selector cannot restrict an exit.",
  "Every experiment ran on an ephemeral fork. No mainnet transaction was sent, no private key was used, and a guarding party was impersonated rather than authorised.",
];
