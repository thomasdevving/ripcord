/**
 * THE ENRICHED ASSESSMENT — the one place sidecar evidence is allowed to reach a
 * conclusion.
 *
 * Everything else in the second Mobula layer is deliberately inert, but refusing
 * to connect the two forever has its own cost: a run can hold a fork-confirmed
 * zero-notice restriction on four collateral assets while the report beside it
 * names only the base asset, with nothing reconciling them.
 *
 * Four rules make composing them safe, each enforced by the types below:
 *  1. THE REPORT IS NEVER MODIFIED. `changesVerdict` is a literal `false`.
 *  2. CAUTION-ONLY. No outcome variant softens anything; a clean sidecar
 *     produces `no_change` and nothing else.
 *  3. THE LINK MUST BE EARNED. Target, chain, block number, block hash and fork
 *     block must all match; anything else is `unusable` with the mismatch named.
 *  4. SCOPE TRAVELS WITH THE CLAIM. Every outcome names the assets it rests on
 *     and the ones it does not, so a total is always reconcilable.
 *
 * Browser-safe: types and pure constants only, no Node imports.
 */

/** Bump when the composition rules or this shape change. */
export const enrichedAssessmentVersion = "0.1.0";

/** (chain, address) — never a symbol, for the reasons the live layer learned the hard way. */
export interface EnrichedAsset {
  chainRef: string;
  address: string;
  /** UNVERIFIED vendor metadata, supporting only. Never identity. */
  unverifiedSymbol: string | null;
}

/** One asset on which a privileged party was demonstrated to close a working exit. */
export interface ConfirmedRestrictor extends EnrichedAsset {
  /** The party impersonated on the fork, and what that impersonation did not reproduce. */
  guardian: string | null;
  guardianType: "safe" | "eoa" | "contract" | null;
  /** Notice the fork did not simulate. "0" means none was found on this route; null means undetermined. */
  noticeSeconds: string | null;
  /** The sandbox account that held the position, never the analysed target. */
  holder: string | null;
  suppliedRaw: string | null;
  recoveredRaw: string | null;
  /** Where the underlying evidence lives, so the claim is followable. */
  evidenceRef: string;
}

/** An asset that was considered and did not produce a restriction claim, with the reason kept. */
export interface UnconfirmedAsset extends EnrichedAsset {
  /** The engine's own state, verbatim. `no_effect` is NOT a clean result — see `noEffectNote`. */
  state: string;
  detail: string;
}

/**
 * What the sidecar adds to the report's own conclusion.
 *
 * NOTE WHAT IS ABSENT: there is no variant that weakens, reassures, or clears.
 * That is the structural guarantee, not a convention — adding one would be a
 * visible, reviewable change to this union rather than a quiet edit in a
 * composer.
 */
export type EnrichedOutcome =
  /** No sidecar, or none requested. The report stands exactly as it is. */
  | { status: "not_applicable"; reason: string }
  /**
   * A sidecar exists but cannot be joined to this report. Named mismatches,
   * never a silent drop and never an optimistic join.
   */
  | { status: "unusable"; reason: string; mismatches: string[] }
  /**
   * The sidecar ran and adds nothing to the conclusion. Reached whenever no
   * restrictor was confirmed — including when every candidate came back
   * `no_effect`, which is emphatically not a clean bill.
   */
  | { status: "no_change"; reason: string }
  /**
   * The report already reports this class of finding; the sidecar shows it
   * reaches further than the report's own experiment established.
   */
  | {
      status: "scope_broadened";
      /** The report's own verdict, quoted so the two artifacts cannot drift apart. */
      reportVerdict: string;
      confirmed: ConfirmedRestrictor[];
      statement: string;
    }
  /**
   * The sidecar demonstrates a restriction the deterministic report did not
   * reach on its own. The strongest thing this layer may say.
   */
  | {
      status: "stricter_than_report";
      reportVerdict: string;
      confirmed: ConfirmedRestrictor[];
      statement: string;
    };

export interface EnrichedAssessment {
  enrichedAssessmentVersion: string;
  /**
   * A literal `false`. The pinned report and its verdict are untouched by this
   * artifact, and the type makes any other value unrepresentable.
   */
  changesVerdict: false;
  /** True while the underlying per-asset engine is still experimental. */
  experimental: boolean;
  outcome: EnrichedOutcome;
  /** Everything considered and NOT confirmed, so a total can always be reconciled. */
  unconfirmed: UnconfirmedAsset[];
  counts: {
    considered: number;
    confirmed: number;
    /** Candidates that reached a conclusion of `no_effect`. Reported, never credited. */
    noEffect: number;
    /** Candidates that reached no conclusion at all. */
    unresolved: number;
  };
  /** Rendered verbatim. The bound on everything above. */
  scopeNotes: string[];
  provenance: {
    target: string;
    chainRef: string;
    analysisBlock: string;
    reportVerdict: string;
    reportRestrictionState: string | null;
    /** When the sidecar's vendor snapshot was taken — a different clock from the block. */
    sidecarFetchedAt: string | null;
    sidecarCompletedAt: string | null;
  };
}

/** Stated on every assessment that rests on a `no_effect`, so the word can never read as "safe". */
export const NO_EFFECT_NOTE =
  "A candidate marked `no_effect` means this one privileged action did not close this one exit for this one asset in this one experiment. It is not evidence that the asset, the exit or the protocol is safe.";
