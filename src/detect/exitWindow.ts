/**
 * The Exit Window (day 4, the metric the whole project exists for).
 *
 * Day 3 finds that a timelock exists and reads its delay. That raw delay is
 * NOT the exit window. The exit window is the delay MINUS every way it can be
 * cut to zero, and getting that wrong in the optimistic direction — printing a
 * comforting "2 days" that an admin can bypass in one transaction — is the
 * single most damaging thing this tool could do. An auditor who catches one
 * laundered delay is right to discard the entire report. So every rule here
 * leans the same way: a delay is worth nothing until positive evidence says
 * otherwise.
 *
 * THE MODEL, stated so it can be argued with:
 *
 * 1. The window is a property of a ROUTE, not of a protocol. Each depth-1
 *    authority (proxyAdmin / owner / each AccessControl role) is a separate
 *    route to changing the rules, and each carries its own notice period. The
 *    protocol's window is the MINIMUM across routes: a two-day timelock on the
 *    upgrade path is worth nothing beside an un-delayed `setOracle` role. This
 *    is the brief's "can the guarded action reach the target through a
 *    DIFFERENT path that is not timelocked at all?" answered structurally,
 *    for every path at once, instead of by looking for one specific shortcut.
 *
 * 2. A MULTISIG IS NOT A DELAY. A 3-of-11 Safe raises the number of parties
 *    who must agree; it adds exactly zero notice. The exit window measures
 *    TIME, so a Safe-terminated route is `immediate` — noticeSeconds 0 — with
 *    the threshold recorded elsewhere as the (real, different) collusion
 *    property it is. This is the PAID fixture's entire lesson and the most
 *    load-bearing modelling call in the file.
 *
 * 3. BINDING-NESS IS DECIDED BY PROBE, NOT BY NAME OR SOURCE. A contract that
 *    exposes `getMinDelay()` is not thereby a real timelock. What makes a
 *    delay binding is that the delay's own mutator can be reached ONLY through
 *    the timelock itself, so shortening the delay is itself subject to the
 *    current delay. We establish that the same way day 2 establishes guards:
 *    a real `eth_call` at the pinned block from an unrelated address, reading
 *    the revert. Verified live before this file was written:
 *      - OZ v4 TimelockController.updateDelay → "TimelockController: caller
 *        must be timelock"
 *      - Compound/Bravo Timelock.setDelay → "Timelock::setDelay: Call must
 *        come from Timelock."
 *    Both are self-call gates: `proven_binding`. An Ownable/AccessControl-
 *    shaped revert instead means a role holder can shorten the delay directly:
 *    `shortenable`. Anything else: `cannot_determine`, which is NEVER treated
 *    as binding.
 *
 *    A note on why this is a probe and not the fork: the fork was considered
 *    and rejected here. Impersonating a role holder and calling `updateDelay`
 *    on a fork would tell us exactly what the revert shape already tells us,
 *    at the cost of an anvil spin-up per timelock — and anvil impersonation
 *    ignores signatures, so it would ALSO answer a slightly different question
 *    than the one asked. The static probe is cheaper, cached, pinned, and
 *    strictly more faithful. The fork stays the proof engine's tool.
 *
 * 4. WE DO NOT ACCEPT A DELAY WE COULD NOT VERIFY. If binding-ness is
 *    undetermined, the assessment is `not_proven_binding` and the raw number
 *    is carried in `nominalDelaySeconds`, never as `windowSeconds`. The schema
 *    enforces this (exitWindowAssessmentSchema is a discriminated union in
 *    which only the `binding` variant HAS a windowSeconds field) so it cannot
 *    be lost to caller discipline — the same technique GuardStatus uses for
 *    capability holders.
 *
 * 5. "NONE FOUND" AND "NOT CHECKED" ARE DIFFERENT ANSWERS. Every check that
 *    ran is recorded in `checksPerformed` with its result, and the checks
 *    Ripcord deliberately does NOT make (governance proposal paths, Safe
 *    modules) are listed there too with `performed: false`. An empty
 *    `bypasses[]` beside a populated `checksPerformed[]` is a claim; an empty
 *    `bypasses[]` on its own would be a silence pretending to be one.
 *
 * WHAT IS DELIBERATELY EXCLUDED, and why:
 *   - `pendingOwner` is not a route. A pending owner holds no power until it
 *     accepts; counting it would inflate the route set with an authority that
 *     cannot currently act. Recorded as a check, not silently dropped.
 *   - A CANCELLER or guardian is not a window bypass. Cancelling a queued
 *     operation removes a change, it does not make one arrive sooner, so it
 *     cannot shorten the window. An emergency pause is likewise not a window
 *     bypass — it is an EXIT-blocking capability, and it is modelled on the
 *     time-to-exit side (timeToExit.ts) where its effect actually lands.
 *     Both are recorded as checks so the reasoning is visible rather than
 *     looking like an omission.
 */
import { decodeAbiParameters, encodeFunctionData, toFunctionSelector, type Hex } from "viem";
import type { ChainReader } from "../chain/client.js";
import { TIMELOCK_SELECTORS } from "../chain/constants.js";
import { ERROR_STRING_SELECTOR, PROBE_ADDRESSES, parseAuthShape } from "./guardProbe.js";
import { terminalNodeOf } from "./authority.js";
import { detectProxy } from "./proxy.js";
import { extractDispatcherSelectors } from "./dispatcher.js";
import { enumerationSiteKey, gapSubject, witnessOf } from "../report/enumeration.js";
import type {
  AuthorityIndirection,
  AuthorityNode,
  AuthorityResolution,
  Bypass,
  BypassCheck,
  CapabilitiesResult,
  CapabilityCategory,
  DepthConfidence,
  EnumerationCompleteness,
  Evidence,
  ExitWindow,
  ExitWindowAssessment,
  ExitWindowRoute,
  ProxyResult,
  RoleEntry,
  RolePrivilege,
  TimelockBinding,
  TimelockInfo,
  UnknownEntry,
} from "../report/schema.js";

