/**
 * The overview list: what this run established, and where the evidence is.
 *
 * IT RENDERS A PROJECTION, IT DOES NOT MAKE ONE. Every entry comes from
 * `deriveReportFindings` in server/shared/findings.ts — one implementation,
 * shared by whatever else needs the same list, so the browser cannot grow a
 * second opinion about what a report says.
 *
 * TWO GROUPS, AND THE HEADINGS SAY WHY THEY DIFFER. "Demonstrated" is what the
 * run positively established; "Unresolved" is what it could not settle. That is
 * a split by evidence, not a severity ranking, and the subheading states it so
 * a reader never infers a score the report does not compute. An empty list
 * prints `noFindingsNote` rather than nothing, because a list with no entries
 * is a fact about the list.
 */
import { deriveReportFindings, noFindingsNote, type ReportFinding, type FindingTab } from "@shared/findings";
import type { Report } from "../report-types.js";
import type { ReactElement } from "react";

function Group({
  title,
  gloss,
  tone,
  findings,
  onOpen,
}: {
  title: string;
  gloss: string;
  tone: "crit" | "warn";
  findings: ReportFinding[];
  onOpen: (finding: ReportFinding) => void;
}): ReactElement | null {
  if (findings.length === 0) return null;
  return (
    <div className="finding-group">
      <h3 className={`finding-group-title ${tone}`}>
        {title} <span className="finding-count">{findings.length}</span>
      </h3>
      <p className="note small finding-gloss">{gloss}</p>
      <ul className="finding-list">
        {findings.map((finding) => (
          <li className={`finding ${tone}`} key={finding.id}>
            <div className="finding-body">
              <p className="finding-title">{finding.title}</p>
              {finding.detail && <p className="note small finding-detail">{finding.detail}</p>}
              <span className="finding-source mono">{finding.source}</span>
            </div>
            <button type="button" className="shrink finding-link" onClick={() => onOpen(finding)}>
              View evidence
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ReportFindings({
  report,
  onOpen,
}: {
  report: Report;
  /** Switches the tab, scrolls to the anchor, and selects the named node when there is one. */
  onOpen: (tab: FindingTab, anchor: string, node: string | null) => void;
}): ReactElement {
  const findings = deriveReportFindings(report);
  const demonstrated = findings.filter((f) => f.severity === "demonstrated");
  const unresolved = findings.filter((f) => f.severity === "unresolved");
  const open = (finding: ReportFinding) => onOpen(finding.link.tab, finding.link.anchor, finding.link.node);

  return (
    <section className="card" id="findings">
      <h2>What this run established</h2>
      <p className="note" style={{ marginTop: 0 }}>
        Every line below restates a conclusion the analysis already reached and links to the pane holding its evidence.
        The two groups differ in what was <em>observed</em>, not in how severe anything is — this report computes no
        risk score.
      </p>

      <Group
        title="Demonstrated"
        gloss="Positively established: read at the analysed block, or executed on a sandbox fork. Capability, never intent — nothing here predicts that anyone will act."
        tone="crit"
        findings={demonstrated}
        onOpen={open}
      />
      <Group
        title="Unresolved"
        gloss="The analysis could not settle these. An unresolved entry is never a clean result: it is the part of the picture this run could not see, and it holds the verdict back from any reassuring tier."
        tone="warn"
        findings={unresolved}
        onOpen={open}
      />

      {findings.length === 0 && <p className="note">{noFindingsNote}</p>}
    </section>
  );
}
