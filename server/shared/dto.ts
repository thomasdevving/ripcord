/**
 * THE TRANSPORT CONTRACT, and the one file both the server and the browser
 * compile against.
 *
 * Two rules govern everything here, and both exist because this layer sits
 * directly against a deterministic artifact it must not contaminate:
 *
 *  1. NOTHING IN THIS FILE MAY IMPORT NODE. The browser bundle compiles it, so
 *     a `node:fs` import here would either break the build or (worse) drag
 *     server code into a client bundle. It is types and pure constants only —
 *     `scripts/verify-webapp.mjs` fails the build if that changes.
 *
 *  2. TRANSPORT METADATA IS NOT REPORT CONTENT. Job ids, sequence numbers,
 *     server wall-clock timestamps and queue positions live here and ONLY here.
 *     They never enter a Report, because a report is compared byte-for-byte
 *     cold-vs-warm and a job id would make every run differ from every other.
 *     The engine emits observations; this layer stamps them with transport
 *     facts on the way out. The two directions never cross.
 *
 * The DISCLOSURE BOUNDARY is also expressed here rather than left to caller
 * discipline: a `JobSummary` carries no report payload at all, and the only
 * type that can carry one (`ReportEnvelope`) is produced exclusively by the
 * route that has already checked `disclosure.publishable`. A blocked report is
 * never serialised toward a browser to be hidden with CSS.
 */

// --- run modes ---------------------------------------------------------------

/**
 * What a run actually executes. These are NOT cosmetic labels: each maps to a
 * different set of engine calls, and the UI must never present one as another.
 *
 * `scan` — buildReport only. No anvil, no fork, `exitRestriction: null`.
 * `scan_withdrawal_test` — buildReport → runExitRestrictionEngine →
 *   applyExitRestriction. The primary web flow. Note this is NOT what the CLI's
 *   `restrict` does: the CLI additionally runs the upgrade-drain proof, and that
 *   difference is deliberate and must stay visible (see docs/WEBAPP.md).
 * `scan_withdrawal_test_upgrade_proof` — the CLI `restrict` semantics exactly:
 *   proof engine AND withdrawal differential. Offered as an explicit advanced
 *   option so the extra fork work is a choice, never a surprise.
 */
export type RunMode = "scan" | "scan_withdrawal_test" | "scan_withdrawal_test_upgrade_proof";

/**
 * The only target for which the experimental Mobula second-layer fork pass is
 * currently implemented. This value is shared by the browser and the server:
 * the UI can explain why the option is unavailable, while server validation
 * remains the authority for clients that do not use the form.
 */
export const MOBULA_SECOND_LAYER_TARGET = {
  chainId: 1,
  address: "0xc3d688B66703497DAA19211EEdff47f25384cdc3",
  label: "Compound III (Comet) cUSDCv3",
} as const;

/**
 * Modes that actually run a fork, and therefore the only ones for which the
 * experimental per-asset scenario pass may be offered.
 *
 * Stated POSITIVELY on purpose. The entrypoint used to ask `mode !== "scan"`,
 * which is fail-OPEN: `StoredReportMeta.mode` is nullable, so a report whose
 * mode could not be recovered would have requested a fork batch. Naming the
 * modes that qualify means an unknown mode qualifies for nothing.
 */
export function modeRunsFork(mode: RunMode | null | undefined): boolean {
  return mode === "scan_withdrawal_test" || mode === "scan_withdrawal_test_upgrade_proof";
}

export const RUN_MODES: readonly RunMode[] = [
  "scan",
  "scan_withdrawal_test",
  "scan_withdrawal_test_upgrade_proof",
] as const;

export function isRunMode(value: unknown): value is RunMode {
  return typeof value === "string" && (RUN_MODES as readonly string[]).includes(value);
}

/** Whether a mode needs anvil. Used to refuse a fork mode up front rather than half-way through. */
export function modeNeedsFork(mode: RunMode): boolean {
  return mode !== "scan";
}

// --- job lifecycle -----------------------------------------------------------

/**
 * `interrupted` is a distinct terminal state on purpose. A job that was running
 * when the service restarted did not complete and did not fail — nobody knows
 * how far it got, and presenting it as either would be a claim the evidence does
 * not support. It is recovered as `interrupted` with no result. See
 * jobs/store.ts `recoverInterruptedJobs`.
 */
export type JobState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "interrupted";

export const TERMINAL_JOB_STATES: readonly JobState[] = [
  "completed",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
] as const;

