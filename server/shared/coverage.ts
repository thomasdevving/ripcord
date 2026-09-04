/**
 * ASSET COVERAGE — the shape of "what do we actually know about each asset".
 *
 * This model exists to make the SCOPE OF THE EVIDENCE legible. It is explicitly
 * not a risk score, not a safety rating and not a coverage percentage. Its job
 * is to let a reader point at one asset and say: here is where the inventory
 * came from, here is what was established at the analysis block, here is the
 * experiment that was run, and here is what nobody has looked at.
 *
 * FOUR RULES SHAPE EVERY TYPE BELOW.
 *
 *  1. THE CHARACTERISTICS ARE INDEPENDENT, NEVER A LADDER. There is no single
 *     field running from "found" to "safe". An asset can be observed by the
 *     vendor and have no on-chain evidence; it can have a verified balance and
 *     never have been in an experiment; it can appear only in an experiment and
 *     never have been a holding. Collapsing those into one status would invent a
 *     progression the evidence does not have.
 *
 *  2. ABSENCE IS NEVER PROOF. "Not listed in this snapshot" does not mean the
 *     asset is absent — the inventory is capped, floored and vendor-filtered.
 *     "No recorded balance evidence" does not mean the balance is zero — the
 *     dependency scan records an entry only for a NON-ZERO balance, so a zero
 *     leaves no artifact at all and cannot be reported as a proven zero.
 *
 *  3. IDENTITY IS (CHAIN, ADDRESS). Never a symbol, never a name, never a logo,
 *     never an address without a chain. Native assets are their own kind: the
 *     same 0xeeee… sentinel means a different asset on every chain, so it is
 *     keyed by chain and never merged.
 *
 *  4. ACCOUNT SCOPE IS PART OF THE OBSERVATION. Mobula describes the TARGET's
 *     holdings. The withdrawal baseline uses a SANDBOX HOLDER that Ripcord
 *     funded on a fork. A successful sandbox withdrawal of USDC says nothing
 *     about the target's own USDC, and every experiment record therefore carries
 *     the account it actually exercised.
 *
 * Browser-safe: types and pure constants only, no Node imports. The composer
 * that produces it lives outside the pinned analysis chain and its output never
 * enters the deterministic report JSON.
 */

/** Bump when the composition rules or this shape change. */
export const assetCoverageVersion = "0.4.0";

// --- identity ---------------------------------------------------------------

/**
 * Canonical chain reference, e.g. `evm:1`.
 *
 * Mobula reports `evm:1`; the report carries a numeric `chainId`. Both are
 * normalised to this one form so a comparison is possible at all — and when a
 * source gives no usable chain, the reference is null and NO positive match may
 * be derived from it.
 */
export type ChainRef = string;

export interface AssetIdentity {
  /** Null when the source did not give a usable chain. A null chain can never produce a positive match. */
  chainRef: ChainRef | null;
  /** Lowercased contract address; null for a native asset. */
  address: string | null;
  isNative: boolean;
  /** Stable key for deduplication: `<chainRef>|<address|native>`. */
  key: string;
  /** UNVERIFIED display metadata. Supporting only — never identity. */
  unverifiedSymbol: string | null;
  unverifiedName: string | null;
  logo: string | null;
  /**
   * Whether this exact asset-on-this-chain is on Ripcord's curated major-token
   * list. Computed per asset-chain. Being on the list is NOT evidence that the
   * asset was checked in this run — only that it was eligible to be.
   */
  onCuratedList: boolean;
}

// --- characteristic A: the Mobula snapshot ----------------------------------

