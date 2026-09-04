import { forkTransactions as extractForkTransactions } from "../shared/fork.js";
/**
 * ENGINE OBSERVATIONS → TRANSPORT EVENTS, and the disclosure boundary governing
 * which of them may leave the process early. The only adapter between
 * src/report/observer.ts (in-process, sees everything) and the SSE stream.
 *
 *  1. THE EARLY-STREAM BOUNDARY. During a run the publication gate has not run,
 *     so a capability whose guard could not be attributed is still undecided;
 *     streaming its signature would publish a possible "this live contract may
 *     be unguarded" claim, and once a browser holds it no later decision takes
 *     it back. `onCapabilities` forwards COUNTS ONLY. The structural layer —
 *     proxy slots, owner, role holders, authority paths — may stream, because
 *     the gate never blocks on it.
 *  2. THE POWER MAP IS BUILT FROM FOUND FACTS ONLY. An unresolved authority
 *     stays in the graph as an explicit unknown node with its termination
 *     reason, because a missing node reads as "nothing there".
 *  3. EDGE DIRECTION IS EXPLICIT. `implementation` is drawn as "supplies code
 *     to", never as an owner: an implementation holds no power over the proxy.
 */
import type {
  AccessControlResult,
  AuthorityIndirection,
  AuthorityNode,
  AuthorityResolution,
  CapabilitiesResult,
  Disclosure,
  ExitWindow,
  OwnerField,
  PowerHolder,
  ProxyResult,
  TimeToExit,
  Verdict,
} from "../../src/report/schema.js";
import type { EngineStage, ForkStep, RunObserver, ForkObserver, StageEnd } from "../../src/report/observer.js";
import type { ForkTxView, PhaseId, PhaseStatus, StructuralEdge, StructuralNode, StructuralSnapshot } from "../shared/dto.js";
import type { WorkerEventPayload } from "./protocol.js";

/** Engine stage → UI phase. `block` folds into `report`: it is the last read of the composition step, not a phase of its own. */
const STAGE_TO_PHASE: Record<EngineStage, PhaseId> = {
  proxy: "proxy",
  ownership: "ownership",
  accessControl: "accessControl",
  capabilities: "capabilities",
  authorityResolution: "authorityResolution",
  authorityIndirection: "authorityIndirection",
  dependencies: "dependencies",
  exitWindow: "exitWindow",
  timeToExit: "timeToExit",
  block: "report",
  report: "report",
};

const OUTCOME_TO_STATUS: Record<StageEnd["outcome"], Extract<PhaseStatus, "completed" | "inconclusive" | "degraded">> = {
  completed: "completed",
  inconclusive: "inconclusive",
  degraded: "degraded",
};

/**
 * Accumulates the structural graph as stages land, and emits transport events.
 *
 * Stateful on purpose: the graph GROWS, and re-sending the whole snapshot on
 * each update (rather than diffs) is what lets a browser that reconnected
 * half-way through render a correct graph from a single event instead of
 * replaying a diff history it may have holes in.
 */
export class TransportObserver implements RunObserver, ForkObserver {
  private readonly authorityDepths = new Map<string, number>();
  private readonly nodes = new Map<string, StructuralNode>();
  private readonly edges: StructuralEdge[] = [];
  /** Parallel to `edges`: the identity key of each, so an edge can be upgraded in place. */
  private readonly edgeKeys: string[] = [];
  private proxyPattern: string | null = null;
  private implementation: string | null = null;

  constructor(
    private readonly target: string,
    private readonly emit: (payload: WorkerEventPayload) => void,
  ) {
    this.upsert({
      address: target,
      relation: "the contract under examination",
      kind: "target",
      accountType: "contract",
      safeThreshold: null,
      safeOwners: null,
      timelockDelaySeconds: null,
      terminationReason: null,
      confidence: null,
      depth: 0,
    });
  }

  // --- graph assembly --------------------------------------------------------

  private key(address: string): string {
    return address.toLowerCase();
  }

