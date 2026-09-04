/**
 * THE ASSET-COVERAGE COMPOSER.
 *
 * A PURE function of artifacts that already exist: no chain read, no RPC, no
 * fork, no Mobula fetch. That is a scope decision — the panel exists to show
 * what the evidence does and does not cover, and a composer that could fetch the
 * missing piece would erase the gaps it exists to display.
 *
 * The judgements, all conservative: identity is (chain, address) and a null
 * chainRef can never produce a positive match; natives are keyed per chain (the
 * 0xeeee… sentinel is the same string everywhere while meaning a different asset
 * on each); a MISSING dependency entry is not a zero balance, since
 * detectDependencies records only NON-ZERO balances and a failed read goes to
 * unknowns[]; fork linkage must be earned through a `baseToken()` read whose
 * params.address is the target, never inferred from a protocol name; and the
 * baseline exercises a SANDBOX HOLDER, so a successful sandbox withdrawal is
 * never the target's.
 */
import type { Report } from "../src/report/schema.js";
import type { LiveExposure, LiveHolding } from "../src/live/exposure.js";
import type { AssetContextArtifact, CandidateVerification } from "./asset-context.js";
import { MAJOR_TOKENS } from "../src/chain/majorTokens.js";
import {
  assetCoverageVersion,
  type AssetCoverage,
  type AssetCoverageRow,
  type AssetIdentity,
  type BalanceEvidence,
  type ChainRef,
  type CoverageCounts,
  type ForkCoverageGap,
  type ForkExperiment,
  type MobulaObservation,
  type RowSource,
} from "./shared/coverage.js";

/** The sentinel Mobula uses for a chain's native asset. Identical on every chain, hence rule 2. */
const NATIVE_SENTINEL = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

const SCOPE_NOTES = [
  "This panel shows the scope of the evidence, not a risk score. An asset that was not tested is not thereby unsafe.",
  "The rows are a union of the sources available here — a vendor snapshot, recorded balance evidence, and fork experiments. It is not a proven complete inventory of what this contract holds.",
  "Mobula's snapshot and the pinned on-chain reads describe different moments. They are shown as separate observations, and a difference between them is not by itself an inconsistency.",
  "Estimated market value is not value at risk, drainable value, or trapped funds. It is shown subordinate to the evidence status.",
];

const ROADMAP_NOTE =
  "Current boundary: on Compound III, pinned-verified same-chain ERC20 candidates — including an explicit zero target balance — can enter the supported collateral-withdrawal differential. Assets Compound does not recognise, other protocols, native assets and economic or multi-step scenarios remain explicitly outside fork coverage.";

// --- identity ---------------------------------------------------------------

/**
 * Normalises a chain reference to `evm:<n>`, or null when there is nothing
 * usable. Null is load-bearing: it is what prevents a positive match.
 */
export function normaliseChainRef(raw: string | number | null | undefined): ChainRef | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return Number.isInteger(raw) && raw > 0 ? `evm:${raw}` : null;
  const text = raw.trim().toLowerCase();
  if (text === "") return null;
  const prefixed = /^evm:(\d+)$/.exec(text);
  if (prefixed) return `evm:${Number(prefixed[1])}`;
  if (/^\d+$/.test(text)) return `evm:${Number(text)}`;
  // A named chain we cannot map to an id is NOT guessed at. Returning null keeps
  // it out of every positive match rather than risking a wrong one.
  return null;
}

export function isNativeAddress(address: string | null | undefined): boolean {
  return !!address && address.toLowerCase() === NATIVE_SENTINEL;
}

/** `<chainRef>|<address|native>`, or `unknown-chain|<address>` when the chain is unusable. */
export function assetKey(chainRef: ChainRef | null, address: string | null, isNative: boolean): string {
  const chain = chainRef ?? "unknown-chain";
  return `${chain}|${isNative ? "native" : (address ?? "unknown-address").toLowerCase()}`;
}

function curatedSet(chainRef: ChainRef | null): Set<string> {
  const match = chainRef ? /^evm:(\d+)$/.exec(chainRef) : null;
  const chainId = match ? Number(match[1]) : null;
  if (chainId === null) return new Set();
  return new Set((MAJOR_TOKENS[chainId] ?? []).map((t) => t.address.toLowerCase()));
}