/** Bump whenever the rules in this file change what a window means. Folded into report.rulesetVersion. */
export const exitWindowRulesVersion = "0.1.0";

/**
 * OZ v5 TimelockController's self-call gate is a custom error rather than a
 * string. Derived from the signature via viem — never hand-copied — and
 * asserted in test/exitWindow.test.ts, same discipline as guardProbe's four
 * auth-error selectors. Unlike the v4 string forms below this one has NOT been
 * observed live by this project (no OZ v5 timelock was available among the
 * calibration targets at the pinned block); it is derivation-correct and
 * flagged as such in KNOWN EDGES.
 */
export const TIMELOCK_UNAUTHORIZED_CALLER_SELECTOR = toFunctionSelector("TimelockUnauthorizedCaller(address)");

/**
 * Self-call gate messages, matched EXACTLY on their load-bearing phrase.
 *
 * Deliberately not a loose "contains the word timelock" match. A false
 * `proven_binding` is the worst output this module can produce, so the
 * matching is tight in that direction: the only flexibility permitted is the
 * contract-name prefix Compound forks vary (`Timelock::` → `XTimelock::`),
 * because that prefix carries no semantics. Everything else must match the
 * canonical phrase or the result degrades to `cannot_determine`.
 *
 * Both were read from mainnet before being written down:
 *   ENS DAO TimelockController 0xfe89cc7a… updateDelay(0) →
 *     "TimelockController: caller must be timelock"
 *   Compound Timelock 0x6d903f60… setDelay(0) →
 *     "Timelock::setDelay: Call must come from Timelock."
 */
const SELF_CALL_GATE_PATTERNS: RegExp[] = [
  /^TimelockController: caller must be timelock$/,
  /^[A-Za-z0-9_]*Timelock::setDelay: Call must come from Timelock\.?$/,
];

export type SelfGateShape = "self_call" | "role" | "unrecognized";

/**
 * Classifies one probe's revert bytes as a self-call gate, a role gate, or
 * neither. Exported for direct unit testing against the exact byte strings
 * observed live — the determination that decides `proven_binding` is not
 * something to leave untested.
 */
export function classifyDelayGuardRevert(revertData: Hex | undefined): SelfGateShape {
  if (!revertData || revertData.length < 10) return "unrecognized";
  const selector = revertData.slice(0, 10).toLowerCase();

  if (selector === TIMELOCK_UNAUTHORIZED_CALLER_SELECTOR.toLowerCase()) return "self_call";

  if (selector === ERROR_STRING_SELECTOR.toLowerCase()) {
    let message: string;
    try {
      [message] = decodeAbiParameters([{ type: "string" }], `0x${revertData.slice(10)}` as Hex) as [string];
    } catch {
      return "unrecognized";
    }
    if (SELF_CALL_GATE_PATTERNS.some((p) => p.test(message))) return "self_call";
    // Fall through to the shared Ownable/AccessControl parser so a role-gated
    // mutator is recognised by exactly the same rules day 2 uses.
    return parseAuthShape(revertData) ? "role" : "unrecognized";
  }

  return parseAuthShape(revertData) ? "role" : "unrecognized";
}

/**
 * Determines whether a detected timelock's delay is actually binding on the
 * authority it constrains.
 *
 * Order of reasoning, most-conservative-last:
 *   1. No readable delay at all → nothing to bind (`cannot_determine`).
 *   2. No delay mutator in the timelock's own dispatcher → the delay is
 *      immutable through this contract's interface (`proven_binding`).
 *   3. A mutator exists → probe it. Self-call gate → binding. Role gate →
 *      shortenable. Anything else → cannot determine.
 *
 * Independently of all three, the timelock is checked for being ITSELF behind
 * a proxy. A delay enforced by upgradeable code is only as binding as the
 * authority over that code, so `timelockIsUpgradeable` is surfaced and raises
 * its own bypass rather than being quietly folded into the binding verdict.
 */
