/**
 * The live analysis page: one page that GROWS while the engine works. A run
 * header stays visible throughout, then the phase timeline, the power map with
 * its detail panel, the fork evidence, and the finished report — in the same
 * visual structure, so the report is where the story arrives rather than a
 * different document.
 *
 * TWO THINGS THIS SCREEN IS CAREFUL ABOUT:
 *  1. TECHNICAL COMPLETION IS NOT SUBSTANTIVE CERTAINTY. A run can finish every
 *     phase cleanly and still produce `undetermined`, so "the run completed" and
 *     "what was concluded" are separate lines, never merged into one "done ✓".
 *  2. SECTIONS ARE RESERVED, NOT POPPED IN. The fork and report blocks hold
 *     their place with an explicit "not run yet", so the page does not jump under
 *     a reader mid-sentence.
 */
import { useEffect, useState } from "react";
import { useJob } from "../useJob.js";
import { PhaseTimeline, currentPhaseLabel } from "../components/PhaseTimeline.js";
import { PowerMap } from "../components/PowerMap.js";
import { DetailPanel } from "../components/DetailPanel.js";
import { ForkEvidence } from "../components/ForkEvidence.js";
import { ReportView } from "../components/ReportView.js";
import { asReport, type Report } from "../report-types.js";
import { getReport, cancelJob } from "../api.js";
import { readControlToken, forgetControlToken } from "../control.js";
import { navigate } from "../router.js";
import { isTerminal } from "@shared/dto";
import { preferLiveBlocks } from "../fork-blocks.js";
import { AssetCoveragePanel } from "../components/AssetCoverage.js";
import { useAssetCoverage } from "../useAssetCoverage.js";
import type { ReactElement } from "react";

function useElapsed(startedAt: string | null, endedAt: string | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt || endedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt, endedAt]);
  if (!startedAt) return "—";
  const end = endedAt ? Date.parse(endedAt) : now;
  const seconds = Math.max(0, Math.round((end - Date.parse(startedAt)) / 1000));
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

