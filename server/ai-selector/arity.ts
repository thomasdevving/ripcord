/**
 * The observed calldata-length boundary for an unresolved selector.
 *
 * Why this exists, and why it is not a bytecode pattern matcher, is argued at
 * `AiCalldataArity` in ../shared/ai-selector.ts. In short: the chain is asked,
 * not the bytecode, so the answer is evidence — pinned to the report block and
 * cached like every other read in this codebase.
 *
 * THE SIGNAL. Solidity's ABI decoder validates the static calldata size before
 * any auth or state check and, when it is short, emits a bare `revert(0, 0)`.
 * So a run of EMPTY reverts that turns into a revert-with-data (or into an
 * execution) at W words is a positively observed minimum arity. Anything else —
 * empty at every length, data at every length, or a non-monotonic pattern — is
 * `undetermined`, which is the fail-closed answer and the common one.
 *
 * The probe is sent from a deterministic address unrelated to the protocol, the
 * same discipline (and for the same reproducibility reason) as guardProbe.ts.
 */
import type { Hex } from "viem";
import type { ChainReader, Evidence } from "../../src/chain/client.js";
import { ChainReadError } from "../../src/chain/client.js";
import type { AiArityOutcome, AiCalldataArity } from "../shared/ai-selector.js";

/** Zero-valued words are appended, so an argument can never carry a live address or amount. */
const ZERO_WORD = "0".repeat(64);

export const MAX_PROBED_WORDS = 8;

/**
 * Fixed and unrelated to any protocol, never random: `probeCall` keys its cache
 * on (address, data, from), so a varying sender would make the observation
 * unreproducible and defeat the pinned cache.
 */
export const ARITY_PROBE_SENDER: Hex = "0x00000000000000000000000000000000a41ff900";

function classify(reverted: boolean, revertData: Hex | undefined): AiArityOutcome {
  if (!reverted) return "executed";
  return !revertData || revertData === "0x" ? "empty_revert" : "revert_with_data";
}

/**
 * Derives the boundary FAIL-CLOSED: a minimum is claimed only when every length
 * below it was an empty revert and the length itself was not. A single
 * `read_failed` anywhere collapses the result to `undetermined`, because a gap
 * in the sequence makes the monotonicity argument unavailable — the same rule
 * report/enumeration.ts applies to completeness.
 */
export function deriveArity(observations: { words: number; outcome: AiArityOutcome }[]): AiCalldataArity {
  const ordered = [...observations].sort((a, b) => a.words - b.words);
  if (ordered.length === 0) {
    return { status: "not_probed", minimumWords: null, observations: ordered, note: "No calldata length was probed." };
  }
  if (ordered.some((o) => o.outcome === "read_failed")) {
    return {
      status: "undetermined",
      minimumWords: null,
      observations: ordered,
      note: "At least one probe failed as infrastructure, so the length sequence has a gap and no boundary can be argued from it.",
    };
  }
  const firstNonEmpty = ordered.findIndex((o) => o.outcome !== "empty_revert");
  if (firstNonEmpty === -1) {
    return {
      status: "undetermined",
      minimumWords: null,
      observations: ordered,
      note: "Every probed length reverted without data. That is consistent with a short-calldata check, an unconditional revert, and a provider that returns no revert payload, so nothing is established.",
    };
  }
  const below = ordered.slice(0, firstNonEmpty);
  const atOrAbove = ordered.slice(firstNonEmpty);
  // A later relapse to an empty revert breaks the decoder reading: a plain
  // size check cannot start failing again once satisfied.
  if (atOrAbove.some((o) => o.outcome === "empty_revert") || below.some((o) => o.outcome !== "empty_revert")) {
    return {
      status: "undetermined",
      minimumWords: null,
      observations: ordered,
      note: "The replies did not form a single empty-revert prefix followed by a non-empty tail, so they cannot be read as a calldata-size boundary.",
    };
  }
  const minimumWords = ordered[firstNonEmpty]!.words;
  if (minimumWords === 0) {
    return {
      status: "undetermined",
      minimumWords: null,
      observations: ordered,
      note: "The selector already answered with data at zero arguments, so no size boundary was crossed and the argument count is unconstrained by this probe.",
    };
  }
  return {
    status: "minimum_words_observed",
    minimumWords,
    observations: ordered,
    note: `Empty reverts below ${minimumWords} argument words and a non-empty reply at ${minimumWords} — consistent with a decoder that requires at least ${minimumWords} static words. This constrains ARITY only; it says nothing about the argument types or what the function does.`,
  };
}

/**
 * Probes 0..MAX_PROBED_WORDS zero words against one selector.
 *
 * Each length is guarded individually: an infrastructure failure costs that one
 * observation (recorded as `read_failed`, which then collapses the derivation)
 * instead of aborting the whole sidecar. A ChainReadError is what "fail loud"
 * looks like at this boundary, so it is recorded rather than rethrown — the
 * caller's sidecar has no clean report to corrupt.
 */
export async function probeCalldataArity(
  chain: ChainReader,
  address: Hex,
  selector: Hex,
  opts: { maxWords?: number; from?: Hex } = {},
): Promise<{ arity: AiCalldataArity; evidence: Evidence[] }> {
  const maxWords = opts.maxWords ?? MAX_PROBED_WORDS;
  const from = opts.from ?? ARITY_PROBE_SENDER;
  const observations: { words: number; outcome: AiArityOutcome }[] = [];
  const evidence: Evidence[] = [];

  for (let words = 0; words <= maxWords; words++) {
    const data = `${selector}${ZERO_WORD.repeat(words)}` as Hex;
    try {
      const probe = await chain.probeCall(address, data, from);
      observations.push({ words, outcome: classify(probe.reverted, probe.revertData) });
      evidence.push(probe.evidence);
    } catch (err) {
      if (!(err instanceof ChainReadError)) throw err;
      observations.push({ words, outcome: "read_failed" });
    }
  }

  return { arity: deriveArity(observations), evidence };
}

/**
 * Compares a parsed candidate's arity to the observed boundary.
 *
 * Only a proposal that needs FEWER words than the decoder demands is a
 * mismatch. A proposal needing more is not: trailing calldata is ignored by
 * Solidity's decoder, so a boundary at W is a lower bound and cannot rule out a
 * longer signature. Being wrong in that direction would remove candidates, which
 * this layer is not allowed to do.
 */
export function arityCompatibility(
  inputWords: number | null,
  arity: AiCalldataArity | null,
): "unknown" | "compatible_observed" | "mismatch_observed" {
  if (inputWords === null || !arity || arity.status !== "minimum_words_observed" || arity.minimumWords === null) return "unknown";
  return inputWords < arity.minimumWords ? "mismatch_observed" : "compatible_observed";
}

/**
 * Static head size in 32-byte words. Returns null for any dynamic type, where
 * the head is an offset and the length carries no arity information — an
 * honest "cannot compare" rather than a number that would invite a wrong
 * mismatch verdict.
 */
export function staticWordCount(inputTypes: readonly string[]): number | null {
  for (const type of inputTypes) {
    if (type.endsWith("]") || type === "bytes" || type === "string" || type === "tuple" || type.startsWith("(")) return null;
  }
  return inputTypes.length;
}