export async function analyseTimelockBinding(
  chain: ChainReader,
  address: Hex,
  info: TimelockInfo,
): Promise<TimelockBinding> {
  const evidence: Evidence[] = [];

  // Is the timelock itself upgradeable? Cheap (storage reads) and directly
  // load-bearing: an upgradeable timelock's delay is a suggestion.
  let timelockIsUpgradeable: boolean | null = null;
  try {
    const proxy = await detectProxy(chain, address);
    evidence.push(...proxy.evidence);
    // "unknown" means a DELEGATECALL with no recognised storage pattern — per
    // KNOWN EDGE #1 that is usually an embedded child contract, not a proxy, so
    // it is reported as undetermined rather than counted either way.
    timelockIsUpgradeable = proxy.pattern === "unknown" ? null : proxy.isProxy;
  } catch {
    // detectProxy only throws on a real RPC failure; the caller records the
    // stage error. Leaving this null keeps "we did not determine it" distinct
    // from "it is not upgradeable" — never the reverse.
    timelockIsUpgradeable = null;
  }

  if (info.delaySeconds === null) {
    return {
      address,
      kind: info.kind,
      delaySeconds: null,
      binding: "cannot_determine",
      method: "delay_unreadable",
      timelockIsUpgradeable,
      note: "the contract is timelock-shaped but its delay could not be read, so there is no delay to prove binding — treated as no verified notice, not as an absent constraint",
      evidence,
    };
  }

  // Which mutator does this contract actually expose?
  const { code, evidence: codeEvidence } = await chain.getCode(address);
  evidence.push(codeEvidence);
  let mutator: { signature: string; selector: Hex } | null = null;
  let dispatcherRecognized = false;
  if (code) {
    const dispatch = extractDispatcherSelectors(code);
    if (dispatch.recognized) {
      dispatcherRecognized = true;
      const selectors = new Set(dispatch.selectors.map((s) => s.toLowerCase()));
      if (selectors.has(TIMELOCK_SELECTORS.updateDelay.toLowerCase())) {
        mutator = { signature: "updateDelay(uint256)", selector: TIMELOCK_SELECTORS.updateDelay };
      } else if (selectors.has(TIMELOCK_SELECTORS.setDelay.toLowerCase())) {
        mutator = { signature: "setDelay(uint256)", selector: TIMELOCK_SELECTORS.setDelay };
      }
    }
  }

  if (!dispatcherRecognized) {
    return {
      address,
      kind: info.kind,
      delaySeconds: info.delaySeconds,
      binding: "cannot_determine",
      method: "probe_inconclusive",
      timelockIsUpgradeable,
      note: "the timelock's dispatcher could not be parsed, so the presence of a delay mutator could not be established either way — the delay is NOT credited as binding",
      evidence,
    };
  }

  if (!mutator) {
    return {
      address,
      kind: info.kind,
      delaySeconds: info.delaySeconds,
      binding: "proven_binding",
      method: "no_mutator_present",
      timelockIsUpgradeable,
      note: `neither updateDelay(uint256) nor setDelay(uint256) appears in this contract's own dispatcher, so the ${info.delaySeconds}s delay cannot be changed through its interface`,
      evidence,
    };
  }

  // Probe the mutator from unrelated addresses and read the gate.
  const calldata = encodeFunctionData({
    abi: [{ type: "function", name: mutator.signature.split("(")[0]!, inputs: [{ type: "uint256" }], outputs: [], stateMutability: "nonpayable" }],
    args: [0n],
  }) as Hex;

  let shape: SelfGateShape = "unrecognized";
  let sawInterpretableRevert = false;
  for (const probe of PROBE_ADDRESSES) {
    const { revertData, reverted, evidence: probeEvidence } = await chain.probeCall(address, calldata, probe);
    evidence.push(probeEvidence);
    if (!reverted || revertData === undefined) continue;
    sawInterpretableRevert = true;
    shape = classifyDelayGuardRevert(revertData);
    if (shape !== "unrecognized") break;
  }

  if (shape === "self_call") {
    return {
      address,
      kind: info.kind,
      delaySeconds: info.delaySeconds,
      binding: "proven_binding",
      method: "self_call_gated_revert",
      timelockIsUpgradeable,
      note: `${mutator.signature} reverts with a "caller must be the timelock itself" gate, so the delay can only be changed by an operation the timelock schedules against itself — which is subject to the current ${info.delaySeconds}s delay`,
      evidence,
    };
  }
  if (shape === "role") {
    return {
      address,
      kind: info.kind,
      delaySeconds: info.delaySeconds,
      binding: "shortenable",
      method: "role_gated_revert",
      timelockIsUpgradeable,
      note: `${mutator.signature} reverts with an Ownable/AccessControl-shaped guard rather than a self-call gate — a role holder can change the delay directly, so the ${info.delaySeconds}s figure is a setting, not a constraint`,
      evidence,
    };
  }

  return {
    address,
    kind: info.kind,
    delaySeconds: info.delaySeconds,
    binding: "cannot_determine",
    method: "probe_inconclusive",
    timelockIsUpgradeable,
    note: sawInterpretableRevert
      ? `${mutator.signature} is present and reverts, but with a shape Ripcord does not recognise as either a self-call gate or a known role gate — the delay is NOT credited as binding`
      : `${mutator.signature} is present but no probe returned interpretable revert data (see KNOWN EDGE #4, provider-dependent revert payloads) — the delay is NOT credited as binding`,
    evidence,
  };
}

const DEFAULT_ADMIN_ROLE = `0x${"0".repeat(64)}`;

/**
 * Decides whether an AccessControl role route confers privilege — see
 * `rolePrivilegeSchema` for why this is necessary and why erring toward
 * `unverified` is safe.
 *
 * The route label is `accessControl:<name-or-hash>` (authority.ts's
 * `collectSeeds` uses the role's resolved NAME when it has one and the raw
 * hash otherwise), so the role is recovered by matching that suffix back
 * against the role set rather than by re-deriving it.
 */