  /**
   * Adds or enriches a node. Enrichment never DOWNGRADES a field: a later stage
   * that knows less (an authority walk reaching an address it could not
   * classify) must not erase what an earlier stage positively established. The
   * merge therefore only fills nulls, except for `kind`/`depth` which the more
   * specific later source is allowed to sharpen.
   */
  private upsert(node: StructuralNode): void {
    const key = this.key(node.address);
    const existing = this.nodes.get(key);
    if (node.kind === "authority" && existing?.kind !== "target") this.authorityDepths.set(key, node.depth);
    if (!existing) {
      this.nodes.set(key, node);
      return;
    }
    this.nodes.set(key, {
      ...existing,
      kind: existing.kind === "unknown" ? node.kind : existing.kind,
      accountType: (existing.accountType === "contract" || existing.accountType === "unknown") && node.accountType ? node.accountType : existing.accountType ?? node.accountType,
      safeThreshold: existing.safeThreshold ?? node.safeThreshold,
      safeOwners: existing.safeOwners ?? node.safeOwners,
      timelockDelaySeconds: existing.timelockDelaySeconds ?? node.timelockDelaySeconds,
      terminationReason: existing.terminationReason ?? node.terminationReason,
      confidence: existing.confidence ?? node.confidence,
      // An authority-derived depth is a real position in the chain and wins.
      // Other sources supply a placeholder 1 meaning "one hop from the target",
      // and taking the minimum would flatten a timelock found two hops up into
      // the depth-1 row — drawing the chain shorter than it is. Live case: the
      // Comet timelock is BOTH the ProxyAdmin's owner (depth 2) and the address
      // the target's own governor() names (marker, depth 1).
      depth: this.authorityDepths.get(key) ?? Math.min(existing.depth, node.depth),
    });
  }

  /**
   * Adds an edge, or UPGRADES one already present. `identity` separates "which
   * relation is this" from "how it is currently worded": the fork differential
   * emits the same relation twice — once when the party is shown able to make
   * the call, again once the differential confirms it closes the exit — and
   * deduping on the label alone drew both, so the map showed one relation twice
   * at two different confidences.
   */
  private link(
    from: string,
    to: string,
    label: string,
    resolution: StructuralEdge["resolution"],
    identity = label,
  ): void {
    const key = `${this.key(from)}->${this.key(to)}#${identity}`;
    const index = this.edgeKeys.indexOf(key);
    if (index === -1) {
      this.edgeKeys.push(key);
      this.edges.push({ from, to, label, resolution });
      return;
    }
    this.edges[index] = { from, to, label, resolution };
  }

  snapshot(): StructuralSnapshot {
    return {
      nodes: [...this.nodes.values()],
      edges: [...this.edges],
      proxyPattern: this.proxyPattern,
      implementation: this.implementation,
    };
  }

  private emitStructure(): void {
    this.emit({ type: "structure", snapshot: this.snapshot() });
  }

  // --- RunObserver -----------------------------------------------------------

  onStageStart(stage: EngineStage): void {
    // `block` maps onto the `report` phase, which the worker starts explicitly.
    // Re-announcing it here would restart a phase that is already running.
    if (stage === "block") return;
    this.emit({ type: "stage.started", phase: STAGE_TO_PHASE[stage] });
  }

  onStageEnd(end: StageEnd): void {
    if (end.stage === "block") return;
    const phase = STAGE_TO_PHASE[end.stage];
    const status = OUTCOME_TO_STATUS[end.outcome];
    if (status === "degraded") {
      this.emit({ type: "stage.degraded", phase, detail: "The stage failed and a fallback was used; inspect the report after publication review." });
      return;
    }
    if (status === "inconclusive") {
      this.emit({ type: "stage.inconclusive", phase, detail: "The stage ran but could not establish a complete answer." });
      return;
    }
    this.emit({
      type: "stage.completed",
      phase,
      detail: "The stage completed; detailed findings follow the publication review.",
      ...(end.metrics ? { metrics: this.safeMetrics(end.stage, end.metrics) } : {}),
    });
  }

