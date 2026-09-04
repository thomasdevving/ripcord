/**
 * The selection panel: what is known about one node, and how it was established.
 *
 * The ordering is deliberate — identity, then the observed relation, then
 * confidence, then the evidence. Confidence sits ABOVE the evidence rather than
 * as a footnote because a depth-3 attribution and a direct owner read look
 * equally definite once rendered as an address.
 *
 * Fields that were not established are shown as "not established", never omitted
 * and never zero: an absent Safe threshold means we did not read one, and
 * rendering it as "—" invites the reader to supply their own assumption.
 */
import type { StructuralNode, StructuralSnapshot } from "@shared/dto";
import { CopyButton } from "./CopyButton.js";
import type { ReactElement } from "react";

export function DetailPanel({
  snapshot,
  selected,
  onClose,
}: {
  snapshot: StructuralSnapshot | null;
  selected: string | null;
  onClose: () => void;
}): ReactElement {
  const node = snapshot?.nodes.find((n) => n.address.toLowerCase() === selected?.toLowerCase()) ?? null;

  if (!node) {
    return (
      <section className="card detail-panel">
        <h3>Details</h3>
        <p className="note" style={{ marginBottom: 0 }}>
          Select a node in the power map to see its full address, what relation was observed, at what confidence, and the
          reads behind it.
        </p>
      </section>
    );
  }

  const incoming = snapshot?.edges.filter((e) => e.to.toLowerCase() === node.address.toLowerCase()) ?? [];
  const outgoing = snapshot?.edges.filter((e) => e.from.toLowerCase() === node.address.toLowerCase()) ?? [];

  return (
    <section className="card detail-panel">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
        <h3 style={{ margin: 0 }}>{node.kind === "target" ? "Target" : node.kind}</h3>
        <button className="link small" type="button" onClick={onClose}>
          Clear
        </button>
      </div>

      <div style={{ margin: "10px 0" }}>
        <div className="addr" style={{ fontSize: 12.5 }}>
          {node.address}
        </div>
        <CopyButton value={node.address} label="Copy address" />
      </div>

      <table>
        <tbody>
          <tr>
            <th>Type</th>
            <td>{node.accountType ?? "not established"}</td>
          </tr>
          {node.accountType === "safe" && (
            <tr>
              <th>Threshold</th>
              <td>
                {node.safeThreshold !== null && node.safeOwners !== null
                  ? `${node.safeThreshold} of ${node.safeOwners} signers`
                  : "not established"}
              </td>
            </tr>
          )}
          {node.timelockDelaySeconds !== null && (
            <tr>
              <th>Delay</th>
              <td className="mono">{node.timelockDelaySeconds}s</td>
            </tr>
          )}
          <tr>
            <th>Depth</th>
            <td>{node.depth} hop(s) from the target</td>
          </tr>
          <tr>
            <th>Confidence</th>
            <td>
              {node.confidence ?? "not stated"}
              {node.confidence && node.depth > 1 && (
                <div className="note small" style={{ marginTop: 3 }}>
                  Confidence degrades with depth: a controller reached through several hops is not asserted with a direct
                  owner's certainty.
                </div>
              )}
            </td>
          </tr>
          {node.terminationReason && (
            <tr>
              <th>Resolution stopped</th>
              <td>
                {node.terminationReason}
                {(node.terminationReason === "max_depth" || node.terminationReason === "no_authority_found") && (
                  <div className="note small" style={{ marginTop: 3 }}>
                    This is where Ripcord stopped, not necessarily where the authority chain ends.
                  </div>
                )}
              </td>
            </tr>
          )}
          <tr>
            <th>How it was found</th>
            <td>{node.relation}</td>
          </tr>
        </tbody>
      </table>

      {outgoing.length > 0 && (
        <>
          <h3>Holds over others</h3>
          <ul className="plain">
            {outgoing.map((e, i) => (
              <li key={i}>
                {e.label} <span className="addr">{e.to}</span>{" "}
                <span className="chip">{e.resolution}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {incoming.length > 0 && (
        <>
          <h3>Held over this address</h3>
          <ul className="plain">
            {incoming.map((e, i) => (
              <li key={i}>
                <span className="addr">{e.from}</span> {e.label} this <span className="chip">{e.resolution}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {node.evidence?.length ? <details><summary>Recorded reads ({node.evidence.length})</summary><pre>{JSON.stringify(node.evidence, null, 2)}</pre></details> : <p className="note small">Exact reads become available after the report passes publication review.</p>}
    </section>
  );
}