function makeIdentity(
  chainRef: ChainRef | null,
  address: string | null,
  isNative: boolean,
  meta: { symbol?: string | null; name?: string | null; logo?: string | null } = {},
): AssetIdentity {
  return {
    chainRef,
    address: isNative ? null : (address?.toLowerCase() ?? null),
    isNative,
    key: assetKey(chainRef, address, isNative),
    unverifiedSymbol: meta.symbol ?? null,
    unverifiedName: meta.name ?? null,
    logo: meta.logo ?? null,
    // A native asset has no ERC20 contract, so it can never be on a list of
    // ERC20 contract addresses. Membership is decided per asset-chain.
    onCuratedList: !isNative && !!address && curatedSet(chainRef).has(address.toLowerCase()),
  };
}

// --- fork linkage ------------------------------------------------------------

interface EvidenceLike {
  params?: Record<string, unknown>;
  rawValue?: unknown;
}

/**
 * The base token the withdrawal experiment actually exercised, or null.
 *
 * Requires a `baseToken()` read whose recorded `params.address` IS the target.
 * Reports written before that param was recorded return null here, and the
 * caller reports the linkage as unestablished rather than guessing — an
 * experiment attributed to the wrong asset would be exactly the false coverage
 * this panel exists to prevent.
 */
export function withdrawalBaseToken(report: Report): { address: string; chainRef: ChainRef | null } | null {
  const er = report.exitRestriction;
  if (!er) return null;
  const target = report.target?.address?.toLowerCase();
  if (!target) return null;

  const pools: EvidenceLike[][] = [er.evidence ?? [], er.baseline?.evidence ?? []];
  for (const candidate of er.candidates ?? []) pools.push(candidate.evidence ?? []);

  for (const pool of pools) {
    for (const entry of pool) {
      const params = entry?.params;
      if (!params || params.read !== "baseToken()") continue;
      const readFrom = typeof params.address === "string" ? params.address.toLowerCase() : null;
      // The link is only trustworthy when we know the read was made against
      // this target. Older evidence omits the address entirely.
      if (readFrom !== target) continue;
      const raw = entry.rawValue;
      if (typeof raw !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(raw)) continue;
      return { address: raw.toLowerCase(), chainRef: normaliseChainRef(report.chainId) };
    }
  }
  return null;
}

/** Turns the exit-restriction result into an experiment record for its base token. */
function withdrawalExperiment(report: Report): ForkExperiment | null {
  const er = report.exitRestriction;
  if (!er) return null;

  const baselineOk = er.baseline?.status === "established";
  const restrictorFound = (er.restrictors?.length ?? 0) > 0;

  // A started experiment is not a verification. Each of these is a distinct
  // epistemic state and none of them is a green tick.
  const execution: ForkExperiment["execution"] = !baselineOk
    ? "not_established"
    : restrictorFound
      ? "completed"
      : er.outcome === "no_direct_restriction_found"
        ? "completed"
        : "inconclusive";

  const caveats: string[] = [...(er.ceiling ?? [])];
  if (!baselineOk) {
    caveats.unshift(
      "The baseline exit was not established, so nothing was demonstrated about this asset's exit either way.",
    );
  }
  // A historical report predates the economic and causal checks the current
  // engine applies, and must not wear a label implying it passed them.
  if (report.rulesetVersion && report.rulesetVersion < "0.13.0") {
    caveats.push(
      `This result was produced under ruleset ${report.rulesetVersion}. It has not been re-run under the current ruleset's full-position and causality checks.`,
    );
  }

  return {
    kind: "withdrawal_restriction",
    label: "Withdrawal restriction test",
    account: {
      address: er.baseline?.holder ?? null,
      // THE DISTINCTION THAT MATTERS MOST IN THIS FILE.
      scope: "sandbox_holder",
      note: "A sandbox holder funded on the fork, not the target. This tests whether a supplier of this asset can be stopped from withdrawing — it does not test the target's own holding of it.",
    },
    execution,
    outcome: er.candidates?.[0]?.detail ?? er.baseline?.note ?? `outcome: ${er.outcome}`,
    forkBlock: er.forkBlock ?? null,
    caveats,
    evidenceRefs: ["exitRestriction.baseline.evidence", "exitRestriction.candidates[].evidence"],
  };
}