export function isTerminal(state: JobState): boolean {
  return (TERMINAL_JOB_STATES as readonly string[]).includes(state);
}

// --- phases ------------------------------------------------------------------

/**
 * The phases a run passes through, in the engine's REAL order.
 *
 * These mirror `buildReport`'s own `runStage` calls plus the fork engine's
 * milestones. They are not a storyboard: reordering them here to make an
 * animation flow better would make the timeline lie about what the engine did,
 * and the engine's ordering is load-bearing (the exit window consumes the
 * authority resolution and the capability guards, so it cannot precede them).
 */
export type PhaseId =
  | "preflight"
  | "proxy"
  | "ownership"
  | "accessControl"
  | "capabilities"
  | "authorityResolution"
  | "authorityIndirection"
  | "dependencies"
  | "exitWindow"
  | "timeToExit"
  | "report"
  | "upgradeProof"
  | "forkExitAction"
  | "forkBaseline"
  | "forkMutation"
  | "forkReexit"
  | "forkVerdict";

export interface PhaseDescriptor {
  id: PhaseId;
  label: string;
  /** One line explaining what this phase actually establishes. Shown on hover/focus. */
  description: string;
  /** Which modes run this phase at all. A phase not in the mode is rendered as "not part of this run". */
  modes: readonly RunMode[];
}

const ALL: readonly RunMode[] = RUN_MODES;
const FORK: readonly RunMode[] = ["scan_withdrawal_test", "scan_withdrawal_test_upgrade_proof"] as const;
const PROOF: readonly RunMode[] = ["scan_withdrawal_test_upgrade_proof"] as const;

export const PHASES: readonly PhaseDescriptor[] = [
  { id: "preflight", label: "Preflight", description: "Resolve the pinned block and confirm the address has contract code at it.", modes: ALL },
  { id: "proxy", label: "Proxy pattern", description: "Read EIP-1967/1822/legacy storage slots to classify the proxy and resolve its implementation.", modes: ALL },
  { id: "ownership", label: "Ownership", description: "Read owner() and pendingOwner() against the proxy address, where authority state actually lives.", modes: ALL },
  { id: "accessControl", label: "Access control", description: "Enumerate AccessControl roles, or reconstruct membership from RoleGranted/RoleRevoked logs.", modes: ALL },
  { id: "capabilities", label: "Capabilities", description: "Recover selectors from the dispatcher, classify them, and attribute guards by probing real eth_calls.", modes: ALL },
  { id: "authorityResolution", label: "Authority chain", description: "Recurse each depth-1 power holder to an EOA, Safe, timelock, cycle or depth cap — every leaf states why it stopped.", modes: ALL },
  { id: "authorityIndirection", label: "Indirection markers", description: "Detect whether authority is delegated to a handle Ripcord does not follow, so a clean claim cannot be made over it.", modes: ALL },
  { id: "dependencies", label: "Dependencies", description: "Check curated major-token holdings and oracle getters one level deep.", modes: ALL },
  { id: "exitWindow", label: "Exit window", description: "Model notice per authority route and take the minimum. A delay is credited only when probed as binding.", modes: ALL },
  { id: "timeToExit", label: "Time to exit", description: "Measure cooldown and two-step exit legs as a lower bound, with unmeasured legs named.", modes: ALL },
  { id: "report", label: "Report + disclosure", description: "Compose the verdict, validate against the schema, and run the publication gate.", modes: ALL },
  { id: "upgradeProof", label: "Upgrade drain proof", description: "Fork-execute the resolved upgrade authority's own upgrade path and measure holdings leaving. Sandbox only.", modes: PROOF },
  { id: "forkExitAction", label: "Identify exit action", description: "Match the decoded selectors against a registered exit-interface fingerprint. An unmatched interface refuses the differential.", modes: FORK },
  { id: "forkBaseline", label: "Baseline withdrawal", description: "Fund a holder from a whale, supply, then withdraw in full — the control that must succeed before anything is mutated.", modes: FORK },
  { id: "forkMutation", label: "Privileged mutation", description: "Impersonate the guarding party the engine found and call its restriction candidate on a snapshot.", modes: FORK },
  { id: "forkReexit", label: "Same withdrawal again", description: "Re-run the identical withdrawal from the matching starting state, at the same fork block and time.", modes: FORK },
  { id: "forkVerdict", label: "Differential outcome", description: "Classify the differential and re-compose the verdict with any fork-confirmed route.", modes: FORK },
] as const;

