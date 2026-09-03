/**
 * "Assets & analysis coverage" — the panel that makes the SCOPE of the evidence
 * legible.
 *
 * Its job is to let a reader point at one asset and answer five questions: was
 * it seen by the vendor, was its balance established on the analysis block, was
 * it in a fork experiment, what did that experiment actually show, and what was
 * never looked at.
 *
 * WHAT THIS COMPONENT REFUSES TO DO:
 *
 *  - It renders no coverage percentage, no safety score and no share of value
 *    tested. There is no denominator: nothing here establishes a complete asset
 *    inventory, so any percentage would be arithmetic over an unknown whole.
 *
 *  - It never sorts or styles market value above evidence. "Estimated value" is
 *    a subordinate column in muted type, because it is not value at risk, not
 *    drainable value and not trapped funds.
 *
 *  - It never hides a row for lack of a price. A row with real balance or fork
 *    evidence and no usable USD figure is exactly the row worth showing.
 *
 *  - It shows names and logos as explicitly unverified. Live wallet data
 *    contains phishing lures as token names; identity is the address and chain,
 *    which is what the mono column carries.
 */
import { useState } from "react";
import type { ReactElement } from "react";
import type { AssetCoverage, AssetCoverageRow, BalanceEvidence, MobulaObservation } from "@shared/coverage";
import { CopyButton } from "./CopyButton.js";

/** Short, concrete status text. Each state is a distinct claim, never a rung on one ladder. */
function mobulaLabel(m: MobulaObservation): { text: string; tone: "" | "warn" } {
  switch (m.state) {
    case "observed":
      return { text: "Observed in snapshot", tone: "" };
    case "not_listed":
      return { text: "Not listed in this snapshot", tone: "warn" };
    case "chain_unclear":
      return { text: "Chain attribution unclear", tone: "warn" };
    default:
      return { text: "Mobula data unavailable", tone: "warn" };
  }
}

function balanceLabel(b: BalanceEvidence): { text: string; tone: "" | "good" | "warn" } {
  switch (b.state) {
    case "verified":
      // "Verified" is about the BALANCE READ, not about the token being safe or
      // legitimate. The detail panel spells that out.
      return { text: `Balance verified at block ${b.block}`, tone: "good" };
    case "read_failed":
      return { text: "Balance read failed", tone: "warn" };
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
      {row.balance.state === "verified" ? (
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
              <td>{row.balance.evidenceCount} recorded read(s) in `dependencies.tokens[].balanceEvidence`</td>
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
              <span className="step">{experiment.kind === "withdrawal_restriction" ? "W" : "U"}</span>
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

export function AssetCoveragePanel({ coverage }: { coverage: AssetCoverage }): ReactElement {
  const [open, setOpen] = useState<string | null>(null);
  const p = coverage.provenance;

  return (
    <section className="card">
      <h2>Assets &amp; analysis coverage</h2>
      <p className="note" style={{ marginTop: 0, maxWidth: "78ch" }}>
        See which assets were observed, which balances were verified at the analysis block, and which assets were
        included in a fork experiment.
      </p>

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

      {/* Counts, each with its scope stated. They overlap and are never combined. */}
      {/* NOT `.row`: that gives every child `flex: 1`, which stretches these
          into full-width boxes instead of the compact chips they are. */}
      <div className="chip-row">
        <span className="chip">
          {coverage.counts.mobulaEntriesAvailable ?? "—"} entries available in this snapshot
        </span>
        <span className="chip">{coverage.counts.mobulaEntriesShown} shown here</span>
        <span className="chip">{coverage.counts.assetsWithBalanceEvidence} with recorded target-balance evidence</span>
        <span className="chip">{coverage.counts.assetsInWithdrawalExperiment} in a withdrawal experiment</span>
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

      {coverage.rows.length === 0 ? (
        <div className="empty">
          No assets could be listed: there is no Mobula snapshot for this target and the report records no
          asset-level balance or fork evidence.
        </div>
      ) : (
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
              {coverage.rows.map((row) => {
                const m = mobulaLabel(row.mobula);
                const b = balanceLabel(row.balance);
                const isOpen = open === row.identity.key;
                return (
                  <tr key={row.identity.key}>
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
                      <span className={`chip ${m.tone}`}>{m.text}</span>
                    </td>
                    <td>
                      <span className={`chip ${b.tone}`}>{b.text}</span>
                    </td>
                    <td>
                      {row.experiments.length === 0 ? (
                        <span className="chip warn">
                          {row.forkGap?.state === "unlinkable" ? "Coverage not establishable" : "No test run"}
                        </span>
                      ) : (
                        row.experiments.map((e, i) => (
                          <div key={i} style={{ marginBottom: 3 }}>
                            <span className={`chip ${e.execution === "completed" ? "" : "warn"}`}>
                              {e.label}: {e.execution.replace(/_/g, " ")}
                            </span>
                          </div>
                        ))
                      )}
                    </td>
                    {/* Subordinate: muted, right-aligned, never a sort key above evidence. */}
                    <td className="mono muted" style={{ textAlign: "right" }}>
                      {row.mobula.state === "observed" ? usd(row.mobula.valuationUsd) : "—"}
                    </td>
                    <td>
                      <button className="link small" type="button" onClick={() => setOpen(isOpen ? null : row.identity.key)}>
                        {isOpen ? "Hide" : "View evidence"}
                      </button>
                      {isOpen && (
                        <div className="coverage-detail-wrap">
                          <RowDetail row={row} />
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
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