export type MobulaObservation =
  /** Present in the snapshot, with the vendor's own figures. */
  | {
      state: "observed";
      /** Vendor-reported units held. Null when it gave none. */
      amount: number | null;
      /** The USD figure this layer is willing to stand behind, and how. Null is a real answer. */
      valuationUsd: number | null;
      valuationBasis: string;
      /**
       * True when the vendor's amount aggregates several chains. Such a figure
       * must never be presented as a quantity on one specific chain.
       */
      amountIsMultiChainAggregate: boolean;
      chainSlices: { chainRef: ChainRef; amountUsd: number | null }[];
    }
  /** The snapshot exists and this asset is not in the SHOWN subset. Not a claim of absence. */
  | { state: "not_listed"; note: string }
  /** No usable snapshot: the fetch failed, or none was supplied. */
  | { state: "unavailable"; note: string }
  /** In the snapshot, but its chain could not be determined — so it is never matched to on-chain evidence. */
  | { state: "chain_unclear"; note: string };

// --- characteristic B: balance at the analysis block -------------------------

export type BalanceEvidence =
  /** A recorded, non-zero balance read for THIS target, asset and chain, at the pinned block. */
  | {
      state: "verified";
      account: string;
      balanceRaw: string;
      block: string;
      evidenceCount: number;
      source: "report_dependency_scan" | "post_analysis_candidate_verification";
    }
  /** An explicit balanceOf read returned zero. Unlike a missing dependency entry, this is positive evidence. */
  | {
      state: "verified_zero";
      account: string;
      balanceRaw: "0";
      block: string;
      evidenceCount: number;
      source: "post_analysis_candidate_verification";
      reason: string;
    }
  /**
   * The READ did not complete — infrastructure, not the contract.
   *
   * Kept strictly separate from the two states below. A candidate whose
   * `balanceOf` reverted, returned nothing, or returned something undecodable
   * told us something about ITSELF; a candidate whose read timed out told us
   * only about our own connection. Filing the first group here would repeat, in
   * the presentation layer, the absence-from-failure defect KNOWN EDGE #31
   * closed in the read layer.
   */
  | { state: "read_failed"; account: string; reason: string }
  /** Positively established: there was no contract code at that address at the analysis block. */
  | { state: "no_contract_at_block"; account: string; block: string; evidenceCount: number; reason: string }
  /**
   * There was code, and it did not answer `balanceOf(address)` as an ERC20 —
   * it reverted, returned no data, or returned something that is not a uint256.
   * A fact about the contract at that block. NOT a zero balance, and NOT a
   * failed read.
   */
  | { state: "not_an_erc20_balance"; account: string; block: string; evidenceCount: number; reason: string }
  /**
   * Nothing in the report records a balance for this asset.
   *
   * DELIBERATELY NOT "zero". The dependency scan writes an entry only for a
   * non-zero balance, so a genuine zero leaves no artifact — and an asset off
   * the curated list was never queried at all. Both land here, distinguished by
   * `reason`, and neither is a proven zero.
   */
  | { state: "no_recorded_evidence"; reason: string }
  /** Observed on a chain this analysis did not cover. */
  | { state: "different_chain"; observedOn: ChainRef; analysedChain: ChainRef };

// --- characteristic C: fork experiments --------------------------------------

export type ForkExperimentKind = "withdrawal_restriction" | "candidate_withdrawal" | "upgrade_fund_movement";

export interface ForkExperiment {
  kind: ForkExperimentKind;
  /** Human label, e.g. "Withdrawal restriction test". */
  label: string;
  /**
   * The account or position the experiment actually exercised.
   *
   * For the withdrawal test this is a SANDBOX HOLDER funded on the fork, not
   * the target. Stating it is what stops "USDC withdrawal succeeded" being read
   * as "the target's USDC was withdrawn".
   */
  account: { address: string | null; scope: "sandbox_holder" | "target" | "impersonated_controller"; note: string };
  /** Did the experiment run to a conclusion? A started experiment is not a verification. */
  execution: "completed" | "inconclusive" | "not_established" | "not_run";
  /** What was actually established, in the engine's own words. */
  outcome: string;
  forkBlock: string | null;
  /** Named limits that apply to THIS experiment. */
  caveats: string[];
  /** Where to look in the report for the underlying evidence. */
  evidenceRefs: string[];
}