export function classifyRolePrivilege(
  label: string,
  roles: RoleEntry[],
  capabilities: CapabilitiesResult,
): { privilege: RolePrivilege; note: string } {
  if (!label.startsWith("accessControl:")) {
    return { privilege: "not_a_role", note: "not an AccessControl route — owner/proxyAdmin authority is privileged by definition" };
  }
  const suffix = label.slice("accessControl:".length);
  const entry = roles.find((r) => (r.name ?? r.role) === suffix) ?? roles.find((r) => r.role === suffix);
  if (!entry) {
    return {
      privilege: "unverified",
      note: `role "${suffix}" could not be matched back to the target's reconstructed role set, so whether it confers privilege is unknown`,
    };
  }
  const roleHash = entry.role.toLowerCase();

  if (roleHash === DEFAULT_ADMIN_ROLE) {
    return { privilege: "verified", note: "DEFAULT_ADMIN_ROLE administers every role by construction in OpenZeppelin AccessControl" };
  }
  const administers = roles.filter((r) => r.adminRole?.toLowerCase() === roleHash && r.role.toLowerCase() !== roleHash);
  if (administers.length > 0) {
    return {
      privilege: "verified",
      note: `this role is the adminRole of ${administers.length} other role(s) (${administers.map((r) => r.name ?? r.role).join(", ")}), so its holders can grant and revoke them`,
    };
  }
  const attributed = capabilities.findings.filter(
    (f) => f.guard.status === "attributed" && f.guard.role?.toLowerCase() === roleHash,
  );
  if (attributed.length > 0) {
    return {
      privilege: "verified",
      note: `a guard probe attributed ${attributed.length} capability/capabilities to this role (${attributed.map((f) => f.signature).join(", ")})`,
    };
  }
  return {
    privilege: "unverified",
    note: `no evidence that this role confers privilege: it is not DEFAULT_ADMIN_ROLE, it administers no other role, and no capability guard was attributed to it. OpenZeppelin roles are widely used as MARKERS as well as permissions (restricted-staker, KYC and whitelist patterns), so membership alone is not authority — this route is recorded but contributes "undetermined", not a proven zero notice`,
  };
}

/** Weakest-link over a set of confidences: the result is only as good as its worst input. */
function weakest(values: DepthConfidence[]): DepthConfidence {
  if (values.includes("low")) return "low";
  if (values.includes("medium")) return "medium";
  return "high";
}

/**
 * Which capability categories a given depth-1 authority is known to reach.
 * Cross-referenced from attributed capability findings only — a finding whose
 * guard is `guarded_unknown_holder` or `inconclusive` names no holder, so it
 * cannot be assigned to a route (that is the whole point of the day-2 type).
 * A transparent proxy's admin additionally reaches CODE_CHANGE by definition:
 * upgrading is what a ProxyAdmin exists to do, whether or not the selector
 * survives into the implementation's dispatcher.
 */
function categoriesForRoute(
  root: Hex,
  label: string,
  capabilities: CapabilitiesResult,
  proxy: ProxyResult,
): CapabilityCategory[] {
  const out = new Set<CapabilityCategory>();
  const lower = root.toLowerCase();
  if (label === "proxyAdmin" && proxy.admin && proxy.admin.toLowerCase() === lower) {
    out.add("CODE_CHANGE");
  }
  for (const finding of capabilities.findings) {
    if (finding.guard.status !== "attributed") continue;
    if (finding.guard.holders.some((h) => h.toLowerCase() === lower)) out.add(finding.category);
  }
  return [...out];
}

export interface ExitWindowDetection {
  result: ExitWindow;
  unknowns: UnknownEntry[];
}

export async function analyseExitWindow(
  chain: ChainReader,
  args: {
    proxy: ProxyResult;
    authorityResolution: AuthorityResolution | null;
    capabilities: CapabilitiesResult;
    /** The TARGET's own reconstructed roles — needed to tell a privileged role from a marker role. */
    accessControlRoles: RoleEntry[];
    /**
     * Day-5 authority-indirection markers. Null means the check did not run,
     * which is treated as "cannot rule out delegated authority" rather than as
     * "none" — see the inverted default in `assess`.
     */
    authorityIndirection: AuthorityIndirection | null;
    /**
     * The aggregate enumeration witness. Required, not nullable: whether the
     * route set was fully seen is a precondition of the window arithmetic, so
     * there is no "we did not check" state — see report/enumeration.ts.
     */
    enumeration: EnumerationCompleteness;
  },
): Promise<ExitWindowDetection> {
  const unknowns: UnknownEntry[] = [];
  const evidence: Evidence[] = [];
  const routes: ExitWindowRoute[] = [];
  const bypasses: Bypass[] = [];

  const resolution = args.authorityResolution;
  let pendingOwnerExcluded = 0;

  if (resolution) {
    for (const [index, root] of resolution.roots.entries()) {
      // A pending owner cannot act until it accepts, so it is not a current
      // route. Counted and reported, never silently dropped.
      if (root.relation === "pendingOwner") {
        pendingOwnerExcluded++;
        continue;
      }

      const path = resolution.paths[index];
      const terminal = terminalNodeOf(root);
      // The tree and its flattened projection must agree; if they ever don't,
      // that is a Ripcord bug and it gets surfaced rather than papered over.
      if (path && path.effectiveController && terminal.address.toLowerCase() !== path.effectiveController.toLowerCase()) {
        unknowns.push({
          field: "exitWindow.routes",
          reason: `authority path projection and tree walk disagree on the terminal controller for root ${root.address} (path says ${path.effectiveController}, tree walk says ${terminal.address}) — route treated as undetermined`,
        });
      }

      const route = await buildRoute(chain, root, terminal, args, bypasses, evidence);
      routes.push(route);
    }
  }

  const checksPerformed = buildChecks(routes, bypasses, pendingOwnerExcluded, resolution);
  const assessment = assess(routes, args, unknowns);

  return {
    result: {
      rulesVersion: exitWindowRulesVersion,
      assessment,
      routes,
      bypasses,
      checksPerformed,
      evidence,
    },
    unknowns,
  };
}