  /**
   * THE EARLY-STREAM FILTER for stage metrics.
   *
   * Capability metrics are counts by construction (see build.ts), but this
   * function is the belt to that braces: it drops anything from the capabilities
   * stage that is not a plain number or boolean, so a future metric carrying a
   * signature string cannot start streaming before the gate has run just because
   * somebody added a field upstream.
   */
  private safeMetrics(stage: EngineStage, metrics: Record<string, number | string | boolean | null>): Record<string, number | string | boolean | null> {
    // Before publication, only numeric counts and booleans are released for every stage.
    const safe: Record<string, number | string | boolean | null> = {};
    for (const [k, v] of Object.entries(metrics)) {
      if (typeof v === "number" || typeof v === "boolean") safe[k] = v;
    }
    return safe;
  }

  onProxy(proxy: ProxyResult): void {
    this.proxyPattern = proxy.pattern;
    this.implementation = proxy.implementation;
    if (proxy.implementation) {
      this.upsert({
        address: proxy.implementation,
        relation: "code executed by the target via delegatecall",
        kind: "implementation",
        accountType: "contract",
        safeThreshold: null,
        safeOwners: null,
        timelockDelaySeconds: null,
        terminationReason: null,
        confidence: null,
        depth: 1,
      });
      // DIRECTION MATTERS: the implementation supplies code TO the proxy. It
      // holds no power over it, and drawing this the other way round (or with
      // an ownership-flavoured label) would teach the reader something false.
      this.link(proxy.implementation, this.target, "supplies code to", "resolved");
    }
    if (proxy.admin) {
      this.upsert({
        address: proxy.admin,
        relation: "proxy admin",
        kind: "proxyAdmin",
        accountType: null,
        safeThreshold: null,
        safeOwners: null,
        timelockDelaySeconds: null,
        terminationReason: null,
        confidence: null,
        depth: 1,
      });
      this.link(proxy.admin, this.target, "controls upgrades of", "resolved");
    }
    this.emitStructure();
  }

  onOwnership(ownership: { owner: OwnerField; pendingOwner: OwnerField }): void {
    if (ownership.owner.address) {
      this.upsert({
        address: ownership.owner.address,
        relation: "owner()",
        kind: "owner",
        accountType: null,
        safeThreshold: null,
        safeOwners: null,
        timelockDelaySeconds: null,
        terminationReason: null,
        confidence: null,
        depth: 1,
      });
      this.link(ownership.owner.address, this.target, "is the owner of", "resolved");
    }
    if (ownership.pendingOwner.address) {
      this.upsert({
        address: ownership.pendingOwner.address,
        relation: "pendingOwner()",
        kind: "pendingOwner",
        accountType: null,
        safeThreshold: null,
        safeOwners: null,
        timelockDelaySeconds: null,
        terminationReason: null,
        confidence: null,
        depth: 1,
      });
      this.link(ownership.pendingOwner.address, this.target, "is the pending owner of", "resolved");
    }
    this.emitStructure();
  }

  onAccessControl(accessControl: AccessControlResult): void {
    for (const role of accessControl.roles) {
      for (const member of role.members) {
        this.upsert({
          address: member,
          relation: `holds ${role.name ?? role.role}`,
          kind: "roleMember",
          accountType: null,
          safeThreshold: null,
          safeOwners: null,
          timelockDelaySeconds: null,
          terminationReason: null,
          confidence: null,
          depth: 1,
        });
        // A role is membership, not established privilege — the exit window
        // applies its own `rolePrivilege` gate before any role route counts
        // (KNOWN EDGE #18: three sUSDe role holders were BLACKLISTED USERS).
        // The label says "holds ... on", never "controls".
        this.link(member, this.target, `holds ${role.name ?? role.role} on`, "partial");
      }
    }
    this.emitStructure();
  }