export function phasesForMode(mode: RunMode): readonly PhaseDescriptor[] {
  return PHASES.filter((p) => p.modes.includes(mode));
}

/**
 * A phase outcome.
 *
 * `completed` means the phase RAN AND ANSWERED. `inconclusive` means it ran and
 * could not answer — which is a first-class result in this project, not a
 * failure. `degraded` means it produced a value only via a fallback after an
 * error, and it exists so such a phase can never wear the same green as a clean
 * one: an unconditional green on a stage that actually threw is precisely the
 * false-clean this codebase is built to refuse.
 */
export type PhaseStatus = "pending" | "running" | "completed" | "inconclusive" | "degraded" | "failed" | "skipped";

export interface PhaseSnapshot {
  id: PhaseId;
  status: PhaseStatus;
  /** Server wall-clock ms since the job started running. Transport metadata — never report content. */
  startedAtMs: number | null;
  endedAtMs: number | null;
  /**
   * A short factual line, e.g. "EIP-1967 transparent, implementation resolved".
   * Only ever describes what was actually observed; never a projected count.
   */
  detail: string | null;
  /** Counts the engine really measured. Absent means "not measured", never zero. */
  metrics?: Record<string, number | string | boolean | null>;
}

// --- structural streaming ----------------------------------------------------

/**
 * The structural facts that may stream BEFORE the disclosure gate has run.
 *
 * These are day-1 reads — a proxy slot, an owner address, a role holder, an
 * authority path. None of them is ever what the publication gate blocks on: the
 * gate blocks on capability PROBE results it could not attribute to a
 * recognised guard, because that carries a possible "unguarded" reading about a
 * live contract. Nothing in this type carries such a reading.
 *
 * Capability signatures, selectors, probe reverts and manual-verification
 * entries are deliberately ABSENT and stay server-side until the gate has run.
 * See docs/WEBAPP.md "What may stream early".
 */
export interface StructuralNode {
  /** Available after publication; empty before the gate. */
  evidence?: unknown[];
  address: string;
  /** How this address entered the graph. */
  relation: string;
  kind: "target" | "implementation" | "proxyAdmin" | "owner" | "pendingOwner" | "roleMember" | "authority" | "unknown";
  accountType: "eoa" | "safe" | "contract" | "timelock" | "unknown" | null;
  /** Only when actually observed on-chain. Never inferred from an address shape. */
  safeThreshold: number | null;
  safeOwners: number | null;
  timelockDelaySeconds: string | null;
  /** Why the resolver stopped here, when it did. */
  terminationReason: string | null;
  confidence: "high" | "medium" | "low" | null;
  depth: number;
}

export interface StructuralEdge {
  from: string;
  to: string;
  /** Direction-unambiguous label, e.g. "controls upgrades of". */
  label: string;
  /** `resolved` — followed to a termination. `partial` — followed but not terminated. `unknown` — exists, not followed. */
  resolution: "resolved" | "partial" | "unknown";
}

export interface StructuralSnapshot {
  nodes: StructuralNode[];
  edges: StructuralEdge[];
  /** Non-null once the proxy phase answered. */
  proxyPattern: string | null;
  implementation: string | null;
}

// --- fork evidence blocks ----------------------------------------------------

/**
 * One fork transaction as the UI shows it. Every field here is copied from
 * evidence the engine already recorded — the UI never derives a receipt fact.
 */
export interface ForkTxView {
  action: string;
  from: string;
  to: string | null;
  selector: string | null;
  status: "success" | "reverted" | "unknown";
  transactionHash?: string | null;
  calldata?: string | null;
  gasUsed: string;
  localBlock: string;
  localTimestamp: string;
  revertData: string | null;
}

export interface ForkBlockView {
  established: boolean | null;
  detail: string;
  transactions: ForkTxView[];
  evidence?: unknown[];
  legacy?: boolean;
}
export interface ForkBlocks {
  baseline: ForkBlockView | null;
  mutation: ForkBlockView | null;
  reexit: ForkBlockView | null;
}

// --- events ------------------------------------------------------------------

/**
 * Every event carries a monotonically increasing `seq` PER JOB. The browser
 * dedupes on it and resumes from it after a reconnect; the server keeps a
 * bounded history plus a current snapshot, so a cursor that has fallen off the
 * back of the history gets a fresh consistent snapshot instead of a gap it
 * would silently render as "nothing happened".
 */
