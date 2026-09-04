/**
 * The enriched assessment, rendered alongside the coverage evidence and never
 * in place of the verdict.
 *
 * Two presentation rules follow from what this artifact is:
 *
 *   The report's own verdict is quoted from the assessment's provenance. A
 *   statement that reaches further than the verdict must never be readable as
 *   a replacement for it.
 *
 *   Only a demonstrated restriction gets emphasis. `no_change` and
 *   `not_applicable` are rendered in the neutral tone — this panel has no
 *   reassuring state, so nothing here may ever look like a clean bill.
 */
import type { ReactElement } from "react";
import type { EnrichedAssessment } from "@shared/enriched";

function short(address: string | null): string {
  if (!address) return "—";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function EnrichedAssessmentPanel({
  assessment,
  embedded = false,
}: {
  assessment: EnrichedAssessment;
  embedded?: boolean;
}): ReactElement | null {
  const { outcome, counts, provenance } = assessment;

  // Nothing was demonstrated and no sidecar applies: the report stands alone and
  // this panel would only add noise to it.
  if (outcome.status === "not_applicable") return null;

  const demonstrated = outcome.status === "scope_broadened" || outcome.status === "stricter_than_report";

  const Wrapper = embedded ? "div" : "section";
  return (
    <Wrapper className={`panel enriched-assessment${embedded ? " embedded" : ""}`} style={{ marginBottom: embedded ? 14 : undefined }}>
      <header>
        <h3 style={{ margin: 0 }}>Combined with the per-asset pass</h3>
        {assessment.experimental && <span className="chip warn">experimental</span>}
        <span className="chip">verdict unchanged</span>
      </header>

      {/* The verdict is quoted here so the reader never has to hold two
          artifacts in their head to know what the report itself concluded. */}
      <p className="small muted" style={{ marginTop: 6 }}>
        The pinned report's verdict is <strong>{provenance.reportVerdict.replace(/_/g, " ")}</strong> at block{" "}
        {provenance.analysisBlock}. Nothing below changes it.
      </p>

      {outcome.status === "unusable" && (
        <div className="banner warn">
          <strong>The per-asset results could not be attached to this report</strong>
          <div className="small" style={{ marginTop: 4 }}>{outcome.reason}</div>
          <ul className="small" style={{ marginTop: 4 }}>
            {outcome.mismatches.map((m, i) => <li key={i}>{m}</li>)}
          </ul>
        </div>
      )}

      {outcome.status === "no_change" && (
        <div className="banner info">
          <strong>Adds nothing to the report's conclusion</strong>
          <div className="small" style={{ marginTop: 4 }}>{outcome.reason}</div>
        </div>
      )}

      {demonstrated && (
        <div className="banner danger">
          <strong>
            {outcome.status === "scope_broadened"
              ? "The report's finding reaches further than its own experiment showed"
              : "Demonstrated on a fork, beyond what the report established"}
          </strong>
          <div className="small" style={{ marginTop: 4 }}>{outcome.statement}</div>
          <table style={{ marginTop: 8 }}>
            <thead>
              <tr><th>Asset</th><th>Guarding party</th><th>Notice</th><th>Sandbox holder</th></tr>
            </thead>
            <tbody>
              {outcome.confirmed.map((item) => (
                <tr key={item.address}>
                  <td>
                    <code>{short(item.address)}</code>
                    {item.unverifiedSymbol && (
                      // Never identity — the vendor chooses these strings.
                      <span className="small muted"> {item.unverifiedSymbol} (unverified)</span>
                    )}
                  </td>
                  <td>
                    <code>{short(item.guardian)}</code>
                    <span className="small muted"> {item.guardianType ?? "unclassified"}</span>
                  </td>
                  <td>{item.noticeSeconds === "0" ? "none on this route" : item.noticeSeconds === null ? "undetermined" : `${item.noticeSeconds}s`}</td>
                  <td><code>{short(item.holder)}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Overlapping counts, never combined into a score: there is no
          denominator, because nothing here establishes a complete asset set. */}
      <div className="chips" style={{ marginTop: 10 }}>
        <span className="chip">{counts.considered} candidate(s) considered</span>
        <span className="chip">{counts.confirmed} restriction(s) demonstrated</span>
        <span className="chip">{counts.noEffect} showed no effect</span>
        <span className="chip">{counts.unresolved} reached no conclusion</span>
      </div>

      {assessment.unconfirmed.length > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary className="small">
            Candidates that produced no restriction ({assessment.unconfirmed.length}) — listed so the total can be reconciled
          </summary>
          <table style={{ marginTop: 6 }}>
            <tbody>
              {assessment.unconfirmed.map((item) => (
                <tr key={item.address}>
                  <td><code>{short(item.address)}</code></td>
                  <td><span className="chip">{item.state.replace(/_/g, " ")}</span></td>
                  <td className="small muted">{item.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      <ul className="small muted" style={{ marginTop: 10 }}>
        {assessment.scopeNotes.map((note, i) => <li key={i}>{note}</li>)}
      </ul>
    </Wrapper>
  );
}
