import { PowerMap } from "../components/PowerMap.js";
import { DetailPanel } from "../components/DetailPanel.js";
import type { StructuralSnapshot } from "@shared/dto";
/**
 * A stored report at a shareable URL.
 *
 * NO ANALYSIS ANIMATION HERE. Opening a saved report must not replay a phase
 * timeline: this is a historical artifact being read, not a scan being run, and
 * animating it would suggest fresh work is happening against the chain. The
 * provenance block states when it was generated, at which block, and under which
 * ruleset.
 *
 * A blocked report renders the server's neutral refusal; the body never reached
 * this process, so there is nothing here to accidentally reveal.
 */
import { useEffect, useState } from "react";
import { ReportView } from "../components/ReportView.js";
import { ForkEvidence } from "../components/ForkEvidence.js";
import { asReport, type Report } from "../report-types.js";
import { getReport, ApiRequestError } from "../api.js";
import { navigate } from "../router.js";
import { forkBlocksFromReport } from "../fork-blocks.js";
import { AssetCoveragePanel } from "../components/AssetCoverage.js";
import { useAssetCoverage } from "../useAssetCoverage.js";
import type { ReactElement } from "react";

export function ReportScreen({ reportId }: { reportId: string }): ReactElement {
  const [structure, setStructure] = useState<StructuralSnapshot | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<{ message: string; blocked: boolean } | null>(null);
  // Fetched separately and allowed to fail on its own: a missing Mobula
  // snapshot or a coverage error must never take the report page down.
  const { coverage, enriched, gaveUp: coverageStalled } = useAssetCoverage(reportId);

  useEffect(() => {
    getReport(reportId)
      .then((res) => {
        setStructure(res.structure);
        // A stored report opens as a map, not as an empty inspector. Select the
        // target by default so the right-hand column immediately explains what
        // the left-hand schema is centred on; clicking any other node replaces
        // that context without changing the layout.
        setSelected(res.structure?.nodes.find((node) => node.kind === "target")?.address ?? null);
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
      <ReportView
        report={report}
        reportId={reportId}
        showHead
        // Below the verdict, not above it. The map explains HOW the answer
        // comes about; a reader arriving on a shared link should meet the
        // answer first and the mechanism second.
        powerMap={
          <div className="split report-map-layout">
            <section className="card report-map-card">
              <h2>Power map</h2>
              <p className="note report-map-description">
                Authority rises from the analyzed contract to the addresses and contracts that can control it. Select
                any node to inspect the observed relation and the reads behind it.
              </p>
              <PowerMap snapshot={structure} selected={selected} onSelect={setSelected} />
            </section>
            <DetailPanel snapshot={structure} selected={selected} onClose={() => setSelected(null)} />
          </div>
        }
        assetEvidence={
          coverage ? <AssetCoveragePanel coverage={coverage} enriched={enriched} stalled={coverageStalled} /> : null
        }
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