async function buildRoute(
  chain: ChainReader,
  root: AuthorityNode,
  terminal: AuthorityNode,
  args: { proxy: ProxyResult; capabilities: CapabilitiesResult; accessControlRoles: RoleEntry[] },
  bypasses: Bypass[],
  evidence: Evidence[],
): Promise<ExitWindowRoute> {
  const label = root.relation;
  const categories = categoriesForRoute(root.address as Hex, label, args.capabilities, args.proxy);
  const confidence = terminal.confidence;
  const { privilege, note: rolePrivilegeNote } = classifyRolePrivilege(label, args.accessControlRoles, args.capabilities);
  const base = {
    label,
    rolePrivilege: privilege,
    rolePrivilegeNote,
    root: root.address,
    effectiveController: terminal.address,
    effectiveControllerType: terminal.type,
    terminationReason: terminal.terminationReason,
    categories,
    confidence,
  };

  // A role whose privilege could not be established is recorded as a route but
  // contributes NOTHING to the window arithmetic — not a zero, not a delay.
  // See rolePrivilegeSchema: this can only downgrade a false "zero notice" to
  // an honest "not established," never the reverse, because an undetermined
  // route also blocks the assessment from ever reaching `binding`.
  if (privilege === "unverified") {
    return {
      ...base,
      noticeStatus: "undetermined",
      noticeSeconds: null,
      nominalDelaySeconds: null,
      timelock: null,
      note: `role privilege unverified — ${rolePrivilegeNote}. Holder: ${terminal.type} ${terminal.address}.`,
    };
  }

  // --- Terminal is a plain key or a multisig: proven ZERO notice. ---
  if (terminal.type === "eoa" || terminal.type === "safe") {
    const who =
      terminal.type === "safe"
        ? `a ${terminal.safe?.threshold ?? "?"}-of-${terminal.safe?.owners.length ?? "?"} Safe`
        : "a single externally-owned account";
    bypasses.push({
      kind: "ungated_route",
      route: label,
      detail: `${label} resolves to ${who} (${terminal.address}) with no delay anywhere on the path — this route can change the rules with zero notice.${
        terminal.type === "safe"
          ? " A multisig threshold raises how many parties must agree; it adds no notice period, and the exit window measures time."
          : ""
      }`,
      confidence,
      evidence: [],
    });
    return {
      ...base,
      noticeStatus: "immediate",
      noticeSeconds: "0",
      nominalDelaySeconds: null,
      timelock: null,
      note: `no delay on this route: it terminates at ${who}.`,
    };
  }

  // --- Terminal is a timelock: the interesting case. ---
  if (terminal.type === "timelock" && terminal.timelock) {
    const binding = await analyseTimelockBinding(chain, terminal.address as Hex, terminal.timelock);
    evidence.push(...binding.evidence);

    if (binding.timelockIsUpgradeable === true) {
      bypasses.push({
        kind: "timelock_upgradeable",
        route: label,
        detail: `the timelock at ${terminal.address} is itself behind a proxy — its delay is only as binding as the authority that can replace its code`,
        confidence,
        evidence: [],
      });
    }

    if (binding.delaySeconds === null) {
      bypasses.push({
        kind: "delay_undetermined",
        route: label,
        detail: `${terminal.address} is timelock-shaped but its delay could not be read (${terminal.timelock.note})`,
        confidence,
        evidence: [],
      });
      return { ...base, noticeStatus: "undetermined", noticeSeconds: null, nominalDelaySeconds: null, timelock: binding, note: binding.note };
    }

    if (BigInt(binding.delaySeconds) === 0n) {
      bypasses.push({
        kind: "zero_delay",
        route: label,
        detail: `the timelock at ${terminal.address} reports a delay of 0 seconds — it imposes no notice`,
        confidence,
        evidence: [],
      });
      return { ...base, noticeStatus: "immediate", noticeSeconds: "0", nominalDelaySeconds: "0", timelock: binding, note: "timelock present but its delay is zero — no notice is imposed." };
    }

    if (binding.binding === "proven_binding" && binding.timelockIsUpgradeable !== true) {
      return {
        ...base,
        noticeStatus: "delayed",
        noticeSeconds: binding.delaySeconds,
        nominalDelaySeconds: binding.delaySeconds,
        timelock: binding,
        note: binding.note,
      };
    }

    if (binding.binding === "shortenable") {
      bypasses.push({
        kind: "delay_shortenable",
        route: label,
        detail: binding.note,
        confidence,
        evidence: [],
      });
    } else if (binding.binding === "cannot_determine") {
      bypasses.push({
        kind: "delay_mutability_undetermined",
        route: label,
        detail: binding.note,
        confidence,
        evidence: [],
      });
    }
    return {
      ...base,
      noticeStatus: "delay_not_proven_binding",
      noticeSeconds: null,
      nominalDelaySeconds: binding.delaySeconds,
      timelock: binding,
      note:
        binding.timelockIsUpgradeable === true
          ? `${binding.note} In addition, the timelock is itself upgradeable, so the delay is not credited as a window.`
          : binding.note,
    };
  }

  // --- Anything else: a contract we could not resolve past. ---
  bypasses.push({
    kind: "unresolved_authority",
    route: label,
    detail: `${label} terminates at ${terminal.address} as "${terminal.terminationReason}" — Ripcord could not establish who ultimately controls it, so an un-delayed path through it cannot be excluded`,
    confidence,
    evidence: [],
  });
  return {
    ...base,
    noticeStatus: "undetermined",
    noticeSeconds: null,
    nominalDelaySeconds: null,
    timelock: null,
    note: `authority resolution stopped at ${terminal.address} (${terminal.terminationReason}); the notice this route imposes is unknown, which is not the same as none.`,
  };
}

/**
 * The record of what was and was not checked. Written as a fixed list rather
 * than derived from the findings, so a check that finds nothing still leaves a
 * trace — the distinction acceptance criterion 2 turns on.
 */