export interface JobEventBase {
  seq: number;
  jobId: string;
  /** Server ISO timestamp. Transport metadata: this is when the SERVER saw it, not a chain time. */
  at: string;
}

export interface RuntimeStats { scanReadOperations: number; scanCacheHits: number }

export type JobEvent =
  | (JobEventBase & { type: "runtime.stats"; stats: RuntimeStats })
  | (JobEventBase & { type: "job.state"; state: JobState; queuePosition: number | null; message: string | null })
  | (JobEventBase & { type: "stage.started"; phase: PhaseId })
  | (JobEventBase & { type: "stage.completed"; phase: PhaseId; detail: string | null; metrics?: Record<string, number | string | boolean | null> })
  | (JobEventBase & { type: "stage.inconclusive"; phase: PhaseId; detail: string })
  | (JobEventBase & { type: "stage.degraded"; phase: PhaseId; detail: string })
  | (JobEventBase & { type: "stage.failed"; phase: PhaseId; detail: string })
  | (JobEventBase & { type: "stage.skipped"; phase: PhaseId; detail: string })
  | (JobEventBase & { type: "structure"; snapshot: StructuralSnapshot })
  | (JobEventBase & { type: "fork.baseline.completed"; established: boolean; detail: string; transactions: ForkTxView[]; evidence?: unknown[] })
  | (JobEventBase & { type: "fork.mutation.completed"; detail: string; transactions: ForkTxView[]; evidence?: unknown[] })
  | (JobEventBase & { type: "fork.reexit.completed"; detail: string; transactions: ForkTxView[]; evidence?: unknown[] })
  | (JobEventBase & { type: "report.ready"; reportId: string; publishable: boolean; verdictStatus: string | null })
  | (JobEventBase & { type: "job.error"; message: string; hint: string | null });

export type JobEventType = JobEvent["type"];

/**
 * `Omit` does NOT distribute over a union — it collapses `JobEvent` to the keys
 * every member shares, which is only the base three, and then rejects every
 * event-specific field. `T extends unknown ? … : never` forces distribution, so
 * each member is omitted from individually and the discriminated union survives.
 *
 * This matters because the payload type below is what the worker sends before
 * the parent stamps on transport fields, and without distribution the compiler
 * would reject every real event while accepting an empty object.
 */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A JobEvent as the ENGINE SIDE produces it: no seq, no jobId, no server timestamp. Those are stamped by the manager, which is the only component that sees the whole stream. */
export type JobEventPayload = DistributiveOmit<JobEvent, "seq" | "jobId" | "at">;

// --- API payloads ------------------------------------------------------------

export interface CreateJobRequest {
  address: string;
  chainId: number;
  /** Either an explicit block, or "latest" which the SERVER resolves once and pins. */
  block: string | "latest";
  mode: RunMode;
  /**
   * Explicit consent for the post-analysis live layer. When true, the server
   * sends the target address to Mobula after the pinned report is complete,
   * then selects candidates from the complete response independently of the UI
   * subset and verifies eligible same-chain ERC20 identities at the report block.
   * The worker and verdict engine never receive this flag or the resulting data.
   */
  refreshAssetContext?: boolean;
  /**
   * Optional client-supplied key that makes a repeated submit idempotent. Two
   * submits with the same key and the same parameters return the SAME job
   * rather than queueing a second heavyweight scan. A deliberate re-run simply
   * omits it (or sends a new one) and gets a new execution id.
   */
  idempotencyKey?: string;
  /** Client-generated cancellation capability, retained across a lost submit response. */
  controlToken?: string;
}

export interface CreateJobResponse {
  jobId: string;
  /**
   * The unforgeable capability to cancel this job. Returned exactly once, to
   * the submitter. A job id alone is shareable and therefore must not confer
   * control — see docs/WEBAPP.md "Why cancel needs its own token".
   */
  controlToken: string;
  state: JobState;
  queuePosition: number | null;
  /** True when an existing job was returned instead of a new one being created. */
  deduplicated: boolean;
}

/**
 * What `GET /api/jobs/:id` returns. Deliberately carries NO report payload:
 * the report is fetched separately through the route that enforces the
 * publication gate, so there is exactly one place that decision is made.
 */
