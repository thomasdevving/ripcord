/**
 * A stored report at a shareable URL.
 *
 * NO ANALYSIS ANIMATION HERE. Opening a saved report must not replay a phase
 * timeline: this is a historical artifact being read, not a scan being run, and
 * animating it would suggest fresh work is happening against the chain. The
 * provenance block inside the report states when it was generated, at which
 * block, and under which ruleset.
 *
 * A blocked report renders the server's neutral refusal. The body never reached
 * this process, so there is nothing here to accidentally reveal.
 */
import { useEffect, useState } from "react";
import { ReportView } from "../components/ReportView.js";
import { ForkEvidence } from "../components/ForkEvidence.js";
import { asReport, type Report } from "../report-types.js";
import { getReport, ApiRequestError } from "../api.js";
import { navigate } from "../router.js";
import { forkBlocksFromReport } from "../fork-blocks.js";
import type { ReactElement } from "react";

export function ReportScreen({ reportId }: { reportId: string }): ReactElement {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<{ message: string; blocked: boolean } | null>(null);

  useEffect(() => {
    getReport(reportId)
      .then((res) => {
        const parsed = asReport(res.report);
        if (parsed) setReport(parsed);
        else setError({ message: "That report was returned in a shape this page does not recognise.", blocked: false });
      })
      .catch((err) => {
        if (err instanceof ApiRequestError) {
          setError({ message: err.api.message, blocked: err.api.code === "report_blocked" });
        } else {
          setError({ message: "That report could not be loaded.", blocked: false });
        }
      });
  }, [reportId]);

  if (error) {
    return (
      <main className="container">
        <section className="card">
          <h2>{error.blocked ? "Report withheld" : "Report unavailable"}</h2>
          <div className={`banner ${error.blocked ? "warn" : "info"}`}>{error.message}</div>
          <button type="button" onClick={() => navigate({ name: "saved" })}>
            Back to saved reports
          </button>
        </section>
      </main>
    );
  }

  if (!report) {
    return (
      <main className="container">
        <div className="empty">Loading report…</div>
      </main>
    );
  }

  const fork = forkBlocksFromReport(report);

  return (
    <main className="container wide">
      <div className="banner info">
        This is a stored report, read as it was written. It describes chain state at block{" "}
        <span className="mono">{report.block.number}</span> and was generated on {report.generatedAt.slice(0, 10)} under
        ruleset {report.rulesetVersion}. No chain read happens when you open this page.
      </div>
      <ReportView
        report={report}
        reportId={reportId}
        forkEvidence={
          fork && report.exitRestriction ? (
            <ForkEvidence
              fork={fork}
              ceiling={report.exitRestriction.ceiling}
              sandboxNote={report.exitRestriction.sandboxNote}
              // A stored report is by definition a finished run.
              finished
            />
          ) : null
        }
      />
    </main>
  );
}
