/**
 * Saved reports. Two origins, labelled as such and never blended: `live`,
 * produced by this deployment under the ruleset it is running now, and
 * `calibration`, committed historical evidence preserved AT THE VERSION THAT
 * PRODUCED IT. Several of those predate checks the current engine performs, and
 * presenting an older fork evaluation as though it had passed today's economic
 * and causal verification would be a claim about work that was never done — so
 * the ruleset column is shown for every row.
 *
 * Blocked reports do not appear. A row reading "withheld: <protocol>" is itself a
 * signal about that protocol, and this listing is public; the count of withheld
 * entries is in the server's startup log.
 */
import { useEffect, useState } from "react";
import type { SavedReportListItem } from "@shared/dto";
import { listReports } from "../api.js";
import { navigate } from "../router.js";
import type { ReactElement } from "react";

export function SavedReportsScreen(): ReactElement {
  const [reports, setReports] = useState<SavedReportListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentRuleset, setCurrentRuleset] = useState<string | null>(null);

  useEffect(() => {
    listReports()
      .then((res) => {
        setReports(res.reports);
        // The newest live report's ruleset is the best available marker for
        // "what this deployment produces now"; without one we simply do not
        // claim a comparison.
        setCurrentRuleset(res.reports.find((r) => r.origin === "live")?.rulesetVersion ?? null);
      })
      .catch(() => setError("Saved reports could not be loaded."));
  }, []);

  return (
    <main className="container">
      <section className="card">
        <h1>Saved reports</h1>
        <p className="note" style={{ marginTop: 0 }}>
          Each of these opens as it was written, with its own block, generation date and ruleset version. Opening one
          reads no chain data and starts no analysis.
        </p>

        {error && <div className="banner warn">{error}</div>}
        {reports === null && !error && <div className="empty">Loading…</div>}
        {reports && reports.length === 0 && (
          <div className="empty">No readable reports yet. Run an analysis and the result will be listed here.</div>
        )}

        {reports && reports.length > 0 && (
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>Target</th>
                  <th>Verdict</th>
                  <th>Block</th>
                  <th>Generated</th>
                  <th>Ruleset</th>
                  <th>Origin</th>
                </tr>
              </thead>
              <tbody>
                {reports.map((report) => (
                  <tr key={report.id}>
                    <td>
                      <button className="link" type="button" onClick={() => navigate({ name: "report", reportId: report.id })}>
                        {report.title}
                      </button>
                      <div className="addr">{report.address}</div>
                    </td>
                    <td>
                      <span className={`chip ${report.verdictStatus === "no_notice" || report.verdictStatus === "trapped" ? "crit" : ""}`}>
                        {report.verdictStatus?.replace(/_/g, " ") ?? "none"}
                      </span>
                      {report.hasExitRestriction && (
                        <div className="small muted" style={{ marginTop: 3 }}>
                          includes a fork experiment
                        </div>
                      )}
                    </td>
                    <td className="mono">{report.block}</td>
                    <td className="small">{report.generatedAt.slice(0, 10)}</td>
                    <td className="mono small">
                      {report.rulesetVersion}
                      {currentRuleset && report.rulesetVersion !== currentRuleset && (
                        <div className="muted" style={{ fontSize: 10.5 }}>
                          earlier than current ({currentRuleset})
                        </div>
                      )}
                    </td>
                    <td>
                      <span className="chip">{report.origin}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="note small" style={{ marginTop: 14 }}>
          Reports marked <strong>calibration</strong> are committed historical evidence kept at the ruleset that produced
          them. Where such a report contains a fork evaluation, that evaluation ran under the checks of its own version —
          it has not been re-run under any later ones.
        </p>
      </section>
    </main>
  );
}
