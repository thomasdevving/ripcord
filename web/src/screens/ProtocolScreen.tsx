import { useCallback, useEffect, useState } from "react";
import type { ConfigResponse } from "@shared/dto";
import type { ProtocolDetailResponse, ProtocolScanView } from "@shared/protocols";
import { ApiRequestError, getProtocol, startProtocolScan } from "../api.js";
import { navigate } from "../router.js";
import type { ReactElement } from "react";

const active = (scan: ProtocolScanView): boolean => scan.state === "queued" || scan.state === "running";

export function ProtocolScreen({ protocolId, config }: { protocolId: string; config: ConfigResponse | null }): ReactElement {
  const [detail, setDetail] = useState<ProtocolDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setDetail(await getProtocol(protocolId));
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiRequestError ? caught.api.message : "The protocol could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [protocolId]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!detail?.scans.some(active)) return;
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => window.clearInterval(timer);
  }, [detail, refresh]);

  const start = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    const storageKey = `ripcord.protocol-scan.${protocolId}`;
    let key = sessionStorage.getItem(storageKey);
    if (!key) { key = crypto.randomUUID(); sessionStorage.setItem(storageKey, key); }
    try {
      await startProtocolScan(protocolId, key);
      sessionStorage.removeItem(storageKey);
      await refresh();
    } catch (caught) {
      setError(caught instanceof ApiRequestError ? caught.api.message : "The protocol scan could not be started.");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <main className="container protocol-page"><div className="empty">Loading protocol…</div></main>;
  if (!detail) return <main className="container protocol-page"><div className="banner warn">{error ?? "Protocol not found."}</div></main>;

  const hasScans = detail.scans.length > 0;
  const hasActive = detail.scans.some(active);
  const disabled = submitting || hasActive || config?.liveRuns.enabled !== true;

  return (
    <main className="container protocol-page">
      <p className="crumb"><button className="link" type="button" onClick={() => navigate({ name: "protocols" })}>← Protocols</button></p>
      <div className="page-heading-row protocol-detail-head">
        <div>
          <p className="section-label">Protocol timeline</p>
          <h1>{detail.protocol.name}</h1>
          <p className="note protocol-intro">
            Every contract in a scan is pinned to the same block. Rescans compare authority, privileged capabilities,
            Exit Window, time to exit, verdict, and analysis coverage against the immediately preceding scan. Protocol
            batches currently use static scan mode; the single-contract analysis page remains the place for fork experiments.
          </p>
        </div>
        <button type="button" className="btn primary" disabled={disabled} onClick={() => void start()}>
          {submitting ? "Starting…" : hasScans ? "Rescan protocol" : "Establish baseline"}
        </button>
      </div>
      {config && !config.liveRuns.enabled && <div className="banner warn"><strong>New scans are unavailable.</strong> {config.liveRuns.reason}</div>}
      {error && <div className="banner warn">{error}</div>}

      <section className="card protocol-contracts">
        <div className="pane-heading"><div><h2>Contracts in scope</h2><p>This definition is the explicit boundary of every protocol scan.</p></div></div>
        <div className="protocol-contract-grid">
          {detail.protocol.targets.map((target) => <div className="protocol-contract" key={target.id}><strong>{target.label}</strong><span className="addr">{target.address}</span><span className="small muted">Ethereum Mainnet</span></div>)}
        </div>
      </section>

      <section className="protocol-history">
        <div className="pane-heading"><div><h2>Scan history</h2><p>The first complete run is the baseline. Each later run is compared with the point immediately before it.</p></div></div>
        {!hasScans && <div className="empty">No baseline has been established.</div>}
        {detail.scans.map((scan) => <ScanCard key={scan.id} scan={scan} />)}
      </section>
    </main>
  );
}

function ScanCard({ scan }: { scan: ProtocolScanView }): ReactElement {
  return (
    <article className="card protocol-scan-card">
      <div className="protocol-scan-head">
        <div>
          <span className="section-label">{scan.kind === "baseline" ? "Baseline" : `Rescan ${scan.sequence - 1}`}</span>
          <h3>{new Date(scan.createdAt).toLocaleString()}</h3>
        </div>
        <span className={`chip ${scan.state === "partial" || scan.state === "failed" ? "warn" : ""}`}>{scan.state}</span>
      </div>

      <div className="protocol-target-results">
        {scan.targets.map((target) => (
          <div className="protocol-target-result" key={target.targetId}>
            <span><strong>{target.label}</strong><span className="addr">{target.address}</span></span>
            <span className="mono small">{target.block ? `block ${target.block}` : "block unavailable"}</span>
            <span className="chip">{target.state.replace(/_/g, " ")}</span>
            {target.reportId ? <button className="link" type="button" onClick={() => navigate({ name: "report", reportId: target.reportId as string })}>Open report</button>
              : target.jobId && (target.state === "queued" || target.state === "running") ? <button className="link" type="button" onClick={() => navigate({ name: "analysis", jobId: target.jobId as string })}>Watch run</button>
              : <span className="small muted">{target.disclosure?.publishable === false ? "Withheld for review" : target.error?.message ?? "No report"}</span>}
          </div>
        ))}
      </div>

      {scan.kind === "baseline" && scan.state === "completed" && (
        <div className="comparison-summary"><strong>Baseline established.</strong> Later runs will compare against this pinned state.</div>
      )}
      {scan.comparison && <Comparison scan={scan} />}
    </article>
  );
}

function Comparison({ scan }: { scan: ProtocolScanView }): ReactElement {
  const comparison = scan.comparison!;
  const complete = comparison.comparableTargets === comparison.totalTargets && comparison.gaps.length === 0;
  return (
    <div className="comparison">
      <div className="comparison-summary">
        <strong>{comparison.totalChanges === 0 && complete ? "No semantic changes observed." : `${comparison.totalChanges} semantic change${comparison.totalChanges === 1 ? "" : "s"} recorded.`}</strong>
        <span>{comparison.comparableTargets} of {comparison.totalTargets} contracts could be compared with the preceding scan.</span>
      </div>
      {comparison.gaps.map((gap) => <div className="banner warn small" key={gap.targetId}><strong>{gap.label}:</strong> {gap.reason}</div>)}
      {comparison.targets.map((target) => (
        <div className="target-comparison" key={target.targetId}>
          <div className="target-comparison-head">
            <div><h4>{target.label}</h4><span className="mono small muted">block {target.beforeBlock} → {target.afterBlock}</span></div>
            <span className="chip">{target.changes.length} change{target.changes.length === 1 ? "" : "s"}</span>
          </div>
          {target.changes.length === 0 ? <p className="note small">No differences were found in the semantic fields this comparator covers.</p> : (
            <div className="change-list">
              {target.changes.map((change) => (
                <details className="change-row" key={change.id}>
                  <summary><span className={`chip ${change.attention === "high" ? "warn" : ""}`}>{change.attention}</span><strong>{change.title}</strong></summary>
                  <div className="change-values"><div><span>Before</span><code>{change.before}</code></div><div><span>After</span><code>{change.after}</code></div></div>
                  <p className="small muted mono">{change.beforePath}</p>
                </details>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
