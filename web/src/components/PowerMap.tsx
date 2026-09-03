/**
 * The authority graph.
 *
 * LAYOUT IS DETERMINISTIC AND LAYERED, not a force simulation. Three reasons,
 * and the first is the one that matters:
 *
 *  1. The graph grows while the analysis runs. A force layout would rearrange
 *    every existing node each time one arrives, so the thing a viewer was
 *    reading moves out from under them — during a live demo, repeatedly. Here a
 *    node's position depends only on its depth and its address, so an arriving
 *    node takes a new slot and nothing already on screen moves.
 *  2. Two runs of the same target produce the same picture, which matters for a
 *    tool whose whole claim is reproducibility.
 *  3. Depth is meaningful in this domain — it is distance from the contract
 *    along the authority chain — so encoding it as vertical position tells the
 *    reader something true rather than being an arbitrary aesthetic.
 *
 * EVERY NODE COMES FROM A FOUND FACT. Nothing is inferred from an address's
 * shape. A Safe threshold is shown only where the classifier read one. An
 * unresolved controller stays on the graph as a visibly distinct node carrying
 * its termination reason, because dropping it would read as "nothing there" —
 * and "we stopped looking here" is the opposite of that.
 *
 * AN EDGE IS NOT A PROOF. It records an observed relation. That the holder can
 * actually pass its own authorisation (a Safe reaching its threshold, a timelock
 * queue elapsing) is not something a line on a diagram can establish, which is
 * why the labels describe the relation and never the outcome.
 */
import { useCallback, useMemo } from "react";
import { ReactFlow, Background, Controls, Handle, MarkerType, Position, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { StructuralEdge, StructuralNode, StructuralSnapshot } from "@shared/dto";
import type { ReactElement } from "react";

const NODE_W = 210;
const NODE_H = 84;
// Generous gaps because the EDGE LABELS need the room, not the nodes. Several
// relations converge on the target, and at a tighter spacing their labels
// overlapped into an unreadable run of text — "supplies co…can pause
// withdrawals of". fitView zooms to whatever this produces, so paying for
// legible labels in layout space costs nothing on screen.
const X_GAP = 150;
const Y_GAP = 160;

function short(address: string): string {
  return address.length > 14 ? `${address.slice(0, 8)}…${address.slice(-6)}` : address;
}

function RipcordNode({ data }: NodeProps): ReactElement {
  const node = data.node as StructuralNode;
  const selected = data.selected as boolean;
  const classes = [
    "node-box",
    node.kind === "target" ? "target" : "",
    `k-${node.kind === "implementation" ? "implementation" : node.terminationReason === "max_depth" || node.terminationReason === "no_authority_found" || node.terminationReason === "not followed by Ripcord" ? "unknown" : "known"}`,
    selected ? "selected" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const typeLabel =
    node.accountType === "safe"
      ? node.safeThreshold !== null && node.safeOwners !== null
        ? `Safe ${node.safeThreshold}-of-${node.safeOwners}`
        : "Safe"
      : node.accountType === "timelock"
        ? node.timelockDelaySeconds
          ? `Timelock ${node.timelockDelaySeconds}s`
          : "Timelock (delay undetermined)"
        : (node.accountType ?? "type not established");

  return (
    <div className={classes} title={node.relation}>
      {/*
        React Flow attaches edges to HANDLES. A custom node without them renders
        fine and every edge silently disappears — which is exactly what happened
        here: four correct nodes and not one of the relations between them. The
        handles are invisible (zero-opacity) because relations are conveyed by
        the drawn edge and its label, not by connection points the reader could
        mistake for something interactive.
        Authority rises UPWARD in this layout, so an authority node emits from
        its bottom edge and a controlled node receives at its top.
      */}
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} isConnectable={false} />
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} isConnectable={false} />
      <div className="n-kind">{node.kind === "target" ? "TARGET" : node.kind}</div>
      <div className="n-addr">{short(node.address)}</div>
      <div className="n-meta">{typeLabel}</div>
      {node.terminationReason && node.kind !== "target" && (
        <div className="n-meta muted" style={{ fontSize: 10 }}>
          stopped: {node.terminationReason}
        </div>
      )}
    </div>
  );
}

const nodeTypes = { ripcord: RipcordNode };

