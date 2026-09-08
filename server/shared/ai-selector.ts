/**
 * Browser-safe transport types for Ripcord's optional selector-hypothesis layer.
 *
 * This artifact is deliberately separate from Report. A model response is
 * non-deterministic, may be unavailable, and is not chain evidence. Deleting
 * the sidecar must leave the pinned report and its verdict byte-for-byte
 * unchanged.
 */

export type AiSelectorAnalysisStatus =
  | "pending"
  | "complete"
  | "unavailable"
  | "not_applicable";

export type AiCapabilityHint =
  | "pause_or_freeze"
  | "upgrade"
  | "asset_recovery"
  | "parameter_change"
  | "role_or_ownership"
  | "mint_or_burn"
  | "exit_or_withdrawal"
  | "unknown";

/** What deterministic local checks established about one model proposal. */
export type AiCandidateValidationStatus =
  | "selector_hash_matched"
  | "selector_hash_rejected"
  | "abi_parse_rejected";

/**
 * Behaviour is a separate axis from signature validation. In particular,
 * `selector_hash_matched` never implies that the function has the meaning its
 * proposed name suggests.
 */
export type AiBehaviorStatus =
  | "not_attempted"
  | "unsupported_calldata"
  | "baseline_unestablished"
  | "mutation_reverted"
  | "no_exit_effect_observed"
  | "effect_confirmed"
  /**
   * The mutation closed the exit AND a caller Ripcord found no privilege for
   * could send it. Named for what was OBSERVED, not for what it implies: an
   * address absent from the found power map is unattributed, not proven
   * unauthorised — the same distinction `GuardStatus` draws between
   * `attributed` and `guarded_unknown_holder`.
   *
   * It is a disclosure event before it is a report line: it has the shape of a
   * live restriction reachable by an outside party, which this project does not
   * publish (see the disclosure gate).
   */
  | "unattributed_caller_restriction_observed"
  | "inconclusive";

export interface AiSelectorCandidate {
  selector: string;
  proposedSignature: string;
  canonicalSignature: string | null;
  /**
   * A SEARCH HINT ONLY. It orders the experiment queue when the fork budget is
   * smaller than the candidate set, and it must never reach a report finding or
   * a capability classification: that would be classifying on a name, which is
   * the one thing this whole layer exists to avoid.
   */
  capabilityHint: AiCapabilityHint;
  /** Short model-supplied explanation. This is a hypothesis, not evidence. */
  rationale: string;
  validationStatus: AiCandidateValidationStatus;
  computedSelector: string | null;
  /** Canonical ABI input types, from the local parse — not from the model. */
  inputTypes: string[];
  /** True only for the deliberately bounded all-boolean experiment adapter. */
  booleanArgumentsEnumerable: boolean;
  /** Observed calldata-length agreement. Deprioritises; never removes. */
  arityCompatibility: AiArityCompatibility;
  behaviorStatus: AiBehaviorStatus;
  behaviorNote: string;
}

export interface AiSelectorAnalysisArtifact {
  version: "ai-selector-sidecar/v1";
  reportId: string;
  target: string;
  chainId: number;
  block: { number: string; hash: string };
  /** Address whose dispatcher yielded the unmatched selectors. */
  scannedAddress: string | null;
  /** Hash of that address's runtime code at the report block, when available. */
  scannedCodeHash: string | null;
  requestedAt: string;
  completedAt: string | null;
  status: AiSelectorAnalysisStatus;
  provider: "openai";
  model: string | null;
  promptVersion: string;
  promptHash: string;
  inputHash: string | null;
  responseId: string | null;
  totalUnmatchedSelectors: number;
  submittedSelectors: string[];
  truncated: boolean;
  candidates: AiSelectorCandidate[];
  /** Always false in v1. The core engine alone owns the report verdict. */
  changesCoreVerdict: false;
  notes: string[];
}

/**
 * What a bounded calldata-LENGTH probe observed about a selector's decoder.
 *
 * This replaces the tempting alternative — statically pattern-matching
 * CALLDATALOAD offsets and bool-validity checks in the bytecode to decide
 * whether a proposed ABI "fits". That approach is a heuristic wearing a
 * verification layer's clothes: decoder code is shared between functions of the
 * same shape under the optimizer, the validity-check idiom moves between solc
 * versions, and Vyper looks nothing like either. It also filters an event that
 * essentially never happens (a wrong guess colliding to the right four bytes is
 * ~2^-32), whose failure mode is already handled downstream, and it fails in the
 * one direction this project cannot afford: a false rejection silently removes a
 * real candidate from testing. src/detect/guardProbe.ts refuses the same
 * technique one layer up, for the same reason.
 *
 * So the question is asked of the chain instead. The selector is called with
 * 0..N words of zero calldata and the replies are compared. Solidity's decoder
 * checks the static calldata size and, when it is too short, emits a bare
 * `revert(0, 0)` BEFORE any auth or state check — so an empty revert at short
 * lengths that becomes a revert-with-data (or an execution) at length W is a
 * positively observed boundary. It is evidence, cached and pinned like every
 * other read.
 *
 * WHAT IT CANNOT DO, and this is not a caveat to bury: it observes LENGTH, never
 * types. `pause(bool,bool,bool,bool,bool)` and `f(uint256,uint256,uint256,
 * uint256,uint256)` are the same calldata and always will be. A boundary
 * supports or contradicts an ARITY; it says nothing about what the arguments
 * mean. And it never deletes a candidate — see `AiArityCompatibility`.
 */
export type AiArityStatus =
  | "not_probed"
  /** No length behaved differently from the others, so no boundary was established. */
  | "undetermined"
  | "minimum_words_observed";

export type AiArityOutcome =
  | "empty_revert"
  | "revert_with_data"
  | "executed"
  | "read_failed";

export interface AiCalldataArity {
  status: AiArityStatus;
  /** Smallest argument-word count at which the empty-revert behaviour stopped. */
  minimumWords: number | null;
  /** Recorded for every probed length, so an `undetermined` result still shows what ran. */
  observations: { words: number; outcome: AiArityOutcome }[];
  note: string;
}

/**
 * How a candidate's proposed arity compares to the observed boundary.
 *
 * `mismatch_observed` DEPRIORITISES a candidate and never removes it. The
 * boundary is an inference from revert shapes, and revert shapes are exactly
 * where this project has repeatedly found ambiguity (see guardDialects.ts);
 * letting one delete a candidate would let a misread revert hide a real
 * restrictor. Rejection is the fork's job, not this layer's.
 */
export type AiArityCompatibility =
  | "unknown"
  | "compatible_observed"
  | "mismatch_observed";