/** Turns a proof delta into an experiment record for that asset. */
function upgradeProofExperiment(report: Report, tokenAddress: string): ForkExperiment | null {
  const proof = report.proof;
  if (!proof) return null;
  const delta = proof.deltas?.find((d) => d.token.toLowerCase() === tokenAddress.toLowerCase());
  if (!delta) return null;

  const caveats: string[] = [
    "Only the curated major-token holdings are measured, so any figure here is a floor, never a ceiling.",
  ];
  if (proof.noticeSeconds !== null && proof.noticeSeconds !== "0") {
    // The fork impersonates the controller WITHOUT its queue, so the notice has
    // to be stated beside the movement or the result reads as immediate.
    caveats.push(
      `The impersonated authority is subject to ${proof.noticeSeconds}s of notice on this route, which the fork did not simulate. ${proof.noticeNote}`,
    );
  }
  caveats.push("The controller was impersonated; its own signatures, transaction guards and modules were not executed.");

  return {
    kind: "upgrade_fund_movement",
    label: "Upgrade fund-movement proof",
    account: {
      address: proof.impersonated ?? null,
      scope: "impersonated_controller",
      note: "The resolved upgrade authority, impersonated on the fork. The balance moved is the TARGET's holding of this asset.",
    },
    execution: proof.produced ? "completed" : "not_run",
    outcome: proof.produced
      ? `${delta.delta} units of ${delta.symbol} moved out of the target${delta.usd === null ? " (USD value undetermined)" : ` (about $${delta.usd.toFixed(2)}, ${delta.priceSource})`}.`
      : (proof.failureReason ?? "the proof was not produced"),
    forkBlock: proof.forkBlock ?? null,
    caveats,
    evidenceRefs: ["proof.deltas", "proof.evidence"],
  };
}

function candidateForkExperiment(
  context: AssetContextArtifact | null,
  tokenAddress: string,
): ForkExperiment | null {
  const batch = context?.forkScenarios?.batch;
  const scenario = batch?.scenarios.find((item) =>
    item.address.toLowerCase() === tokenAddress.toLowerCase() && item.assetRole === "collateral",
  );
  if (!scenario) return null;
  return {
    kind: "candidate_withdrawal",
    label: "Candidate collateral-withdrawal differential",
    account: {
      address: scenario.holder,
      scope: "sandbox_holder",
      note: "A deterministic sandbox holder seeded directly on the fork without taking tokens from the target. The token's and Compound's real approve, supply and withdraw paths were then executed. This is not a mainnet account or transaction.",
    },
    execution:
      scenario.state === "restrictor_confirmed" || scenario.state === "no_effect"
        ? "completed"
        : scenario.state === "baseline_unestablished"
          ? "not_established"
          : "inconclusive",
    outcome: scenario.detail,
    forkBlock: batch?.forkBlock ?? null,
    caveats: scenario.caveats,
    evidenceRefs: [`asset-context.forkScenarios.batch.scenarios[${scenario.address}].evidence`],
  };
}

// --- balance evidence --------------------------------------------------------

/**
 * What the report records about this asset's balance.
 *
 * The three negative states are deliberately distinct, because they mean very
 * different things and only one of them is about the contract at all.
 */