  onCapabilities(_capabilities: CapabilitiesResult): void {
    // DELIBERATELY EMPTY. Capability details are exactly what the publication
    // gate may block, and the gate has not run yet. The counts already went out
    // with the stage-completed event; the findings themselves reach a browser
    // only through the report route, after `disclosure.publishable` was checked.
  }

  onPowerHolders(holders: PowerHolder[]): void {
    for (const holder of holders) {
      if (!this.nodes.has(this.key(holder.address))) continue; // capability-only holders remain gated
      this.upsert({
        address: holder.address,
        relation: "structurally observed holder",
        kind: "unknown",
        // `unknown` from the classifier means "we could not classify it", which
        // is not the same as "we have no opinion yet" — but as a node field the
        // safe representation of both is null, and `upsert` never lets a null
        // overwrite a type an earlier stage positively established.
        accountType: holder.type === "unknown" ? null : holder.type,
        safeThreshold: holder.safe?.threshold ?? null,
        safeOwners: holder.safe?.owners.length ?? null,
        timelockDelaySeconds: null,
        terminationReason: null,
        confidence: null,
        depth: 1,
      });
    }
    this.emitStructure();
  }

  onAuthority(resolution: AuthorityResolution | null): void {
    if (!resolution) return;
    for (const root of resolution.roots) {
      if (!root.relation.startsWith("capability:")) this.walk(root, null);
    }
    this.emitStructure();
  }

  private walk(node: AuthorityNode, parent: string | null): void {
    if (node.relation.startsWith("capability:")) return;
    this.upsert({
      address: node.address,
      relation: this.relationLabel(node.relation),
      kind: "authority",
      accountType: node.type,
      safeThreshold: node.safe?.threshold ?? null,
      safeOwners: node.safe?.owners.length ?? null,
      timelockDelaySeconds: node.timelock?.delaySeconds ?? null,
      terminationReason: node.terminationReason,
      confidence: node.confidence,
      depth: node.depth,
    });
    if (parent) {
      // A terminated leaf is a resolved relation; a contract we stopped at
      // without finding its authority is explicitly `unknown`, so the reader
      // can tell "this is the end of the chain" from "this is where we stopped
      // looking". An empty children list must never read as "clean".
      const resolution: StructuralEdge["resolution"] =
        node.terminationReason === "max_depth" || node.terminationReason === "no_authority_found"
          ? "unknown"
          : node.terminal
            ? "resolved"
            : "partial";
      this.link(node.address, parent, this.relationLabel(node.relation), resolution);
    }
    for (const child of node.children) this.walk(child, node.address);
  }

  /** Turns a machine relation into a direction-unambiguous phrase. */
  private relationLabel(relation: string): string {
    if (relation === "proxyAdmin") return "controls upgrades of";
    if (relation === "owner") return "is the owner of";
    if (relation === "pendingOwner") return "is the pending owner of";
    if (relation.startsWith("accessControl:")) return `holds ${relation.slice("accessControl:".length)} on`;
    if (relation === "root") return "has authority over";
    return "structural authority over";
  }

  onAuthorityIndirection(indirection: AuthorityIndirection | null): void {
    if (!indirection) return;
    for (const marker of indirection.markers) {
      this.upsert({
        address: marker.target,
        // Ripcord detects that this handle EXISTS and deliberately never calls
        // into it. Saying so on the node is the honest label — an unfollowed
        // handle drawn as a resolved controller would be a claim we did not test.
        relation: `named by ${marker.signature} — an authority indirection Ripcord detects but does not follow`,
        kind: "unknown",
        accountType: null,
        safeThreshold: null,
        safeOwners: null,
        timelockDelaySeconds: null,
        terminationReason: "not followed by Ripcord",
        confidence: null,
        depth: 1,
      });
      this.link(marker.target, this.target, `is named by ${marker.signature} of`, "unknown");
    }
    this.emitStructure();
  }

  onExitWindow(_exitWindow: ExitWindow | null): void {
    // Nothing structural to add: routes are rendered from the finished report,
    // where the verdict composer's own arithmetic is authoritative. Recomputing
    // a minimum notice here would be a second implementation of the risk logic.
  }