export function AnalysisScreen({ jobId }: { jobId: string }): ReactElement {
  const job = useJob(jobId);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [publishedStructure, setPublishedStructure] = useState<import("@shared/dto").StructuralSnapshot | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const { coverage, enriched, gaveUp: coverageStalled } = useAssetCoverage(job.reportId);
  const elapsed = useElapsed(job.summary?.startedAt ?? null, job.summary?.endedAt ?? null);
  const controlToken = readControlToken(jobId);

  useEffect(() => {
    if (!job.reportId) return;
    getReport(job.reportId)
      .then((res) => {
        setPublishedStructure(res.structure);
        const parsed = asReport(res.report);
        if (parsed) setReport(parsed);
        else setReportError("The report was returned in a shape this page does not recognise.");
      })
      .catch(() => setReportError("The report could not be loaded."));
  }, [job.reportId]);

  if (job.loadError) {
    return (
      <main className="container">
        <div className="banner warn">{job.loadError}</div>
        <button type="button" onClick={() => navigate({ name: "home" })}>
          Start a new analysis
        </button>
      </main>
    );
  }

  const summary = job.summary;
  const state = summary?.state ?? "queued";
  const running = state === "running" || state === "queued";
  const phase = currentPhaseLabel(job.phases);
  // Live events while the run is in flight; the report's own evidence after a
  // reload, when there are no events left to replay. Without the fallback a
  // refreshed page says "the withdrawal experiment did not run" about a
  // differential that ran and found a restrictor.
  const forkBlocks = preferLiveBlocks(job.fork, report);
  const forkRan = Boolean(forkBlocks.baseline || forkBlocks.mutation || forkBlocks.reexit);
  const forkMode = summary?.mode !== "scan";

  return (
    <>
      <div className="runbar">
        <div className="item">
          <span className="k">Contract</span>
          <span className="v">{summary?.address ?? "—"}</span>
        </div>
        <div className="item">
          <span className="k">Chain</span>
          <span className="v">Ethereum Mainnet ({summary?.chainId ?? 1})</span>
        </div>
        <div className="item">
          <span className="k">Analysis layer</span>
          <span className="v">{summary?.refreshAssetContext ? "Core + Mobula 2nd layer" : "Ripcord core"}</span>
        </div>
        <div className="item">
          <span className="k">Pinned block</span>
          <span className="v">
            {summary?.block ?? "—"}
            {summary?.blockSource === "resolved_latest" && <span className="muted"> (resolved at start)</span>}
          </span>
        </div>
        <div className="item">
          <span className="k">Progress channel</span>
          {/* Whether the progress channel is streaming or polling is an
              infrastructure fact, kept visibly separate from anything the
              analysis concluded. */}
          <span className="v">{job.transport === "sse" ? "live stream" : job.transport === "polling" ? "polling" : job.transport}</span>
        </div>
        <div className="item">
          <span className="k">Scan reads / cache hits</span>
          <span className="v">{summary?.runtimeStats ? `${summary.runtimeStats.scanReadOperations} / ${summary.runtimeStats.scanCacheHits}` : "not measured"}</span>
        </div>
        <div className="item">
          <span className="k">Elapsed</span>
          <span className="v">{elapsed}</span>
        </div>
        <div className="item">
          <span className="k">State</span>
          <span className="v">
            {state}
            {phase && running && <span className="muted"> · {phase}</span>}
            {state === "queued" && summary?.queuePosition && <span className="muted"> · position {summary.queuePosition}</span>}
          </span>
        </div>
        {running && controlToken && (
          <button
            className="shrink"
            type="button"
            onClick={async () => {
              try { await cancelJob(jobId, controlToken); forgetControlToken(jobId); setCancelError(null); }
              catch { setCancelError("Cancellation was not confirmed. Your control token is retained; retry if the analysis is still running."); }
            }}
          >
            Cancel
          </button>
        )}
      </div>

      <main className="container wide">
        {cancelError && <div className="banner warn">{cancelError}</div>}
        {summary?.error && (
          <div className="banner danger">
            <strong>{summary.error.message}</strong>
            {summary.error.hint && <div style={{ marginTop: 4 }}>{summary.error.hint}</div>}
            <div className="small" style={{ marginTop: 6 }}>
              Job id for correlation: <span className="mono">{jobId}</span>
            </div>
          </div>
        )}

        {state === "interrupted" && (
          <div className="banner warn">
            This analysis was interrupted by a service restart, so it did not complete. Nothing about the contract
            follows from an interrupted run.
          </div>
        )}

        {isTerminal(state) && state === "completed" && (
          <div className="banner info">
            <strong>The run completed.</strong> That is a statement about the process. What it concluded — including
            whether it could conclude at all — is the verdict below.
          </div>
        )}

        <section className="card">
          <h3>Phases</h3>
          <PhaseTimeline phases={job.phases} />
          {job.phases.find((p) => p.status === "running")?.detail && (
            <p className="note small" style={{ marginBottom: 0, marginTop: 10 }}>
              {job.phases.find((p) => p.status === "running")?.detail}
            </p>
          )}
        </section>

        <div className="split analysis-layout">
          <section className="card">
            <h2>Power map</h2>
            <p className="note" style={{ marginTop: 0 }}>
              Every node comes from a read Ripcord performed. An edge records an observed relation — it is not evidence
              that the holder can pass its own authorisation.
            </p>
            <PowerMap snapshot={publishedStructure ?? job.structure} selected={selected} onSelect={setSelected} />
          </section>
          <DetailPanel snapshot={publishedStructure ?? job.structure} selected={selected} onClose={() => setSelected(null)} />
        </div>

        {forkMode &&
          (forkRan ? (
            <ForkEvidence fork={forkBlocks} finished={isTerminal(state)} />
          ) : (
            <section className="card">
              <h2>The withdrawal experiment</h2>
              <p className="note" style={{ marginBottom: 0 }}>
                {running
                  ? "Waiting for the static scan to finish. The experiment needs the decoded selector surface before it can identify the exit action."
                  : "The withdrawal experiment did not run for this target. The reason appears in the report's fork section below."}
              </p>
            </section>
          ))}

        {job.blockedMessage && (
          <section className="card">
            <h2>Report withheld</h2>
            {/* The neutral refusal, verbatim from the server. It names nothing
                that was blocked — a message describing the finding would leak
                exactly what the gate is holding back. */}
            <div className="banner warn" style={{ marginBottom: 0 }}>
              {job.blockedMessage}
            </div>
          </section>
        )}

        {reportError && <div className="banner warn">{reportError}</div>}
        {report && (
          <ReportView
            report={report}
            reportId={job.reportId}
            assetEvidence={
              coverage ? <AssetCoveragePanel coverage={coverage} enriched={enriched} stalled={coverageStalled} /> : null
            }
          />
        )}

        {running && !report && (
          <section className="card">
            <h2>Report</h2>
            <p className="note" style={{ marginBottom: 0 }}>
              The report appears here when the analysis finishes and the publication gate has run. Nothing is concluded
              before then.
            </p>
          </section>
        )}
      </main>
    </>
  );
}