export function PowerMap({
  snapshot,
  selected,
  onSelect,
}: {
  snapshot: StructuralSnapshot | null;
  selected: string | null;
  onSelect: (address: string | null) => void;
}): ReactElement {
  const { nodes, edges } = useMemo(() => layout(snapshot, selected), [snapshot, selected]);

  const onNodeClick = useCallback(
    (_: unknown, node: Node) => onSelect(String(node.id)),
    [onSelect],
  );

  if (!snapshot || snapshot.nodes.length === 0) {
    return (
      <div className="graph-wrap">
        <div className="empty">
          The power map appears as the structural stages land: proxy slots, owner, role holders, then the authority
          chain behind each of them.
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="graph-wrap">
        <ReactFlow
          key={`rf-${nodes.length}-${edges.length}`}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodeClick={onNodeClick}
          onPaneClick={() => onSelect(null)}
          fitView
          // Padding so node boxes and their edge labels are not flush against
          // the frame. `key` below re-fits when the graph GROWS during a live
          // run: without it a node arriving after the initial fit lands
          // outside the viewport and is simply never seen.
          fitViewOptions={{ padding: 0.18, maxZoom: 1 }}
          // The layout is authoritative; dragging a node would suggest position
          // is cosmetic when it encodes authority depth.
          nodesDraggable={false}
          nodesConnectable={false}
          edgesFocusable={false}
          proOptions={{ hideAttribution: true }}
          minZoom={0.2}
          maxZoom={1.6}
        >
          <Background gap={18} size={1} />
          {/* fitView on the Controls is the reset: on a dense graph a viewer
              will zoom in, and needs one click back to the whole picture. */}
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <div className="legend">
        <span>
          <i className="sw solid" /> resolved relation
        </span>
        <span>
          <i className="sw dashed" /> implementation (supplies code — holds no power)
        </span>
        <span>
          <i className="sw dotted" /> unresolved / not followed
        </span>
        <span className="muted">An edge records an observed relation, not that the holder can pass its own authorisation.</span>
      </div>
    </>
  );
}

/**
 * Layered layout: depth determines the row, address ordering determines the
 * column. Pure and total — same input, same picture, every time.
 */
function layout(snapshot: StructuralSnapshot | null, selected: string | null): { nodes: Node[]; edges: Edge[] } {
  if (!snapshot) return { nodes: [], edges: [] };

  const byDepth = new Map<number, StructuralNode[]>();
  for (const node of snapshot.nodes) {
    const depth = Math.max(0, Math.min(node.depth, 6));
    const row = byDepth.get(depth) ?? [];
    row.push(node);
    byDepth.set(depth, row);
  }

  const nodes: Node[] = [];
  const depths = [...byDepth.keys()].sort((a, b) => a - b);
  for (const depth of depths) {
    // Stable ordering inside a row, so an arriving node never reshuffles the
    // ones already drawn.
    const row = (byDepth.get(depth) ?? []).slice().sort((a, b) => a.address.toLowerCase().localeCompare(b.address.toLowerCase()));
    const rowWidth = row.length * (NODE_W + X_GAP) - X_GAP;
    row.forEach((node, index) => {
      nodes.push({
        id: node.address,
        type: "ripcord",
        // Depth 0 (the target) at the bottom; authority rises above it, which
        // is how the chain reads in the report text too.
        position: { x: index * (NODE_W + X_GAP) - rowWidth / 2, y: -depth * Y_GAP },
        data: { node, selected: selected?.toLowerCase() === node.address.toLowerCase() },
        width: NODE_W,
        height: NODE_H,
        selectable: true,
      });
    });
  }

  const present = new Set(nodes.map((n) => n.id.toLowerCase()));
  const edges: Edge[] = snapshot.edges
    // An edge to a node we never placed would render as a line into empty
    // space. Drop the edge, never the node.
    .filter((e) => present.has(e.from.toLowerCase()) && present.has(e.to.toLowerCase()))
    .map((e: StructuralEdge, i) => ({
      id: `e${i}-${e.from}-${e.to}-${e.label}`,
      source: e.from,
      target: e.to,
      label: e.label,
      labelStyle: { fontSize: 10, fill: "var(--text-secondary)" },
      labelBgStyle: { fill: "var(--surface-1)", fillOpacity: 0.95 },
      labelBgPadding: [5, 3] as [number, number],
      labelBgBorderRadius: 3,
      style: {
        stroke: e.resolution === "unknown" ? "var(--warning)" : "var(--baseline)",
        strokeDasharray: e.resolution === "resolved" ? undefined : e.resolution === "partial" ? "5 3" : "2 3",
      },
      markerEnd: { type: MarkerType.ArrowClosed, color: e.resolution === "unknown" ? "var(--warning)" : "var(--baseline)" },
    }));

  return { nodes, edges };
}