/**
 * Why no experiment could be attributed to this asset.
 *
 * Kept separate from an empty experiment list so "we ran nothing for this asset"
 * is distinguishable from "the report has experiments but none could be tied to
 * this asset with confidence".
 */
export type ForkCoverageGap =
  | { state: "none_run"; reason: string }
  | { state: "unlinkable"; reason: string };

// --- the row and the envelope ------------------------------------------------

/** Where a row came from. A row can have several — the model is a UNION of sources. */
export type RowSource =
  | "mobula_snapshot"
  | "report_balance_evidence"
  | "mobula_candidate_verification"
  | "fork_experiment";

export interface AssetCoverageRow {
  identity: AssetIdentity;
  /** Which sources contributed this row. A fork-only row is never presented as an observed holding. */
  sources: RowSource[];
  mobula: MobulaObservation;
  balance: BalanceEvidence;
  experiments: ForkExperiment[];
  /** Present only when `experiments` is empty. */
  forkGap: ForkCoverageGap | null;
  /** Short, concrete reasons this asset is not more fully covered. */
  gaps: string[];
}

/**
 * Counts, each with its own explicit scope.
 *
 * They OVERLAP by design and are never combined into a percentage: there is no
 * denominator, because nothing here establishes a complete asset inventory.
 */
export interface CoverageCounts {
  mobulaEntriesAvailable: number | null;
  mobulaEntriesShown: number;
  assetsWithBalanceEvidence: number;
  /** Mobula-proposed same-chain ERC20 candidates with an explicit pinned balanceOf result, including zero. */
  mobulaCandidatesVerified: number;
  assetsInWithdrawalExperiment: number;
  assetsInCandidateFork: number;
  assetsInUpgradeProof: number;
  rowsTotal: number;
}

export interface CoverageProvenance {
  target: string;
  analysedChainRef: ChainRef;
  analysisBlock: string;
  analysisBlockHash: string | null;
  /** When the REPORT was generated. Distinct from the chain block's own time. */
  reportGeneratedAt: string;
  rulesetVersion: string;
  /** When the Mobula snapshot was pulled, or null when there is none. */
  mobulaFetchedAt: string | null;
  mobulaStatus: "ok" | "unavailable" | "absent";
  mobulaReason: string | null;
  /** How the vendor inventory was limited, so the shown subset is never read as the whole. */
  mobulaLimits: { floorUsd: number | null; displayCap: number | null; withheld: { reason: string; count: number }[] };
  /** State of the opt-in, post-analysis layer. It is deliberately outside the verdict artifact. */
  candidateVerification: {
    status: "not_requested" | "pending" | "complete" | "partial" | "unavailable";
    requestedAt: string | null;
    completedAt: string | null;
    candidatesProposed: number;
    candidatesEligible: number;
    candidatesVerified: number;
    candidatesFailed: number;
    discoveryCap: number | null;
    withheld: { reason: string; count: number }[];
    note: string;
  };
  candidateFork: {
    status: "not_requested" | "pending" | "complete" | "partial" | "unavailable";
    /**
     * True while the per-asset adapter remains narrower than a complete exit
     * analysis. Discovery, non-draining funding and isolation are implemented;
     * other privileged calls, sequences and economic states are not. Carried
     * here so removing the label is a code change rather than an editorial one.
     */
    experimental: boolean;
    candidatesConsidered: number;
    supported: number;
    evaluated: number;
    restrictorsConfirmed: number;
    unresolved: number;
    note: string;
  };
}

export interface AssetCoverage {
  assetCoverageVersion: string;
  provenance: CoverageProvenance;
  counts: CoverageCounts;
  rows: AssetCoverageRow[];
  /** Statements that must be rendered verbatim — the scope of the whole panel. */
  scopeNotes: string[];
  /** Explicitly marked as planned, never as an available action. */
  roadmapNote: string;
}
