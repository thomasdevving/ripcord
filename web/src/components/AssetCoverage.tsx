/**
 * "Assets & analysis coverage" — the panel that makes the SCOPE of the evidence
 * legible: was an asset seen by the vendor, was its balance established at the
 * analysis block, was it in a fork experiment, what did that experiment show,
 * and what was never looked at.
 *
 * WHAT THIS COMPONENT REFUSES TO DO:
 *  - No coverage percentage, safety score or share of value tested. There is no
 *    denominator, so any percentage would be arithmetic over an unknown whole.
 *  - Never sort or style market value above evidence. "Estimated value" is a
 *    subordinate column in muted type: it is not value at risk.
 *  - Never hide a row for lack of a price. A row with real balance or fork
 *    evidence and no usable USD figure is exactly the row worth showing.
 *  - Show names and logos as explicitly unverified. Live wallet data contains
 *    phishing lures as token names; identity is the address and chain.
 */
import { Fragment, useState } from "react";
import type { ReactElement } from "react";
import type {
  AssetCoverage,
  AssetCoverageRow,
  BalanceEvidence,
  CoverageProvenance,
  MobulaObservation,
} from "@shared/coverage";
import type { EnrichedAssessment } from "@shared/enriched";
import { CopyButton } from "./CopyButton.js";
import { EnrichedAssessmentPanel } from "./EnrichedAssessment.js";

/**
 * Short, concrete status text. Each state is a distinct claim, never a rung on
 * one ladder.
 *
 * EVERY LABEL CARRIES ITS OWN MEANING. "Not listed in this snapshot" was the
 * clearest example of a label that is exact and says nothing: it names a
 * negative result about a third-party inventory, and a reader has no way to
 * know that the inventory is capped and floored, that the asset reached this
 * table by another route, or — the part that matters — that this is NOT a
 * claim the target does not hold it. The explanation now travels with the
 * label rather than living in a document nobody opens.
 */
function mobulaLabel(m: MobulaObservation): { text: string; tone: "" | "warn"; why: string } {
  switch (m.state) {
    case "observed":
      return {
        text: "Observed in snapshot",
        tone: "",
        why: "The market-data provider's holdings snapshot for this address lists this asset. That is a vendor observation, not an on-chain fact — the balance column beside it is what was read from the chain.",
      };
    case "not_listed":
      return {
        text: "Not in the provider's list",
        tone: "warn",
        why: "The provider's snapshot exists but does not include this asset, so this row reached the table another way — usually Ripcord's own on-chain scan. The snapshot hides holdings below a dollar floor and caps how many it returns, so absence from it is NOT evidence that the target holds none.",
      };
    case "chain_unclear":
      return {
        text: "Chain not established",
        tone: "warn",
        why: "The provider listed this asset without a chain we could resolve. Identity here is (chain, address), so an unresolved chain can never be matched to on-chain evidence — it is left unmatched rather than guessed at.",
      };
    default:
      return {
        text: "No provider snapshot",
        tone: "warn",
        why: "No usable snapshot was stored for this target: the fetch failed, or none was requested. This says nothing about the asset — it is a fact about our own data collection.",
      };
  }
}

function balanceLabel(b: BalanceEvidence): { text: string; tone: "" | "good" | "warn" } {
  switch (b.state) {
    case "verified":
      // "Reported" rather than "verified": what was established is that THIS
      // contract answered balanceOf with this number at this block. The token
      // itself decides that number, and this layer's whole input is a vendor
      // list that really does contain hostile tokens — so the word must not
      // imply the holding was corroborated.
      return { text: `Balance reported at block ${b.block}`, tone: "good" };
    case "verified_zero":
      // Deliberately NOT the same tone as a real balance. A reader scanning a
      // column of green must not read "nothing here" as "checked and fine".
      return { text: `Zero balance read at block ${b.block}`, tone: "" };
    case "read_failed":
      return { text: "Balance read failed", tone: "warn" };
    case "no_contract_at_block":
      return { text: `No contract at this address at block ${b.block}`, tone: "" };
    case "not_an_erc20_balance":
      return { text: `Did not answer balanceOf at block ${b.block}`, tone: "warn" };
    case "different_chain":
      return { text: `Observed on ${b.observedOn}, outside this analysis`, tone: "warn" };
    default:
      return { text: "No recorded balance evidence", tone: "warn" };
  }
}

