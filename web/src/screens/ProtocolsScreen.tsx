import { useEffect, useState, type FormEvent } from "react";
import type { ProtocolListItem } from "@shared/protocols";
import { ApiRequestError, createProtocol, listProtocols } from "../api.js";
import { navigate } from "../router.js";
import type { ReactElement } from "react";

interface TargetDraft { label: string; address: string }
const blankTarget = (): TargetDraft => ({ label: "", address: "" });
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function ProtocolsScreen(): ReactElement {
  const [protocols, setProtocols] = useState<ProtocolListItem[] | null>(null);
  const [name, setName] = useState("");
  const [targets, setTargets] = useState<TargetDraft[]>([blankTarget()]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listProtocols().then((result) => setProtocols(result.protocols)).catch(() => setError("Protocol workspaces could not be loaded."));
  }, []);

  const valid = name.trim().length >= 2 && targets.every((target) => ADDRESS_RE.test(target.address.trim()));
  const updateTarget = (index: number, patch: Partial<TargetDraft>) => {
    setTargets((current) => current.map((target, position) => position === index ? { ...target, ...patch } : target));
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await createProtocol({
        name: name.trim(),
        targets: targets.map((target, index) => ({
          label: target.label.trim() || `Contract ${index + 1}`,
          address: target.address.trim(),
          chainId: 1,
        })),
      });
      navigate({ name: "protocol", protocolId: result.protocol.id });
    } catch (caught) {
      setError(caught instanceof ApiRequestError ? caught.api.message : "The protocol workspace could not be created.");
      setSubmitting(false);
    }
  };

  return (
    <main className="container protocol-page">
      <div className="page-heading-row">
        <div>
          <p className="section-label">Protocol timeline</p>
          <h1>Protocols</h1>
          <p className="note protocol-intro">
            Group related contracts, establish one block-consistent baseline, and compare a later scan by meaning rather
            than by raw JSON. A quiet comparison only covers the fields and reports named in it; it is never a safety claim.
          </p>
        </div>
      </div>

      {error && <div className="banner warn">{error}</div>}

      <section className="card protocol-create">
        <div className="pane-heading">
          <div>
            <h2>Create a protocol workspace</h2>
            <p>Name the deployed contracts that belong in one review. This first version supports up to four Ethereum Mainnet contracts.</p>
          </div>
        </div>
        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="protocol-name">Protocol name</label>
            <input id="protocol-name" type="text" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} placeholder="e.g. Compound III USDC market" />
          </div>
          <div className="protocol-target-editor">
            {targets.map((target, index) => (
              <div className="protocol-target-inputs" key={index}>
                <div className="field">
                  <label htmlFor={`target-label-${index}`}>Contract label</label>
                  <input id={`target-label-${index}`} type="text" value={target.label} onChange={(event) => updateTarget(index, { label: event.target.value })} maxLength={80} placeholder={`Contract ${index + 1}`} />
                </div>
                <div className="field protocol-address-field">
                  <label htmlFor={`target-address-${index}`}>Contract address</label>
                  <input id={`target-address-${index}`} type="text" className="mono" value={target.address} onChange={(event) => updateTarget(index, { address: event.target.value })} spellCheck={false} placeholder="0x…" aria-invalid={target.address.length > 0 && !ADDRESS_RE.test(target.address.trim())} />
                </div>
                {targets.length > 1 && (
                  <button type="button" className="btn secondary target-remove" onClick={() => setTargets((current) => current.filter((_, position) => position !== index))}>Remove</button>
                )}
              </div>
            ))}
          </div>
          <div className="form-actions">
            <button type="button" className="btn secondary" disabled={targets.length >= 4} onClick={() => setTargets((current) => [...current, blankTarget()])}>Add contract</button>
            <button type="submit" className="btn primary" disabled={!valid || submitting}>{submitting ? "Creating…" : "Create workspace"}</button>
          </div>
        </form>
      </section>

      <section className="protocol-list-section">
        <div className="pane-heading"><div><h2>Saved protocols</h2><p>Each scan remains a separate, pinned point in the protocol timeline.</p></div></div>
        {protocols === null && !error && <div className="empty">Loading…</div>}
        {protocols?.length === 0 && <div className="empty">No protocols yet. Create one above, then establish its baseline.</div>}
        <div className="protocol-list">
          {protocols?.map((protocol) => (
            <button key={protocol.id} type="button" className="protocol-row" onClick={() => navigate({ name: "protocol", protocolId: protocol.id })}>
              <span><strong>{protocol.name}</strong><span className="small muted">{protocol.targets.length} contract{protocol.targets.length === 1 ? "" : "s"}</span></span>
              <span><strong>{protocol.scanCount}</strong><span className="small muted">scan{protocol.scanCount === 1 ? "" : "s"}</span></span>
              <span className="protocol-row-state">{protocol.lastScanState ? <span className={`chip ${protocol.lastScanState === "partial" || protocol.lastScanState === "failed" ? "warn" : ""}`}>{protocol.lastScanState}</span> : <span className="muted small">No baseline</span>}</span>
              <span aria-hidden="true">→</span>
            </button>
          ))}
        </div>
      </section>
    </main>
  );
}
