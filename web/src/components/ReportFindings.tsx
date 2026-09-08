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
        {/* The qualification is one hover away rather than a paragraph under
            every heading. It is not optional text — it is what stops
            "Demonstrated" reading as a severity rating — so it is also printed
            in the fold at the top of this card, where it cannot be missed by
            someone who never hovers. */}
        <span className="finding-why" tabIndex={0} role="note" aria-label={gloss} title={gloss}>
          Why?
        </span>
      </h3>
      <ul className="finding-list">
        {findings.map((finding) => (
          <li className={`finding ${tone}`} key={finding.id}>
            {/* THE CLAIM STAYS VISIBLE; ITS QUALIFICATION FOLDS. A collapsed
                row still carries the finding and the layer that produced it,
                so scanning the list never means reading past the paragraph
                that explains each one. The detail is a fold rather than a
                truncation — nothing is cut, and the qualification a finding
                travels with is one click away rather than gone. */}
            <details className="finding-fold">
              <summary>
                <span className="finding-title">{finding.title}</span>
                <span className="finding-source mono">{finding.source}</span>
              </summary>
              {finding.detail && <p className="note small finding-detail">{finding.detail}</p>}
            </details>
            {/* Outside the fold: the way to the evidence must not itself be
                hidden behind a disclosure the reader has to find first. */}
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

      {/* The reading instructions are a fold, not a preamble. They matter — the
          groups are an evidence split and not a severity ranking, and someone
          who assumes otherwise misreads the whole page — but three paragraphs
          before the first finding pushed the findings themselves off the
          screen, which is its own way of not being read. */}
      <details className="fold inline-fold">
        <summary>
          <span>How to read this list</span>
          <span className="fold-hint">what the two groups mean, and what they do not</span>
        </summary>
        <div className="fold-body">
          <p className="note" style={{ marginTop: 0 }}>
            Every line restates a conclusion the analysis already reached and links to the pane holding its evidence.
            Nothing here is computed a second time.
          </p>
          <p className="note">
            <strong>Demonstrated</strong> — positively established: read at the analysed block, or executed on a sandbox
            fork. It describes what a privileged party is technically able to do; it never predicts that anyone will.
          </p>
          <p className="note">
            <strong>Unresolved</strong> — the analysis could not settle it. This is never a clean result: it is the part
            of the picture this run could not see, and it holds the verdict back from any reassuring tier.
          </p>
          <p className="note small" style={{ marginBottom: 0 }}>
            The two groups differ in what was <em>observed</em>, not in how severe anything is. This report computes no
            risk score, and the order of the list is not a ranking.
          </p>
        </div>
      </details>

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