function buildChecks(
  routes: ExitWindowRoute[],
  bypasses: Bypass[],
  pendingOwnerExcluded: number,
  resolution: AuthorityResolution | null,
): BypassCheck[] {
  const found = (kind: Bypass["kind"]) => bypasses.some((b) => b.kind === kind);
  const timelockRoutes = routes.filter((r) => r.timelock !== null);

  return [
    {
      check: "parallel_ungated_route",
      description:
        "every depth-1 authority (proxyAdmin, owner, each AccessControl role) was resolved to its terminal controller and checked for a delay; the protocol window is the minimum across them",
      performed: resolution !== null,
      found: found("ungated_route"),
      note:
        resolution === null
          ? "authority resolution did not run, so parallel routes could not be enumerated"
          : `${routes.length} route(s) enumerated${found("ungated_route") ? "; at least one imposes no delay" : "; none was found to impose zero delay"}`,
    },
    {
      check: "delay_mutator_present",
      description:
        "each detected timelock's own dispatcher was searched for updateDelay(uint256)/setDelay(uint256) — i.e. whether the delay is mutable at all",
      performed: timelockRoutes.length > 0,
      found: timelockRoutes.some((r) => r.timelock?.method !== "no_mutator_present"),
      note:
        timelockRoutes.length === 0
          ? "no timelock was reached on any route, so there was no delay to test for mutability"
          : timelockRoutes.map((r) => `${r.timelock!.address}: ${r.timelock!.method}`).join("; "),
    },
    {
      check: "delay_mutator_guard",
      description:
        "where a delay mutator exists, it was probed by eth_call from three unrelated addresses and the revert read: a self-call gate proves the delay binds itself; a role gate proves it does not",
      performed: timelockRoutes.some((r) => r.timelock?.method !== "no_mutator_present" && r.timelock?.method !== "delay_unreadable"),
      found: found("delay_shortenable") || found("delay_mutability_undetermined"),
      note:
        timelockRoutes.length === 0
          ? "not applicable: no timelock on any route"
          : timelockRoutes.map((r) => `${r.timelock!.address}: ${r.timelock!.binding}`).join("; "),
    },
    {
      check: "timelock_upgradeable",
      description:
        "each detected timelock was checked for being itself behind a proxy — a delay enforced by replaceable code binds only as strongly as the authority over that code",
      performed: timelockRoutes.length > 0,
      found: found("timelock_upgradeable"),
      note:
        timelockRoutes.length === 0
          ? "not applicable: no timelock on any route"
          : timelockRoutes
              .map((r) => `${r.timelock!.address}: ${r.timelock!.timelockIsUpgradeable === null ? "undetermined" : String(r.timelock!.timelockIsUpgradeable)}`)
              .join("; "),
    },
    {
      check: "canceller_or_guardian",
      description:
        "cancellers/executors on a detected timelock were considered and are modelled as NOT window-shortening: cancelling removes a queued change rather than making one arrive sooner",
      performed: timelockRoutes.length > 0,
      found: false,
      note:
        timelockRoutes.length === 0
          ? "not applicable: no timelock on any route"
          : "by construction a canceller cannot shorten a delay; an emergency PAUSE is a different power and is modelled on the time-to-exit side (it blocks the exit, it does not shorten the notice)",
    },
    {
      check: "pending_owner_excluded",
      description:
        "pendingOwner authorities were excluded from the route set: a pending owner holds no power until it accepts, so counting it would inflate the window's route set with an authority that cannot currently act",
      performed: true,
      found: false,
      note: `${pendingOwnerExcluded} pendingOwner route(s) excluded`,
    },
    {
      check: "governance_proposal_path",
      description:
        "whether a governance contract on the path can queue an arbitrary call that reaches the target by some route other than the ones enumerated here",
      performed: false,
      found: false,
      note:
        "NOT CHECKED. Enumerating what an arbitrary-call governor can reach requires modelling proposal execution, which is out of scope. Where a governor sits behind a timelock the delay still applies to it, so this gap does not make a reported delay optimistic; where a governor is reachable WITHOUT a delay it is already captured as an ungated route.",
    },
    {
      check: "safe_module_or_guard",
      description:
        "whether a Safe on the path has modules or a guard that could let a subset of signers (or a non-signer) act",
      performed: false,
      found: false,
      note:
        "NOT CHECKED. Safe modules are not enumerated. This does not affect the window arithmetic, because a Safe is already modelled as imposing ZERO notice — a module could change WHO acts, not HOW FAST.",
    },
  ];
}