function balanceFor(
  report: Report,
  identity: AssetIdentity,
  analysedChain: ChainRef | null,
  candidate: CandidateVerification | undefined,
): BalanceEvidence {
  const target = report.target?.address ?? "";

  if (identity.chainRef && analysedChain && identity.chainRef !== analysedChain) {
    return { state: "different_chain", observedOn: identity.chainRef, analysedChain };
  }
  if (!identity.chainRef) {
    return {
      state: "no_recorded_evidence",
      reason: "Asset identity could not be matched reliably — the source gave no usable chain, so no on-chain evidence can be attributed to it.",
    };
  }
  if (identity.isNative) {
    return {
      state: "no_recorded_evidence",
      // Structural and worth naming: the dependency scan is an ERC20 balance
      // scan, so native ETH is invisible to it at every block, by construction.
      reason: "Native assets are not covered by the dependency balance scan, which reads ERC20 balances only.",
    };
  }

  const tokenEntry = report.dependencies?.tokens?.find(
    (t) => t.token.toLowerCase() === identity.address,
  );
  if (tokenEntry) {
    return {
      state: "verified",
      account: target,
      balanceRaw: tokenEntry.balance,
      block: report.block?.number ?? "",
      evidenceCount: tokenEntry.balanceEvidence?.length ?? 0,
      source: "report_dependency_scan",
    };
  }

  // The optional Mobula layer runs after the deterministic report is already
  // stored. A successful explicit retry may resolve a report-side read gap,
  // but can never replace stronger report evidence or change a verdict.
  if (candidate) {
    if (candidate.state === "verified_nonzero") {
      return {
        state: "verified",
        account: candidate.account,
        balanceRaw: candidate.balanceRaw ?? "",
        block: candidate.block,
        evidenceCount: candidate.evidence.length,
        source: "post_analysis_candidate_verification",
      };
    }
    if (candidate.state === "verified_zero") {
      return {
        state: "verified_zero",
        account: candidate.account,
        balanceRaw: "0",
        block: candidate.block,
        evidenceCount: candidate.evidence.length,
        source: "post_analysis_candidate_verification",
        reason: candidate.reason,
      };
    }
    // The remaining states are NOT interchangeable, and mapping them all onto
    // `read_failed` (as this did) hid the difference that matters: only the
    // last of them is about our infrastructure. The other three are things the
    // chain positively told us at the pinned block.
    if (candidate.state === "not_contract_at_block") {
      return {
        state: "no_contract_at_block",
        account: candidate.account,
        block: candidate.block,
        evidenceCount: candidate.evidence.length,
        reason: candidate.reason,
      };
    }
    if (
      candidate.state === "balance_call_reverted" ||
      candidate.state === "balance_returned_no_data" ||
      candidate.state === "balance_decode_failed"
    ) {
      return {
        state: "not_an_erc20_balance",
        account: candidate.account,
        block: candidate.block,
        evidenceCount: candidate.evidence.length,
        reason: candidate.reason,
      };
    }
    return { state: "read_failed", account: candidate.account, reason: candidate.reason };
  }

  // A failed read IS recorded, as an explicit unknown. Finding one here is what
  // separates "we tried and could not read it" from "we never looked".
  const failure = report.unknowns?.find(
    (u) =>
      u.field.toLowerCase().includes(`dependencies.tokens[${identity.address}]`) &&
      u.field.toLowerCase().includes("balance"),
  );
  if (failure) return { state: "read_failed", account: target, reason: failure.reason };

  if (!identity.onCuratedList) {
    return {
      state: "no_recorded_evidence",
      reason: "Outside the current curated asset list — no balance was queried for this asset at the analysis block.",
    };
  }
  // On the list, no entry, no recorded failure. The scan records nothing for a
  // zero balance, so this is genuinely indeterminate and must not be shown as
  // a proven zero.
  return {
    state: "no_recorded_evidence",
    reason: "No recorded balance evidence at the analysis block. The dependency scan records an entry only for a non-zero balance, so this is not evidence of a zero balance.",
  };
}

// --- Mobula observation ------------------------------------------------------

function mobulaFor(holding: LiveHolding | undefined, exposure: LiveExposure | null): MobulaObservation {
  if (!exposure) return { state: "unavailable", note: "No Mobula snapshot was supplied for this report." };
  if (exposure.status !== "ok") {
    return { state: "unavailable", note: exposure.reason ?? "The Mobula snapshot could not be retrieved." };
  }
  if (!holding) {
    return {
      state: "not_listed",
      note: "Not among the entries shown in this snapshot. The inventory is capped and floored, so this is not evidence the asset is absent.",
    };
  }
  if (normaliseChainRef(holding.chainId) === null) {
    return {
      state: "chain_unclear",
      note: "The snapshot did not attribute this holding to a chain we can match, so it is not linked to any on-chain evidence.",
    };
  }
  const slices = (holding.chains ?? [])
    .map((c) => ({ chainRef: normaliseChainRef(c.chainId), amountUsd: c.amountUSD }))
    .filter((c): c is { chainRef: ChainRef; amountUsd: number | null } => c.chainRef !== null);

  return {
    state: "observed",
    amount: holding.amount,
    valuationUsd: holding.valuation.usd,
    valuationBasis: holding.valuation.basis,
    // A cross-chain total must never be read as a quantity on one chain.
    amountIsMultiChainAggregate: slices.length > 1,
    chainSlices: slices,
  };
}