function usd(value: number | null): string {
  if (value === null) return "—";
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}k`;
  return `$${value.toFixed(2)}`;
}

const short = (address: string | null, isNative: boolean) =>
  isNative ? "native asset" : address ? `${address.slice(0, 10)}…${address.slice(-6)}` : "address unknown";

/**
 * A row-level progress label must be weaker than the batch status behind it.
 * During discovery we do not yet know which identities survive selection, so
 * the row says it is awaiting selection. Once candidate verification has been
 * stored, the exact candidate identity is known and can truthfully be labelled
 * as queued/running in the fork batch. There is deliberately no percentage:
 * the sidecar exposes phase boundaries, not trustworthy per-call progress.
 */
export function assetRowProgress(
  row: AssetCoverageRow,
  provenance: CoverageProvenance,
): "candidate_pending" | "fork_pending" | null {
  if (
    provenance.candidateVerification.status === "pending" &&
    row.mobula.state === "observed" &&
    row.identity.chainRef === provenance.analysedChainRef &&
    !row.identity.isNative &&
    row.identity.address !== null
  ) {
    return "candidate_pending";
  }

  const hasPinnedCandidate = row.sources.includes("mobula_candidate_verification") &&
    (row.balance.state === "verified" || row.balance.state === "verified_zero");
  const alreadyCoveredAsBase = row.experiments.some((experiment) => experiment.kind === "withdrawal_restriction");
  const alreadyHasCandidateOutcome = row.experiments.some((experiment) => experiment.kind === "candidate_withdrawal");
  if (
    provenance.candidateFork.status === "pending" &&
    hasPinnedCandidate &&
    !alreadyCoveredAsBase &&
    !alreadyHasCandidateOutcome
  ) {
    return "fork_pending";
  }

  return null;
}

function RowDetail({ row }: { row: AssetCoverageRow }): ReactElement {
  return (
    <div className="coverage-detail">
      <h4>Identity</h4>
      <table>
        <tbody>
          <tr>
            <th>Chain</th>
            <td className="mono">{row.identity.chainRef ?? "not established"}</td>
          </tr>
          <tr>
            <th>{row.identity.isNative ? "Asset" : "Contract"}</th>
            <td className="mono">
              {row.identity.isNative ? "native asset (no ERC20 contract)" : (row.identity.address ?? "unknown")}
              {row.identity.address && <CopyButton value={row.identity.address} />}
            </td>
          </tr>
          <tr>
            <th>Vendor name</th>
            <td>
              {/* Never identity. Attacker-controlled in live wallet data. */}
              <span className="muted">
                {row.identity.unverifiedName || row.identity.unverifiedSymbol || "—"} (unverified metadata)
              </span>
            </td>
          </tr>
          <tr>
            <th>Curated list</th>
            <td>
              {row.identity.onCuratedList
                ? "On Ripcord's curated major-token list — eligible to be checked, which is not the same as having been checked in this run."
                : "Outside the current curated asset list."}
            </td>
          </tr>
          <tr>
            <th>Row sources</th>
            <td>{row.sources.join(", ")}</td>
          </tr>
        </tbody>
      </table>

      <h4>Mobula observation</h4>
      {row.mobula.state === "observed" ? (
        <table>
          <tbody>
            <tr>
              <th>Amount</th>
              <td className="mono">
                {row.mobula.amount ?? "—"}
                {row.mobula.amountIsMultiChainAggregate && (
                  <div className="note small">
                    This figure aggregates several chains and is not a quantity on any one of them.
                  </div>
                )}
              </td>
            </tr>
            <tr>
              <th>Estimated value</th>
              <td>
                {usd(row.mobula.valuationUsd)} <span className="muted">({row.mobula.valuationBasis})</span>
              </td>
            </tr>
            {row.mobula.chainSlices.length > 0 && (
              <tr>
                <th>Per chain</th>
                <td className="mono small">
                  {row.mobula.chainSlices.map((s) => `${s.chainRef}: ${usd(s.amountUsd)}`).join(" · ")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      ) : (
        <p className="note">{row.mobula.note}</p>
      )}

      <h4>Balance at the analysis block</h4>
      {row.balance.state === "verified" || row.balance.state === "verified_zero" ? (
        <table>
          <tbody>
            <tr>
              <th>Account read</th>
              <td className="mono">{row.balance.account}</td>
            </tr>
            <tr>
              <th>Raw balance</th>
              <td className="mono">{row.balance.balanceRaw}</td>
            </tr>
            <tr>
              <th>Block</th>
              <td className="mono">{row.balance.block}</td>
            </tr>
            <tr>
              <th>Evidence entries</th>
              <td>
                {row.balance.evidenceCount} recorded read(s) · {row.balance.source === "report_dependency_scan"
                  ? "deterministic report dependency scan"
                  : "post-analysis Mobula candidate verification"}
              </td>
            </tr>
          </tbody>
        </table>
      ) : row.balance.state === "read_failed" ? (
        <p className="note">{row.balance.reason}</p>
      ) : row.balance.state === "different_chain" ? (
        <p className="note">
          Observed on {row.balance.observedOn}; this analysis covered {row.balance.analysedChain}.
        </p>
      ) : (
        <p className="note">{row.balance.reason}</p>
      )}
      <p className="note small">
        This establishes the balance, not the legitimacy or safety of the token.
      </p>

      <h4>Fork experiments</h4>
      {row.experiments.length === 0 ? (
        <p className="note">{row.forkGap?.reason ?? "No experiment was attributed to this asset."}</p>
      ) : (
        row.experiments.map((experiment, i) => (
          <div className="evidence-block" key={i} style={{ marginBottom: 10 }}>
            <header>
              <span className="step">
                {experiment.kind === "withdrawal_restriction" ? "W" : experiment.kind === "candidate_withdrawal" ? "C" : "U"}
              </span>
              <h4 style={{ margin: 0 }}>{experiment.label}</h4>
              <span className={`chip ${experiment.execution === "completed" ? "" : "warn"}`}>{experiment.execution.replace(/_/g, " ")}</span>
            </header>
            <table>
              <tbody>
                <tr>
                  <th>Account exercised</th>
                  <td>
                    <span className="mono">{experiment.account.address ?? "not recorded"}</span>
                    <div className="note small">{experiment.account.note}</div>
                  </td>
                </tr>
                <tr>
                  <th>Outcome</th>
                  <td>{experiment.outcome}</td>
                </tr>
                <tr>
                  <th>Fork block</th>
                  <td className="mono">{experiment.forkBlock ?? "—"}</td>
                </tr>
                <tr>
                  <th>Evidence</th>
                  <td className="mono small">{experiment.evidenceRefs.join(", ")}</td>
                </tr>
              </tbody>
            </table>
            {experiment.caveats.length > 0 && (
              <div className="ceiling" style={{ marginTop: 8 }}>
                <strong>Limits on this experiment</strong>
                <ul>
                  {experiment.caveats.map((c, j) => (
                    <li key={j}>{c}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ))
      )}

      {row.gaps.length > 0 && (
        <>
          <h4>Not established</h4>
          <ul className="plain">
            {row.gaps.map((g, i) => (
              <li key={i}>{g}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/**
 * Why an asset can appear here with no experiment against it.
 *
 * Written out because "No test run" is the single easiest label on this page to
 * misread as a finding about the asset. It is a fact about Ripcord's coverage:
 * the fork layer implements ONE protocol's withdrawal and one restricting
 * function, so everything outside that shape is untested by construction.
 */
const UNTESTED_WHY =
  "Nothing was executed against these on a fork. The withdrawal experiment implements one protocol's exit and one " +
  "restricting call, so an asset is only reached when it fits that shape — and candidate discovery is capped. " +
  "An absent experiment is a limit of what this run tested, never a result about the asset.";

/**
 * The asset table.
 *
 * SPLIT FROM THE PANEL SO THE SAME TABLE CAN RENDER TWICE — once for the assets
 * an experiment actually reached, once for the ones it did not, behind a fold.
 * One implementation, so the two lists cannot drift into showing different
 * columns or different labels for the same state.
 */
function CoverageTable({
  rows,
  p,
  open,
  setOpen,
}: {
  rows: AssetCoverageRow[];
  p: CoverageProvenance;
  open: string | null;
  setOpen: (key: string | null) => void;
}): ReactElement {
  return (
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>Asset</th>
                  <th>Mobula</th>
                  <th>Balance at block</th>
                  <th>Fork experiment</th>
                  <th style={{ textAlign: "right" }}>Est. value</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const m = mobulaLabel(row.mobula);
                  const b = balanceLabel(row.balance);
                  const isOpen = open === row.identity.key;
                  const progress = assetRowProgress(row, p);
                  return (
                    <Fragment key={row.identity.key}>
                      <tr className={isOpen ? "coverage-summary-row open" : "coverage-summary-row"}>
                        <td>
                          <div>
                            {/* Symbol is a hint; the mono line under it is identity. */}
                            <span>{row.identity.unverifiedSymbol || "(unnamed)"}</span>{" "}
                            <span className="muted small">unverified</span>
                          </div>
                          <div className="addr">
                            {row.identity.chainRef ?? "chain unknown"} · {short(row.identity.address, row.identity.isNative)}
                          </div>
                        </td>
                        <td>
                          <span className={`chip ${m.tone}`} title={m.why}>{m.text}</span>{" "}
                          <span className="why-hint" tabIndex={0} role="note" aria-label={m.why} title={m.why}>
                            Why?
                          </span>
                        </td>
                        <td>
                          {progress === "candidate_pending" && row.balance.state === "no_recorded_evidence" ? (
                            <span className="chip processing"><span className="processing-dot" aria-hidden="true" />Awaiting candidate check</span>
                          ) : (
                            <span className={`chip ${b.tone}`}>{b.text}</span>
                          )}
                        </td>
                        <td>
                          {row.experiments.map((e, i) => (
                            <div key={i} style={{ marginBottom: 3 }}>
                              <span className={`chip ${e.execution === "completed" ? "" : "warn"}`}>
                                {e.label}: {e.execution.replace(/_/g, " ")}
                              </span>
                            </div>
                          ))}
                          {progress === "candidate_pending" && (
                            <span className="chip processing"><span className="processing-dot" aria-hidden="true" />Selection pending</span>
                          )}
                          {progress === "fork_pending" && (
                            <span className="chip processing"><span className="processing-dot" aria-hidden="true" />Fork test queued / running</span>
                          )}
                          {row.experiments.length === 0 && progress === null && (
                            <span className="chip warn">
                              {row.forkGap?.state === "unlinkable" ? "Coverage not establishable" : "No test run"}
                            </span>
                          )}
                        </td>
                        {/* Subordinate: muted, right-aligned, never a sort key above evidence. */}
                        <td className="mono muted" style={{ textAlign: "right" }}>
                          {row.mobula.state === "observed" ? usd(row.mobula.valuationUsd) : "—"}
                        </td>
                        <td className="coverage-action-cell">
                          <button
                            className="link small"
                            type="button"
                            aria-expanded={isOpen}
                            onClick={() => setOpen(isOpen ? null : row.identity.key)}
                          >
                            {isOpen ? "Hide evidence" : "View evidence"}
                          </button>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="coverage-detail-row">
                          <td colSpan={6}>
                            <div className="coverage-detail-wrap">
                              <RowDetail row={row} />
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
  );
}

export function AssetCoveragePanel({
  coverage,
  enriched = null,
  stalled = false,
}: {
  coverage: AssetCoverage;
  enriched?: EnrichedAssessment | null;
  stalled?: boolean;
}): ReactElement {
  const [open, setOpen] = useState<string | null>(null);
  const p = coverage.provenance;
  const layerPending = p.candidateVerification.status === "pending" || p.candidateFork.status === "pending";

  // A row is shown up front when an experiment reached it, or when one is on
  // its way — work in flight belongs beside the work that finished, not filed
  // under "nothing was tested".
  const tested = coverage.rows.filter(
    (row) => row.experiments.length > 0 || assetRowProgress(row, p) !== null,
  );
  const untested = coverage.rows.filter(
    (row) => row.experiments.length === 0 && assetRowProgress(row, p) === null,
  );

  return (
    <section className="card">
      <h2>Assets &amp; analysis coverage</h2>
      <p className="note" style={{ marginTop: 0, maxWidth: "78ch" }}>
        See which assets were observed, which balances were verified at the analysis block, and which assets were
        included in a fork experiment.
      </p>

      {layerPending && !stalled && (
        <div className="banner info processing-banner" role="status" aria-live="polite">
          <span className="processing-dot" aria-hidden="true" />
          <div>
            <strong>The core report is complete; the Mobula second layer is still running.</strong>
            <div className="small" style={{ marginTop: 3 }}>
              This section refreshes automatically. Per-asset labels distinguish work awaiting selection from exact
              candidates queued for or running in the fork batch.
            </div>
          </div>
        </div>
      )}

      {enriched && <EnrichedAssessmentPanel assessment={enriched} embedded />}

      {/* The two clocks, kept apart. A vendor snapshot and a pinned block are
          different moments, and a difference between them is not an error. */}
      <div className="grid-2" style={{ marginBottom: 14 }}>
        <div className="banner info" style={{ marginBottom: 0 }}>
          <strong>Ripcord analysis</strong>
          <div className="addr" style={{ marginTop: 4 }}>{p.target}</div>
          <div className="small" style={{ marginTop: 4 }}>
            {p.analysedChainRef} · block <span className="mono">{p.analysisBlock}</span> · ruleset {p.rulesetVersion}
          </div>
          <div className="small muted">Report generated {p.reportGeneratedAt.slice(0, 19).replace("T", " ")}Z</div>
        </div>
        <div className="banner info" style={{ marginBottom: 0 }}>
          <strong>Mobula snapshot</strong>
          <div className="small" style={{ marginTop: 4 }}>
            {p.mobulaStatus === "ok" ? (
              <>
                Fetched <span className="mono">{p.mobulaFetchedAt?.slice(0, 19).replace("T", " ")}Z</span>
              </>
            ) : p.mobulaStatus === "unavailable" ? (
              <>Unavailable — {p.mobulaReason ?? "the snapshot could not be retrieved"}</>
            ) : (
              <>No snapshot is stored for this target.</>
            )}
          </div>
          {p.mobulaStatus === "ok" && (
            <div className="small muted" style={{ marginTop: 4 }}>
              Inventory is limited: entries under ${p.mobulaLimits.floorUsd} are withheld and at most{" "}
              {p.mobulaLimits.displayCap} are shown.
            </div>
          )}
        </div>
      </div>

      {stalled && (
        <div className="banner warn">
          <strong>This page stopped waiting for the asset-context refresh</strong>
          <div className="small" style={{ marginTop: 4 }}>
            It was still reported as pending after 20 minutes, so this page stopped polling. Nothing below is wrong —
            it is simply missing the candidate pass. Reload to check again, or re-run the analysis.
          </div>
        </div>
      )}

      <div className={`banner ${p.candidateVerification.status === "partial" || p.candidateVerification.status === "unavailable" ? "warn" : "info"}`}>
        <strong>Mobula implementation · candidate verification</strong>
        <div className="small" style={{ marginTop: 4 }}>
          {p.candidateVerification.status === "not_requested" ? (
            <>Not requested for this analysis.</>
          ) : p.candidateVerification.status === "pending" ? (
            <>Refreshing the snapshot and verifying eligible candidates at the pinned block…</>
          ) : p.candidateVerification.status === "complete" ? (
            <>
              Complete — {p.candidateVerification.candidatesVerified} of {p.candidateVerification.candidatesEligible} eligible candidate(s) returned a pinned balance.
            </>
          ) : p.candidateVerification.status === "partial" ? (
            <>
              Partial — {p.candidateVerification.candidatesVerified} verified; {p.candidateVerification.candidatesFailed} unresolved.
            </>
          ) : (
            <>Unavailable — no candidate balance claims were made.</>
          )}
        </div>
        {p.candidateVerification.status !== "not_requested" && p.candidateVerification.status !== "pending" && (
          <div className="small muted" style={{ marginTop: 4 }}>{p.candidateVerification.note}</div>
        )}
        {p.candidateVerification.withheld.length > 0 && (
          <div className="small" style={{ marginTop: 6 }}>
            <strong>Candidate selection:</strong> {p.candidateVerification.candidatesProposed} proposed; up to {p.candidateVerification.discoveryCap ?? "—"} eligible identities considered. Withheld: {p.candidateVerification.withheld.map((item) => `${item.count} ${item.reason.replaceAll("_", " ")}`).join(", ")}.
          </div>
        )}
        <div className="small" style={{ marginTop: 8 }}>
          <strong>Supported fork scenarios</strong>
          {p.candidateFork.experimental && p.candidateFork.status !== "not_requested" && (
            <span className="chip warn" style={{ marginLeft: 6 }}>experimental</span>
          )}
          <strong>: </strong>
          {p.candidateFork.status === "not_requested" ? (
            <>not requested by the selected analysis mode.</>
          ) : p.candidateFork.status === "pending" ? (
            <>running a bounded Compound III collateral-withdrawal differential…</>
          ) : p.candidateFork.status === "complete" || p.candidateFork.status === "partial" ? (
            <>
              {p.candidateFork.evaluated} of {p.candidateFork.supported} supported collateral scenario(s) evaluated;
              {" "}{p.candidateFork.restrictorsConfirmed} restriction(s) confirmed
              {p.candidateFork.unresolved > 0 ? `; ${p.candidateFork.unresolved} candidate(s) unresolved or unsupported.` : "."}
            </>
          ) : (
            <>unavailable — {p.candidateFork.note}</>
          )}
        </div>
        {p.candidateFork.experimental && p.candidateFork.status !== "not_requested" && (
          <div className="small muted" style={{ marginTop: 4 }}>
            Experimental because this adapter covers one Compound III collateral-withdrawal action and one guardian pause
            mutation. Candidate discovery is independent of the UI floor, sandbox balances are seeded without draining the
            target, and every asset starts from its own fork snapshot. A confirmed restriction is demonstrated; a no-effect
            result is not evidence of safety and is not part of any calibration claim.
          </div>
        )}
      </div>

      {/* Counts, each with its scope stated. They overlap and are never combined. */}
      {/* NOT `.row`: that gives every child `flex: 1`, which stretches these
          into full-width boxes instead of the compact chips they are. */}
      <div className="chip-row">
        <span className="chip">
          {coverage.counts.mobulaEntriesAvailable ?? "—"} entries available in this snapshot
        </span>
        <span className="chip">{coverage.counts.mobulaEntriesShown} shown here</span>
        <span className="chip">{coverage.counts.assetsWithBalanceEvidence} with recorded target-balance evidence</span>
        <span className="chip">{coverage.counts.mobulaCandidatesVerified} Mobula candidate(s) pinned-verified</span>
        <span className="chip">{coverage.counts.assetsInWithdrawalExperiment} in a withdrawal experiment</span>
        <span className="chip">{coverage.counts.assetsInCandidateFork} in a candidate fork scenario</span>
        <span className="chip">{coverage.counts.assetsInUpgradeProof} in an upgrade proof</span>
      </div>

      {p.mobulaLimits.withheld.length > 0 && (
        <div className="banner warn">
          <strong>The snapshot shown here is a subset.</strong>
          <ul className="plain" style={{ marginBottom: 0 }}>
            {p.mobulaLimits.withheld.map((w, i) => (
              <li key={i}>
                {w.count} × {w.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* TESTED FIRST, UNTESTED BEHIND A FOLD — and the fold is labelled with
          what it holds, never hidden. The table used to open with whichever
          assets the vendor happened to list first, most of them carrying "No
          test run", so the handful that an experiment actually reached were
          buried among rows that establish nothing. Collapsing the untested ones
          is a change of ORDER and prominence only: the count is on the summary,
          the reason is one hover away, and every row is still here. */}
      {coverage.rows.length === 0 ? (
        <div className="empty">
          No assets could be listed: there is no Mobula snapshot for this target and the report records no
          asset-level balance or fork evidence.
        </div>
      ) : (
        <>
          {tested.length > 0 ? (
            <CoverageTable rows={tested} p={p} open={open} setOpen={setOpen} />
          ) : (
            <div className="empty">
              No asset here was part of a fork experiment. That is a statement about what this run tested, not about
              these assets — every one of them is listed below.
            </div>
          )}

          {untested.length > 0 && (
            <details className="fold inline-fold" style={{ marginTop: 14 }}>
              <summary>
                <span>{untested.length} asset(s) with no fork experiment</span>
                <span className="fold-hint">
                  listed, balances where we have them — but nothing was executed against them
                </span>
                <span
                  className="why-hint"
                  tabIndex={0}
                  role="note"
                  aria-label={UNTESTED_WHY}
                  title={UNTESTED_WHY}
                >
                  Why?
                </span>
              </summary>
              <div className="fold-body">
                <p className="note" style={{ marginTop: 0 }}>{UNTESTED_WHY}</p>
                <CoverageTable rows={untested} p={p} open={open} setOpen={setOpen} />
              </div>
            </details>
          )}
        </>
      )}

      <div className="banner info" style={{ marginTop: 14 }}>
        <ul className="plain" style={{ marginBottom: 0 }}>
          {coverage.scopeNotes.map((note, i) => (
            <li key={i}>{note}</li>
          ))}
        </ul>
      </div>

      <p className="note small" style={{ marginBottom: 0 }}>
        <strong>Roadmap:</strong> {coverage.roadmapNote}
      </p>
    </section>
  );
}