  onTimeToExit(_timeToExit: TimeToExit | null): void {
    // As above — rendered from the report, never recomputed in transit.
  }

  onVerdict(_verdict: Verdict | null, _disclosure: Disclosure): void {
    // The worker emits `report.ready` itself, after it has persisted the report
    // and knows the id. Emitting a verdict here as well would publish a
    // conclusion before the artifact backing it exists.
  }

  // --- ForkObserver ----------------------------------------------------------

  onForkStart(phase: ForkStep["phase"]): void {
    this.emit({ type: "stage.started", phase: FORK_PHASE_TO_ID[phase] });
  }

  onForkStep(step: ForkStep): void {
    const phase = FORK_PHASE_TO_ID[step.phase];
    const transactions = extractForkTransactions(step.evidence ?? []);

    // The guarding party joins the power map. It is found information — read
    // from the contract's own accessor and classified on the fork — but no
    // static detector reaches it, so without this the most consequential party
    // in the analysis would appear only in the report prose. Its edge is
    // labelled with what was DEMONSTRATED, and stays `partial` until the
    // differential actually confirms the restriction.
    if (step.party) {
      this.upsert({
        address: step.party.address,
        relation: step.party.confirmed ? `${step.party.relation} the target (fork-confirmed)` : "controller impersonated for a candidate call",
        kind: "authority",
        accountType: step.party.type,
        safeThreshold: step.party.safeThreshold,
        safeOwners: step.party.safeOwners,
        timelockDelaySeconds: null,
        // A Safe or EOA guardian is the end of the chain for this purpose: the
        // differential impersonated it directly and looked no further.
        terminationReason: step.party.type === "safe" ? "safe" : step.party.type === "eoa" ? "eoa" : null,
        confidence: "high",
        depth: 1,
      });
      this.link(
        step.party.address,
        this.target,
        step.party.confirmed ? `${step.party.relation} (fork-confirmed)` : "impersonated for candidate call on",
        step.party.confirmed ? "resolved" : "partial",
        // Stable identity across both emissions, so the confirmed edge REPLACES
        // the provisional one rather than sitting beside it.
        `fork-restrictor:${step.party.signature}`,
      );
      this.emitStructure();
    }

    if (step.outcome === "degraded") this.emit({ type: "stage.degraded", phase, detail: step.detail });
    else if (step.outcome === "inconclusive") this.emit({ type: "stage.inconclusive", phase, detail: step.detail });
    else this.emit({ type: "stage.completed", phase, detail: step.detail });

    // The three evidence blocks the demo is built around, each carrying the
    // fork transactions the engine actually recorded. Nothing here is derived:
    // status, gas, local block and timestamp are copied out of evidence.
    if (step.phase === "baseline") {
      this.emit({ type: "fork.baseline.completed", established: step.outcome === "completed", detail: step.detail, transactions, evidence: [...step.evidence ?? []] });
    } else if (step.phase === "mutation") {
      this.emit({ type: "fork.mutation.completed", detail: step.detail, transactions, evidence: [...step.evidence ?? []] });
    } else if (step.phase === "reexit") {
      this.emit({ type: "fork.reexit.completed", detail: step.detail, transactions, evidence: [...step.evidence ?? []] });
    }
  }
}

const FORK_PHASE_TO_ID: Record<ForkStep["phase"], PhaseId> = {
  exit_action: "forkExitAction",
  baseline: "forkBaseline",
  mutation: "forkMutation",
  reexit: "forkReexit",
  verdict: "forkVerdict",
};

/**
 * Pulls the fork transactions out of engine evidence.
 *
 * Reads only entries the engine wrote as `eth_sendTransaction` with
 * `forkOnly: true`, so an ordinary `eth_call` read never gets rendered as a
 * transaction. Everything returned is copied verbatim; no field is computed,
 * because a receipt fact the UI invented would be indistinguishable on screen
 * from one the fork produced.
 */
export { forkTransactions as extractForkTransactions } from "../shared/fork.js";