// --- the composer ------------------------------------------------------------

export function buildAssetCoverage(
  report: Report,
  exposure: LiveExposure | null,
  assetContext: AssetContextArtifact | null = null,
  assetContextRequested = false,
): AssetCoverage {
  const analysedChain = normaliseChainRef(report.chainId);
  const target = report.target?.address ?? "";

  /** key → row under construction. The union of all three sources. */
  const rows = new Map<string, { identity: AssetIdentity; sources: Set<RowSource>; holding?: LiveHolding }>();

  const touch = (identity: AssetIdentity, source: RowSource, holding?: LiveHolding) => {
    const existing = rows.get(identity.key);
    if (existing) {
      existing.sources.add(source);
      if (holding && !existing.holding) existing.holding = holding;
      // Fill display metadata without ever letting it become identity.
      existing.identity.unverifiedSymbol ??= identity.unverifiedSymbol;
      existing.identity.unverifiedName ??= identity.unverifiedName;
      existing.identity.logo ??= identity.logo;
      return;
    }
    rows.set(identity.key, { identity, sources: new Set([source]), ...(holding ? { holding } : {}) });
  };

  // --- source 1: the Mobula snapshot -----------------------------------------
  if (exposure && exposure.status === "ok") {
    for (const holding of exposure.holdings) {
      const chainRef = normaliseChainRef(holding.chainId);
      const native = holding.isNative || isNativeAddress(holding.address);
      const identity = makeIdentity(chainRef, holding.address, native, {
        symbol: holding.unverifiedSymbol || null,
        name: holding.unverifiedName || null,
        logo: holding.logo,
      });
      touch(identity, "mobula_snapshot", holding);
    }
  }

  // --- source 2: recorded balance evidence -----------------------------------
  for (const token of report.dependencies?.tokens ?? []) {
    touch(makeIdentity(analysedChain, token.token, false), "report_balance_evidence");
  }
  // A recorded FAILED read is also a report-side asset worth showing: the reader
  // should see that we tried and could not, not an empty space.
  for (const unknown of report.unknowns ?? []) {
    const match = /dependencies\.tokens\[(0x[0-9a-fA-F]{40})\]/.exec(unknown.field);
    if (match && /balance/i.test(unknown.field)) {
      touch(makeIdentity(analysedChain, match[1] as string, false), "report_balance_evidence");
    }
  }

  // --- source 3: post-analysis verification of Mobula-proposed candidates ---
  const candidateByKey = new Map<string, CandidateVerification>();
  for (const candidate of assetContext?.candidates ?? []) {
    const chainRef = normaliseChainRef(candidate.chainRef);
    const identity = makeIdentity(chainRef, candidate.address, false);
    candidateByKey.set(identity.key, candidate);
    touch(identity, "mobula_candidate_verification");
  }
  for (const scenario of assetContext?.forkScenarios?.batch?.scenarios ?? []) {
    const identity = makeIdentity(analysedChain, scenario.address, false);
    touch(identity, scenario.assetRole === "collateral" ? "fork_experiment" : "mobula_candidate_verification");
  }

  // --- source 4: assets demonstrably in an experiment ------------------------
  const baseToken = withdrawalBaseToken(report);
  if (baseToken) {
    touch(makeIdentity(baseToken.chainRef, baseToken.address, false), "fork_experiment");
  }
  for (const delta of report.proof?.deltas ?? []) {
    touch(makeIdentity(analysedChain, delta.token, false), "fork_experiment");
  }

  // --- assemble ---------------------------------------------------------------
  const withdrawal = withdrawalExperiment(report);
  const assembled: AssetCoverageRow[] = [...rows.values()].map(({ identity, sources, holding }) => {
    const balance = balanceFor(report, identity, analysedChain, candidateByKey.get(identity.key));
    const experiments: ForkExperiment[] = [];

    if (withdrawal && baseToken && identity.address === baseToken.address && identity.chainRef === baseToken.chainRef) {
      experiments.push(withdrawal);
    }
    if (identity.address) {
      const proofExperiment = upgradeProofExperiment(report, identity.address);
      if (proofExperiment) experiments.push(proofExperiment);
      const candidateExperiment = candidateForkExperiment(assetContext, identity.address);
      if (candidateExperiment) experiments.push(candidateExperiment);
    }

    let forkGap: ForkCoverageGap | null = null;
    if (experiments.length === 0) {
      const scenario = identity.address
        ? assetContext?.forkScenarios?.batch?.scenarios.find((item) => item.address.toLowerCase() === identity.address)
        : undefined;
      if (scenario?.state === "unsupported_asset") {
        forkGap = { state: "none_run", reason: scenario.detail };
      } else if (balance.state === "verified_zero" && assetContext?.forkScenarios?.requested) {
        forkGap = { state: "none_run", reason: "The pinned target balance was explicitly zero. The current Compound adapter can still seed an isolated holder, but no supported collateral experiment was attributed to this asset; consult its sidecar outcome." };
      } else if (report.exitRestriction && !baseToken) {
        // The report HAS an experiment but its evidence cannot tie it to any
        // asset. Worded as a limitation OF THE REPORT rather than as a failed
        // attempt on this particular asset, because no per-asset attempt was
        // made or could be: without a recorded base token there is nothing to
        // compare against. Attaching the experiment on a protocol-name or
        // preset hunch is exactly what this panel must not do.
        forkGap = {
          state: "unlinkable",
          reason: "Could not establish asset-level test coverage — this report contains a withdrawal experiment, but its evidence does not record which asset was exercised, so it cannot be attributed to any asset here.",
        };
      } else {
        forkGap = { state: "none_run", reason: "No supported withdrawal test was run for this asset." };
      }
    }

    const gaps: string[] = [];
    // An unlinkable withdrawal experiment is reported EVEN WHEN the row already
    // carries another experiment. Otherwise an asset with an upgrade proof would
    // show one green-looking record and silently hide that the withdrawal test
    // could not be attributed to it — two different experiments, and only one of
    // them was linkable. Found by testing against the historical Comet report,
    // where USDC has a proof delta and an unattributable withdrawal test.
    if (report.exitRestriction && !baseToken) {
      gaps.push(
        "Could not establish withdrawal-test coverage for this asset — the report's fork evidence does not record which asset the experiment exercised.",
      );
    }
    if (balance.state === "no_recorded_evidence") gaps.push(balance.reason);
    if (balance.state === "read_failed") gaps.push("Balance read failed at the analysis block — an infrastructure failure, which establishes nothing about this asset.");
    if (balance.state === "no_contract_at_block") gaps.push("No contract existed at this address at the analysis block, so no balance could be held there.");
    if (balance.state === "not_an_erc20_balance") gaps.push("The contract did not answer balanceOf(address) as an ERC20 at the analysis block. This is not a zero balance.");
    if (balance.state === "different_chain") gaps.push(`Observed on a different chain (${balance.observedOn}).`);
    if (forkGap) gaps.push(forkGap.reason);
    if (!sources.has("mobula_snapshot") && exposure?.status === "ok") {
      gaps.push("Not listed in the Mobula snapshot shown here.");
    }

    return {
      identity,
      sources: [...sources],
      mobula: mobulaFor(holding, exposure),
      balance,
      experiments,
      forkGap,
      gaps,
    };
  });

  // Ordering: evidence first, then value. A row with real on-chain evidence is
  // more useful to a reader than a larger row with none, so value never sorts
  // above evidence.
  const evidenceRank = (row: AssetCoverageRow) =>
    (row.experiments.length > 0 ? 2 : 0) +
    (row.balance.state === "verified" || row.balance.state === "verified_zero" ? 1 : 0);
  assembled.sort((a, b) => {
    const rank = evidenceRank(b) - evidenceRank(a);
    if (rank !== 0) return rank;
    const aUsd = a.mobula.state === "observed" ? (a.mobula.valuationUsd ?? -1) : -1;
    const bUsd = b.mobula.state === "observed" ? (b.mobula.valuationUsd ?? -1) : -1;
    if (aUsd !== bUsd) return bUsd - aUsd;
    return a.identity.key.localeCompare(b.identity.key);
  });

  const counts: CoverageCounts = {
    mobulaEntriesAvailable: exposure?.status === "ok" ? exposure.holdingsCount : null,
    mobulaEntriesShown: exposure?.status === "ok" ? exposure.holdings.length : 0,
    assetsWithBalanceEvidence: assembled.filter(
      (r) => r.balance.state === "verified" || r.balance.state === "verified_zero",
    ).length,
    mobulaCandidatesVerified: assetContext?.counts.verified ?? 0,
    assetsInWithdrawalExperiment: assembled.filter((r) => r.experiments.some((e) => e.kind === "withdrawal_restriction")).length,
    assetsInCandidateFork: assembled.filter((r) => r.experiments.some((e) => e.kind === "candidate_withdrawal")).length,
    assetsInUpgradeProof: assembled.filter((r) => r.experiments.some((e) => e.kind === "upgrade_fund_movement")).length,
    rowsTotal: assembled.length,
  };

  return {
    assetCoverageVersion,
    provenance: {
      target,
      analysedChainRef: analysedChain ?? `chain:${report.chainId}`,
      analysisBlock: report.block?.number ?? "",
      analysisBlockHash: report.block?.hash && report.block.hash !== "0x" ? report.block.hash : null,
      reportGeneratedAt: report.generatedAt,
      rulesetVersion: report.rulesetVersion,
      mobulaFetchedAt: exposure?.fetchedAt ?? null,
      mobulaStatus: exposure ? exposure.status : "absent",
      mobulaReason: exposure?.reason ?? null,
      mobulaLimits: {
        floorUsd: exposure?.floorUsd ?? null,
        displayCap: exposure?.cap ?? null,
        withheld: (exposure?.withheld ?? []).map((w) => ({ reason: w.reason, count: w.count })),
      },
      candidateVerification: assetContext
        ? {
            status: assetContext.status,
            requestedAt: assetContext.requestedAt,
            completedAt: assetContext.completedAt,
            candidatesProposed: assetContext.candidateSelection?.proposed ?? assetContext.counts.displayed,
            candidatesEligible: assetContext.counts.eligible,
            candidatesVerified: assetContext.counts.verified,
            candidatesFailed: assetContext.counts.failed,
            discoveryCap: assetContext.candidateSelection?.cap ?? null,
            withheld: assetContext.candidateSelection?.withheld ?? [],
            note: assetContext.notes.join(" "),
          }
        : {
            status: assetContextRequested ? "pending" : "not_requested",
            requestedAt: null,
            completedAt: null,
            candidatesProposed: 0,
            candidatesEligible: 0,
            candidatesVerified: 0,
            candidatesFailed: 0,
            discoveryCap: null,
            withheld: [],
            note: assetContextRequested
              ? "The optional Mobula refresh was requested and its sidecar is not available yet."
              : "No per-analysis Mobula refresh was requested for this report.",
          },
      candidateFork: assetContext?.forkScenarios
        ? {
            status: assetContext.forkScenarios.status,
            // Read from the batch itself, defaulting to TRUE when absent: an
            // older sidecar that predates the flag is not thereby calibrated.
            experimental: assetContext.forkScenarios.batch?.experimental ?? true,
            candidatesConsidered: assetContext.forkScenarios.batch?.candidatesConsidered ?? 0,
            supported: assetContext.forkScenarios.batch?.supported ?? 0,
            evaluated: assetContext.forkScenarios.batch?.evaluated ?? 0,
            restrictorsConfirmed: assetContext.forkScenarios.batch?.restrictorsConfirmed ?? 0,
            unresolved: assetContext.forkScenarios.batch?.unresolved ?? 0,
            note: assetContext.forkScenarios.note,
          }
        : {
            status: "not_requested",
            experimental: true,
            candidatesConsidered: 0,
            supported: 0,
            evaluated: 0,
            restrictorsConfirmed: 0,
            unresolved: 0,
            note: "No additional candidate fork scenarios were requested for this report.",
          },
    },
    counts,
    rows: assembled,
    scopeNotes: SCOPE_NOTES,
    roadmapNote: ROADMAP_NOTE,
  };
}