export interface JobSummary {
  jobId: string;
  state: JobState;
  mode: RunMode;
  /** Whether this run requested the separate Mobula refresh and pinned candidate pass. */
  refreshAssetContext: boolean;
  address: string;
  chainId: number;
  /** The pinned block, as a decimal string. Fixed at submit time and never re-resolved. */
  block: string;
  blockHash: string | null;
  /** How the block was chosen, so "latest" is never mistaken for a historical pin. */
  blockSource: "explicit" | "resolved_latest";
  queuePosition: number | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  phases: PhaseSnapshot[];
  structure: StructuralSnapshot | null;
  fork?: ForkBlocks;
  runtimeStats?: RuntimeStats;
  /** Set once the report exists AND is publishable. Null otherwise — including when a report exists but is blocked. */
  reportId: string | null;
  /** Present whenever a report was produced, publishable or not. */
  disclosure: { publishable: boolean; message: string } | null;
  error: { message: string; hint: string | null } | null;
  lastSeq: number;
}

export interface ConfigResponse {
  /** Whether a run can be started at all right now, and if not, why. */
  liveRuns: { enabled: boolean; reason: string | null };
  /** Which modes this deployment can actually execute. A mode absent here is not offered. */
  availableModes: RunMode[];
  supportedChains: { id: number; name: string; hasRpc: boolean }[];
  defaultBlock: string;
  limits: { maxActiveJobs: number; maxQueuedJobs: number; jobTimeoutMs: number };
  /** Provider HOST only, never the URL — the URL carries the key. Null when unconfigured. */
  providerHost: string | null;
  anvil: { available: boolean; version: string | null };
  presets: PresetDescriptor[];
  /** Versions of the engine that will run, so a page can state what produced it. */
  engine: { schemaVersion: string; rulesetVersion: string };
}

/**
 * A preset fills the FORM IN. It deliberately carries no expected verdict, no
 * party, no label and no figure: hardcoding an outcome next to an input would
 * turn the demo into a recording, and the first thing a technical judge does is
 * check whether the result actually came from the run.
 */
export interface PresetDescriptor {
  id: string;
  label: string;
  address: string;
  chainId: number;
  block: string;
  /** Why this target is interesting to look at — a reason to click, not a result. */
  note: string;
  suggestedMode: RunMode;
}

export interface SavedReportListItem {
  id: string;
  address: string;
  chainId: number;
  block: string;
  /** When the REPORT was generated, distinct from the chain block's own time. */
  generatedAt: string;
  schemaVersion: string;
  rulesetVersion: string;
  verdictStatus: string | null;
  /** "live" — produced by this deployment. "calibration" — a committed historical report. */
  origin: "live" | "calibration";
  title: string;
  /** True when the stored report contains a fork exit-restriction evaluation. */
  hasExitRestriction: boolean;
}

/**
 * The only shape that carries a report body toward a browser. Produced solely by
 * the report routes, and only after `disclosure.publishable` was checked there.
 */
export interface ReportEnvelope {
  structure?: StructuralSnapshot | null;
  id: string;
  origin: "live" | "calibration";
  /** The full schema-valid Report. Typed as unknown here so the browser cannot
   *  accidentally depend on server-side zod types; the UI reads it defensively. */
  report: unknown;
}

/** What a blocked report returns instead. Neutral by construction: it names no finding. */
export interface BlockedReportResponse {
  blocked: true;
  message: string;
}

// --- errors ------------------------------------------------------------------

/**
 * Machine-readable error codes, so the UI can render a specific next step
 * instead of echoing a provider's raw text (which can contain a full RPC URL,
 * key included — see server/sanitize.ts).
 */
export type ApiErrorCode =
  | "idempotency_conflict"
  | "submission_rate_limited"
  | "invalid_address"
  | "invalid_block"
  | "unsupported_chain"
  | "no_contract_code"
  | "unsupported_mode"
  | "live_runs_disabled"
  | "rpc_unconfigured"
  | "rpc_unreachable"
  | "rpc_rate_limited"
  | "rpc_missing_history"
  | "anvil_unavailable"
  | "queue_full"
  | "rate_limited"
  | "not_found"
  | "forbidden"
  | "report_blocked"
  | "job_timeout"
  | "cancelled"
  | "internal";

export interface ApiError {
  code: ApiErrorCode;
  /** A short product sentence. Already sanitised — safe to render verbatim. */
  message: string;
  /** The concrete next step, when one exists. */
  hint: string | null;
  /** Correlates a user-visible failure with the server log line, for technical follow-up. */
  jobId?: string;
}