/** Composes the per-route notices into one assessment. Ordering is the model: proven zero beats unknown, and unknown beats an unverified delay. */
function assess(
  routes: ExitWindowRoute[],
  args: {
    proxy: ProxyResult;
    capabilities: CapabilitiesResult;
    authorityIndirection: AuthorityIndirection | null;
    enumeration: EnumerationCompleteness;
  },
  unknowns: UnknownEntry[],
): ExitWindowAssessment {
  if (routes.length === 0) {
    // A confirmed proxy with no resolvable authority IS upgradeable by
    // someone — the absence of a route is a detection gap, never a clean bill.
    if (args.proxy.isProxy) {
      return {
        status: "undetermined",
        missing: [
          `target is a confirmed proxy (pattern=${args.proxy.pattern}) but no authority route could be resolved — something can change this code and Ripcord could not identify it`,
        ],
        citedGapSites: [],
        confidence: "low",
        statement:
          "Exit window undetermined: this contract is upgradeable, but the authority that can upgrade it was not identified, so the notice before a rule change cannot be bounded.",
      };
    }
    const hasUnattributedPower =
      args.capabilities.findings.some((f) => f.guard.status !== "attributed") ||
      args.capabilities.needsManualVerification.length > 0;
    if (hasUnattributedPower) {
      return {
        status: "undetermined",
        missing: [
          "privileged capabilities were detected but none could be attributed to an identified holder, so no route could be built and no notice period can be bounded",
        ],
        citedGapSites: [],
        confidence: "low",
        statement:
          "Exit window undetermined: privileged functions exist but their holders could not be identified, so the notice before a rule change cannot be bounded.",
      };
    }
    // --- THE INVERTED DEFAULT (day 5) ---
    //
    // Reaching here means no authority route was BUILT. Until day 5 that alone
    // produced a reassuring status, which conflated "we found nothing" with
    // "there is nothing" and was wrong on two of the three mainnet contracts it
    // fired on (see the day-5 split documented on exitWindowAssessmentSchema).
    //
    // Now "clean" must be EARNED. Each condition below is a read Ripcord
    // actually performed and can point at; a condition that is merely absent
    // never counts. Anything missing sends the assessment to `undetermined`,
    // which is the safe outcome and the one reached by falling through.
    const missingBasis: string[] = [];
    const basis: string[] = [];

    // 1. The code itself cannot be swapped. This is the strongest evidence
    //    available and it comes from the bytecode, not from a getter: proxy
    //    detection found no DELEGATECALL at all. `unknown` means a DELEGATECALL
    //    WAS found and not classified, which is the opposite of reassuring, and
    //    is already handled by the isProxy branch above for confirmed proxies.
    if (args.proxy.pattern === "not_a_proxy") {
      basis.push("proxy detection found no DELEGATECALL in the runtime bytecode, so this contract's code cannot be replaced behind the address");
    } else {
      missingBasis.push(`proxy pattern is "${args.proxy.pattern}" rather than a positively-established "not_a_proxy", so code replacement cannot be ruled out`);
    }

    // 2. The dispatcher was actually decoded. Without this the selector set was
    //    never enumerated, so "no privileged capability found" is not a finding
    //    about the contract — it is a statement that we could not look.
    if (args.capabilities.dispatcherRecognized) {
      basis.push(`the dispatcher was decoded and all ${args.capabilities.selectorsExtracted} selector(s) enumerated`);
    } else {
      missingBasis.push("the dispatcher could not be decoded, so the contract's function set was never enumerated and no capability claim about it is possible");
    }

    // 3. No handle to authority elsewhere. A null result means the check did
    //    NOT run, which cannot support a positive claim either.
    if (args.authorityIndirection === null) {
      missingBasis.push("the authority-indirection check did not run, so a delegated-authorisation handle cannot be ruled out");
    } else if (args.authorityIndirection.markers.length > 0) {
      missingBasis.push(
        `authority appears to be delegated elsewhere: ${args.authorityIndirection.markers
          .map((m: AuthorityIndirection["markers"][number]) => `${m.signature} → ${m.target}`)
          .join(", ")} — Ripcord does not resolve what that contract permits or who controls it`,
      );
    } else {
      basis.push(`none of the ${args.authorityIndirection.gettersProbed.length} authority-indirection getters probed resolved to a non-zero address`);
    }

    // 4. Nothing privileged turned up, including entries that only needed
    //    manual review — an untested capability is not an absent one.
    if (args.capabilities.findings.length === 0 && args.capabilities.needsManualVerification.length === 0) {
      basis.push("no capability in Ripcord's taxonomy matched any of this contract's selectors");
    } else {
      missingBasis.push("privileged capabilities were detected on this contract but could not be attributed to a holder");
    }

    // 5. No authority handle on the contract itself.
    basis.push("owner(), pendingOwner() and AccessControl role detection all came back empty");

    if (missingBasis.length > 0) {
      for (const m of missingBasis) unknowns.push({ field: "exitWindow", reason: m });
      return {
        status: "undetermined",
        missing: missingBasis,
        citedGapSites: [],
        confidence: "low",
        statement:
          "Exit window undetermined: no authority route was found, but immutability was not positively established either — so this is an absence of evidence, not evidence of absence. See `missing` for exactly which positive check failed.",
      };
    }

    // A positive claim on an incompletely enumerated authority is a false
    // positive by construction: "no route exists" cannot be asserted from a
    // role set that may be missing entries.
    const immutabilityWitness = witnessOf(args.enumeration);
    if (!immutabilityWitness) {
      const enumerationMissing = args.enumeration.gaps.map(
        (g) => `no rule-change route was found, but ${gapSubject(g.site)} at ${g.where} was incomplete, so "no route exists" cannot be claimed: ${g.reason}`,
      );
      for (const m of enumerationMissing) unknowns.push({ field: "exitWindow", reason: m });
      return {
        status: "undetermined",
        missing: enumerationMissing,
        // Every gap is narrated here, so every site is cited: the verdict adds
        // none of them again. Recorded as KEYS, so the suppression downstream
        // is identity-based and cannot collide with unrelated prose.
        citedGapSites: args.enumeration.gaps.map((g) => enumerationSiteKey(g.site)),
        confidence: "low",
        statement:
          "Exit window undetermined: no authority route was found, but the role enumeration was incomplete, so this cannot be a positive finding of immutability — only an absence of evidence.",
      };
    }

    return {
      status: "immutable_within_checks",
      enumeration: immutabilityWitness,
      basis,
      caveats: [
        `${args.capabilities.unmatchedSelectors.length} selector(s) on this contract are not in Ripcord's taxonomy and were NOT evaluated for privilege — an unmatched selector is "unclassified," never "not privileged"`,
        "authority enforced by a bespoke registry that exposes no getter at all (Rocket Pool's RocketStorage is the calibration example) is invisible to every check above, so this status is bounded by the checks named in `basis`, not a general claim of immutability",
      ],
      confidence: "medium",
      statement:
        "No rule-change route exists within the checks Ripcord performs: the code cannot be replaced, no owner or role holds authority, no delegated-authorisation handle resolves, and no taxonomy capability matched. This is a positive finding bounded by `caveats`, not a general proof of immutability.",
    };
  }

  const confidences = routes.map((r) => r.confidence);

  const immediate = routes.filter((r) => r.noticeStatus === "immediate");
  if (immediate.length > 0) {
    return {
      status: "no_notice",
      confidence: weakest(immediate.map((r) => r.confidence)),
      statement: `Exit window is zero: ${immediate.length} of ${routes.length} authority route(s) can change the rules with no notice at all (${immediate
        .map((r) => `${r.label} → ${r.effectiveControllerType} ${r.effectiveController}`)
        .join("; ")}). No exit speed can beat a change that requires no waiting.`,
    };
  }

  const unresolved = routes.filter((r) => r.noticeStatus === "undetermined");
  const unproven = routes.filter((r) => r.noticeStatus === "delay_not_proven_binding");
  if (unresolved.length > 0 || unproven.length > 0) {
    const delayed = routes.filter((r) => r.nominalDelaySeconds !== null);
    const nominal =
      delayed.length > 0
        ? delayed.map((r) => BigInt(r.nominalDelaySeconds!)).reduce((a, b) => (a < b ? a : b)).toString()
        : null;
    const missing = [
      ...unresolved.map((r) =>
        r.rolePrivilege === "unverified"
          ? `route "${r.label}" (holder ${r.effectiveController}) could not be shown to confer privilege, and could not be ruled out either — it contributes no notice period either way`
          : `route "${r.label}" terminates as ${r.terminationReason} at ${r.effectiveController} — its notice period is unknown`,
      ),
      ...unproven.map((r) => `route "${r.label}" has a ${r.nominalDelaySeconds}s delay that could not be proven binding (${r.timelock?.method})`),
    ];
    for (const m of missing) unknowns.push({ field: "exitWindow", reason: m });
    // `not_proven_binding` means "a delay exists but we could not verify it."
    // When NO route carries a delay at all there is nothing to be unproven
    // ABOUT, and labelling it that way would imply a delay the evidence never
    // found — the same laundering in the opposite direction. That case is
    // plain `undetermined`.
    if (nominal === null) {
      return {
        status: "undetermined",
        missing,
        citedGapSites: [],
        confidence: weakest(confidences),
        statement: `Exit window not established: ${missing.length} authority route(s) could not be resolved to a controller, and no route was found to impose any delay. Unknown notice is not the same as no risk, and it is not the same as a delay either.`,
      };
    }
    return {
      status: "not_proven_binding",
      nominalDelaySeconds: nominal,
      missing,
      citedGapSites: [],
      confidence: weakest(confidences),
      statement: `Delay present but NOT proven binding: the shortest observed delay is ${nominal}s, but it is not reported as an exit window because ${missing.length} route(s) could not be verified. An unverified delay is not a window.`,
    };
  }

  // Every route resolved to a proven-binding, non-zero delay.
  const min = routes.map((r) => BigInt(r.noticeSeconds!)).reduce((a, b) => (a < b ? a : b));

  // ...but a minimum is only as good as the set it ranges over. If any role
  // enumeration behind these routes was partial, an un-enumerated role could
  // hold a zero-notice power, and the true minimum would be lower than this one
  // — possibly zero. So `binding` requires the witness, and without it the
  // result degrades rather than being reported.
  //
  // It degrades to `not_proven_binding` rather than `undetermined` on purpose:
  // that variant's meaning is already "a delay exists but binding-ness OR
  // ANOTHER ROUTE is unresolved", which is exactly the situation, and it keeps
  // the observed figure instead of discarding it. The direction stays safe
  // because verdict.ts's branch for it can only yield `trapped` or
  // `undetermined`, never a reassuring verdict — and it can still reach
  // `trapped` when the exit already takes longer than the delay, which unseen
  // routes could only reinforce.
  const witness = witnessOf(args.enumeration);
  if (!witness) {
    const enumerationMissing = args.enumeration.gaps.map(
      (g) => `${gapSubject(g.site)} at ${g.where} could not be shown complete, so a route with less notice may exist and not have been seen: ${g.reason}`,
    );
    for (const m of enumerationMissing) unknowns.push({ field: "exitWindow", reason: m });
    return {
      status: "not_proven_binding",
      nominalDelaySeconds: min.toString(),
      missing: enumerationMissing,
      citedGapSites: args.enumeration.gaps.map((g) => enumerationSiteKey(g.site)),
      confidence: "low",
      statement: `A ${min}s delay was proven binding on every one of the ${routes.length} authority route(s) FOUND — but the authority picture behind those routes was not shown complete, so the route set itself is not established. The exit window is the MINIMUM notice across all routes, and a minimum taken over an incomplete set can only be too generous. The ${min}s figure is reported as a nominal delay, not as a window.`,
    };
  }

  return {
    status: "binding",
    windowSeconds: min.toString(),
    enumeration: witness,
    confidence: weakest(confidences),
    statement: `Exit window is ${min}s: every one of the ${routes.length} authority route(s) found imposes a delay that was proven binding, and the shortest is ${min}s. A rule change on any of them CAN begin at any time, but cannot take effect for at least that long.`,
  };
}
