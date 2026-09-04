/**
 * Orchestrates the detectors into a single report and validates it against
 * the zod schema before returning it. A report that fails its own schema
 * is a bug in Ripcord, not a bad target — that failure is surfaced, not
 * swallowed.
 */
import { keccak256, type Hex } from "viem";
import type { ChainReader } from "../chain/client.js";
import { detectProxy } from "../detect/proxy.js";
import { detectOwnership } from "../detect/ownership.js";
import { detectAccessControl } from "../detect/accessControl.js";
import { collectPowerHolders } from "../detect/accounts.js";
import { resolveAuthorityGraph, type AuthoritySeed } from "../detect/authority.js";
import { detectCapabilities } from "../detect/capabilities.js";
import { detectDependencies } from "../detect/dependencies.js";
import { analyseExitWindow } from "../detect/exitWindow.js";
import { detectAuthorityIndirection } from "../detect/authorityIndirection.js";
import { deriveEnumerationCompleteness } from "./enumeration.js";
import { analyseTimeToExit } from "../detect/timeToExit.js";
import { composeVerdict } from "./verdict.js";
import { taxonomyVersion } from "../detect/taxonomy.js";
import { clearedCapability, clearedRegistryVersion } from "../chain/clearedRegistry.js";
import { notify, type EngineStage, type RunObserver, type StageOutcome } from "./observer.js";
import {
  reportSchema,
  schemaVersion,
  rulesetVersion,
  type AuthorityIndirection,
  type AuthorityResolution,
  type CapabilitiesResult,
  type DependencyGraph,
  type Disclosure,
  type ErrorEntry,
  type ExitWindow,
  type ManualVerificationReason,
  type TimeToExit,
  type Report,
  type UnknownEntry,
} from "./schema.js";

/**
 * Whether a manual-verification entry is one the publication gate must block
 * on. See the reason vocabulary on `manualVerificationReasonSchema`: only an
 * unrecognised probe result carries a reading ("this might be unguarded") that
 * must not be published unverified.
 */
function blocksPublication(entry: { reason: ManualVerificationReason }): boolean {
  return entry.reason === "no_auth_revert_observed";
}

/**
 * Applies the publication gate described on `disclosureSchema`: a BLOCKING
 * `needsManualVerification` entry, at the target or anywhere in the dependency
 * graph, makes the report non-publishable. Deliberately conservative — it gates
 * on the presence of the uncertainty itself, never on how serious the entry
 * looks, so calibration is a mechanical check rather than a per-protocol ethics
 * call under time pressure.
 *
 * Only `reason: "no_auth_revert_observed"` blocks. `reverted_before_auth_check`
 * does not, and the distinction is a correctness fix rather than a relaxation:
 * the gate exists because "no recognised auth revert" cannot be told apart from
 * "no guard at all". When the contract demonstrably rejected the probe on a
 * state or argument precondition, no auth check ran, so there is no unguarded
 * reading to protect against. It is still reported in needsManualVerification,
 * because an untested capability must stay visible.
 */
export function assessDisclosure(chainId: number, capabilities: CapabilitiesResult, dependencies: DependencyGraph): Disclosure {
  // SURFACE COVERAGE. This gate must see every needsManualVerification entry
  // anywhere it can arise: today the target's own `capabilities` and each
  // dependency token's. `authorityResolution` does NOT appear here, and that is
  // correct ONLY BECAUSE the recursion runs ownership/AccessControl/timelock
  // detection but NOT capability probing, so it structurally cannot produce such
  // an entry. If capability probing is ever added to the recursion, this
  // function must fold its entries into `blockedBy` — otherwise a new
  // unguarded-looking capability would silently escape the publication gate.
  const cleared: Disclosure["cleared"] = [];

  // The TARGET's own needsManualVerification ALWAYS blocks — the cleared
  // registry only ever clears DEPENDENCIES (a blessed token a protocol holds),
  // never a protocol's own privileged functions, which are the point of the scan.
  const blockedBy: Disclosure["blockedBy"] = capabilities.needsManualVerification
    .filter(blocksPublication)
    .map((e) => ({
      location: `capabilities (${e.probedAddress})`,
      signature: e.signature,
      category: e.category,
    }));

  // Dependency-token entries are split: a capability documented as design on
  // THIS specific token (clearedRegistry.ts) is recorded in `cleared` and does
  // not block; anything else still blocks.
  for (const t of dependencies.tokens) {
    for (const e of t.capabilities.needsManualVerification) {
      if (!blocksPublication(e)) continue;
      const clearedEntry = clearedCapability(chainId, t.token, e.signature);
      if (clearedEntry) {
        cleared.push({
          location: `dependencies.tokens[${t.token}]`,
          token: t.token,
          signature: e.signature,
          category: e.category,
          justification: clearedEntry.justification,
          source: clearedEntry.source,
        });
      } else {
        blockedBy.push({
          location: `dependencies.tokens[${t.token}]`,
          signature: e.signature,
          category: e.category,
        });
      }
    }
  }

  if (blockedBy.length === 0) {
    const clearedNote =
      cleared.length > 0
        ? ` ${cleared.length} dependency capability/capabilities were cleared as documented design by the registry (see disclosure.cleared) and did not block.`
        : "";
    return {
      publishable: true,
      reason:
        "no blocking needsManualVerification entries at the target or in its dependency graph — this report contains only admin-capability findings (and any cleared, documented-design dependency capabilities), which the disclosure policy publishes freely." +
        clearedNote,
      blockedBy: [],
      clearedRegistryVersion,
      cleared,
    };
  }
  return {
    publishable: false,
    reason: `${blockedBy.length} capability/capabilities could not be attributed to a recognized guard by probing and are NOT cleared as documented design. Probing cannot distinguish "guarded by a scheme Ripcord doesn't recognize" from "not guarded at all," and the second reading would be a vulnerability claim about a live contract. Do not publish this report: keep it local until each entry below is either cleared by a human as a design property, or disclosed to the project. See the disclosure policy in README.`,
    blockedBy,
    clearedRegistryVersion,
    cleared,
  };
}

/**
 * @param observer Optional, presentation-only progress hooks (see observer.ts).
 *   Attaching one CANNOT change the report: every hook is invoked through
 *   `notify`, receives already-computed values, and nothing it does is read
 *   back. A report built with an observer is byte-identical to one built
 *   without, which `test/observer.test.ts` asserts directly.
 */
export async function buildReport(chain: ChainReader, target: Hex, observer?: RunObserver): Promise<Report> {
  const unknowns: UnknownEntry[] = [];
  const errors: ErrorEntry[] = [];

  const { code, evidence: codeEvidence } = await chain.getCode(target);
  const bytecodeSize = code ? (code.length - 2) / 2 : 0;
  const bytecodeHash = code ? keccak256(code) : null;

  const proxy = await runStage(
    "proxy",
    () => detectProxy(chain, target),
    errors,
    () => ({
      pattern: "unknown" as const,
      isProxy: false,
      implementation: null,
      beacon: null,
      admin: null,
      slots: {},
      evidence: [codeEvidence],
    }),
    observer,
    (value) => ({
      // A DELEGATECALL that matches no known slot layout is genuinely
      // unresolved, not a completed classification — see KNOWN EDGE #3a.
      outcome: value.pattern === "unknown" && value.isProxy ? "inconclusive" : "completed",
      detail: value.isProxy
        ? `${value.pattern} proxy${value.implementation ? ", implementation resolved" : ", implementation NOT resolved"}`
        : "no proxy pattern detected",
      metrics: { isProxy: value.isProxy, pattern: value.pattern, implementation: value.implementation, admin: value.admin },
    }),
  );
  notify(observer, "onProxy", proxy);

  // Authority-related state (owner, AccessControl roles) is always read from
  // `target`, never from `proxy.implementation`. A proxy's storage — where
  // owner/role state actually lives — belongs to the proxy address; the
  // implementation is only code reached via delegatecall, and querying it
  // directly would read the implementation contract's own (usually
  // uninitialized) storage instead.
  const ownership = await runStage(
    "ownership",
    () => detectOwnership(chain, target),
    errors,
    () => ({
      owner: { address: null, source: "detection failed, see errors[]", evidence: [] },
      pendingOwner: { address: null, source: "detection failed, see errors[]", evidence: [] },
    }),
    observer,
    (value) => ({
      outcome: "completed",
      // "No owner" is a real answer, not a failure — say so plainly rather than
      // letting an empty result read as a stage that did not run.
      detail: value.owner.address ? `owner ${value.owner.address}` : "no owner() found (this is an answer, not a gap)",
      metrics: { owner: value.owner.address, pendingOwner: value.pendingOwner.address },
    }),
  );
  notify(observer, "onOwnership", ownership);

  const accessControlDetection = await runStage(
    "accessControl",
    () => detectAccessControl(chain, target),
    errors,
    () => ({ result: { detected: false, method: "not_applicable" as const, roles: [], reconstruction: null }, unknowns: [] }),
    observer,
    ({ result }) => ({
      // A partial reconstruction has NOT fully answered. Reporting it as a
      // completion would let the UI show a green tick over a role set that may
      // be missing entries — the seam KNOWN EDGE #30 was built to close.
      outcome: result.reconstruction && result.reconstruction.complete === false ? "inconclusive" : "completed",
      detail: !result.detected
        ? "not an AccessControl contract"
        : `${result.roles.length} role(s) via ${result.method}${result.reconstruction?.complete === false ? " — PARTIAL reconstruction" : ""}`,
      metrics: {
        detected: result.detected,
        method: result.method,
        roles: result.roles.length,
        members: result.roles.reduce((n, r) => n + r.members.length, 0),
        reconstructionComplete: result.reconstruction ? result.reconstruction.complete : null,
      },
    }),
  );
  unknowns.push(...accessControlDetection.unknowns);
  notify(observer, "onAccessControl", accessControlDetection.result);

  // Capability detection scans the implementation's bytecode for a proxy
  // (see detectCapabilities), but attributes guards using THIS target's
  // owner()/AccessControl state — the implementation's own storage is not
  // where authority lives, same reasoning as ownership/accessControl above.
  const capabilityDetection = await runStage(
    "capabilities",
    () =>
      detectCapabilities(
        chain,
        target,
        proxy,
        ownership.owner.address as Hex | null,
        accessControlDetection.result.roles,
      ),
    errors,
    () => ({
      result: {
        taxonomyVersion,
        dispatcherRecognized: false,
        scannedAddress: null,
        probedAddress: target,
        selectorsExtracted: 0,
        unmatchedSelectors: [],
        findings: [],
        needsManualVerification: [],
        evidence: [],
      } as CapabilitiesResult,
      unknowns: [],
    }),
    observer,
    ({ result }) => ({
      // An unreadable dispatcher means the privileged surface was never
      // enumerated at all; that is inconclusive, not a clean scan of nothing.
      outcome: result.dispatcherRecognized ? "completed" : "inconclusive",
      detail: result.dispatcherRecognized
        ? `${result.selectorsExtracted} selector(s) recovered; ${result.findings.length} classified, ${result.unmatchedSelectors.length} unmatched`
        : "dispatcher shape not recognised — the selector surface could not be enumerated",
      // COUNTS ONLY. No signatures, no selectors, no probe payloads: the
      // publication gate has not run yet, and an unattributed capability
      // carries a possible "unguarded" reading about a live contract. See the
      // disclosure note in observer.ts.
      metrics: {
        dispatcherRecognized: result.dispatcherRecognized,
        selectorsExtracted: result.selectorsExtracted,
        classified: result.findings.length,
        unmatched: result.unmatchedSelectors.length,
        needsManualVerification: result.needsManualVerification.length,
      },
    }),
  );
  unknowns.push(...capabilityDetection.unknowns);
  notify(observer, "onCapabilities", capabilityDetection.result);

  const capabilityHolders = capabilityDetection.result.findings
    .filter((f) => f.guard.status === "attributed")
    .flatMap((f) =>
      (f.guard as Extract<typeof f.guard, { status: "attributed" }>).holders.map((address) => ({
        address,
        label: f.signature,
      })),
    );

  const powerHolders = await collectPowerHolders(chain, {
    owner: ownership.owner.address as Hex | null,
    pendingOwner: ownership.pendingOwner.address as Hex | null,
    proxyAdmin: proxy.admin as Hex | null,
    accessControlRoles: accessControlDetection.result.roles,
    capabilityHolders,
  });
  notify(observer, "onPowerHolders", powerHolders);

  // Day-3 recursive authority resolution. Seeds are the target's DIRECT
  // (depth-1) authorities — the same set powerHolders is built from — and the
  // resolver follows each until it terminates at an EOA/Safe/timelock, hits
  // the depth cap, or cycles. This is what lets the report show
  // "upgrade → ProxyAdmin → EOA 0x…" as a chain rather than stopping at
  // "type: contract," and it produces the authority paths the proof engine
  // impersonates from.
  const seeds: AuthoritySeed[] = [];
  const pushSeed = (addr: Hex | null | undefined, relation: string) => {
    if (addr) seeds.push({ address: addr, relation });
  };
  pushSeed(proxy.admin as Hex | null, "proxyAdmin");
  pushSeed(ownership.owner.address as Hex | null, "owner");
  pushSeed(ownership.pendingOwner.address as Hex | null, "pendingOwner");
  for (const role of accessControlDetection.result.roles) {
    for (const m of role.members) pushSeed(m as Hex, `accessControl:${role.name ?? role.role}`);
  }

  const authorityDetection = await runStage<{ resolution: AuthorityResolution | null; unknowns: UnknownEntry[] }>(
    "authorityResolution",
    async () => await resolveAuthorityGraph(chain, seeds),
    errors,
    () => ({ resolution: null, unknowns: [] }),
    observer,
    ({ resolution }) => ({
      // A path that terminates at max_depth or no_authority_found has not
      // resolved the controller. Saying "completed" would present "we stopped
      // looking" as "we found the end" — KNOWN EDGES #10 and #17.
      outcome:
        resolution && resolution.paths.some((p) => p.terminationReason === "max_depth" || p.terminationReason === "no_authority_found")
          ? "inconclusive"
          : "completed",
      detail: resolution
        ? `${resolution.paths.length} authority path(s) resolved${resolution.cyclesDetected.length ? `, ${resolution.cyclesDetected.length} cycle(s) recorded` : ""}`
        : "no authority resolution produced",
      metrics: {
        paths: resolution?.paths.length ?? 0,
        cycles: resolution?.cyclesDetected.length ?? 0,
        unresolved: resolution?.paths.filter((p) => p.terminationReason === "max_depth" || p.terminationReason === "no_authority_found").length ?? 0,
      },
    }),
  );
  const authorityResolution = authorityDetection.resolution;
  // The recursive tree, in full. This is what lets a viewer see the CHAIN —
  // "upgrade → ProxyAdmin → Timelock" — rather than stopping at the immediate
  // holder, and it is the difference between a power map that shows a delay
  // exists and one that shows only that a contract owns a contract.
  notify(observer, "onAuthority", authorityResolution);
  // Unknowns threaded up from deep in the authority tree (e.g. a partial role
  // reconstruction on a capped provider) — previously discarded by a swallowing
  // catch, now surfaced.
  unknowns.push(...authorityDetection.unknowns);
  if (authorityResolution) {
    for (const cyc of authorityResolution.cyclesDetected) {
      unknowns.push({
        field: "authorityResolution",
        reason: `authority cycle detected at ${cyc.address} (path: ${cyc.path.join(" -> ")}) — recorded as a finding rather than looped on`,
      });
    }
  }

  // --- The Exit Window, the time to exit, and the verdict. ---
  //
  // Ordering is not incidental: both stages consume what the earlier ones
  // produced (authorityResolution for the routes, capabilities for the guard
  // attributions and the selector set), so they run AFTER them and never
  // re-derive any of it — a route whose delay came from one walk of the
  // authority tree and whose controller came from another is exactly the quiet
  // attribution error this project forbids.
  //
  // A null result means the STAGE FAILED (and said so in errors[]). It never
  // means the window is fine: the verdict degrades to "undetermined".
  // Authority-indirection markers run BEFORE the exit window because the
  // window's "clean" status is conditional on them: a null here is treated as "a
  // delegated-authorisation handle cannot be ruled out", not as "there is none".
  const authorityIndirection = await runStage<AuthorityIndirection | null>(
    "authorityIndirection",
    () => detectAuthorityIndirection(chain, target),
    errors,
    () => null,
    observer,
    (value) => ({
      outcome: "completed",
      // `gettersProbed` is what makes an empty marker list mean "checked, found
      // none" rather than "never looked" — so it is reported, not just the hits.
      detail: value
        ? `${value.markers.length} indirection marker(s) from ${value.gettersProbed.length} getter(s) probed`
        : "indirection check did not run",
      metrics: { markers: value?.markers.length ?? null, gettersProbed: value?.gettersProbed.length ?? null },
    }),
  );
  notify(observer, "onAuthorityIndirection", authorityIndirection);

  // Dependencies run BEFORE the exit window, which they did not used to. The
  // enumeration witness below aggregates over every site the verdict could rest
  // on — including each dependency token's own role scan — and it has to exist
  // before the window is assessed, because the window's reassuring variants
  // cannot be constructed without it. Stage order is otherwise immaterial here:
  // every read is pinned and cached by key, so moving a stage changes no value.
  const dependencyDetection = await runStage(
    "dependencies",
    () => detectDependencies(chain, target),
    errors,
    () => ({ result: { tokens: [], oracles: [] } as DependencyGraph, unknowns: [] }),
    observer,
    ({ result }) => ({
      outcome: "completed",
      detail: `${result.tokens.length} major-token holding(s), ${result.oracles.length} oracle getter(s) resolved`,
      metrics: { tokens: result.tokens.length, oracles: result.oracles.length },
    }),
  );
  unknowns.push(...dependencyDetection.unknowns);

  // THE ENUMERATION WITNESS. Derived fail-closed (see report/enumeration.ts):
  // complete only where every enumeration site positively said so, with a failed
  // stage read from errors[] rather than from the fallback value it was replaced
  // by. This is what stops the minimum-notice arithmetic being computed over a
  // route set that was never fully seen.
  const enumeration = deriveEnumerationCompleteness({
    accessControl: accessControlDetection.result,
    authorityResolution,
    dependencies: dependencyDetection.result,
    errors,
    // The target's own privileged SURFACE, plus who exists to hold it. Role
    // enumeration was never the only way the picture could be incomplete:
    // Compound III passed every role check with a fully-resolved implementation
    // and still had a guarded, zero-notice `pause` sitting unevaluated among 67
    // unmatched selectors. See judgeCapabilitySurface.
    capabilities: capabilityDetection.result,
    owner: ownership.owner,
    pendingOwner: ownership.pendingOwner,
    proxy,
    indirection: authorityIndirection,
  });

  const exitWindowDetection = await runStage<{ result: ExitWindow | null; unknowns: UnknownEntry[] }>(
    "exitWindow",
    () =>
      analyseExitWindow(chain, {
        proxy,
        authorityResolution,
        capabilities: capabilityDetection.result,
        accessControlRoles: accessControlDetection.result.roles,
        authorityIndirection,
        enumeration,
      }),
    errors,
    () => ({ result: null, unknowns: [] }),
    observer,
    ({ result }) => ({
      // `undetermined` is the INVERTED DEFAULT from KNOWN EDGE #24: falling
      // through produces it, and it is a statement about the search, never
      // about the contract. It is reported as inconclusive so the UI cannot
      // paint it as a finished, reassuring answer.
      outcome: !result || result.assessment.status === "undetermined" ? "inconclusive" : "completed",
      detail: result
        ? `${result.routes.length} route(s); window ${result.assessment.status}`
        : "exit-window analysis produced no result",
      metrics: {
        routes: result?.routes.length ?? null,
        assessment: result?.assessment.status ?? null,
        bypasses: result?.bypasses.length ?? null,
      },
    }),
  );
  unknowns.push(...exitWindowDetection.unknowns);
  notify(observer, "onExitWindow", exitWindowDetection.result);

  const timeToExitDetection = await runStage<{ result: TimeToExit | null; unknowns: UnknownEntry[] }>(
    "timeToExit",
    () => analyseTimeToExit(chain, target, { proxy, capabilities: capabilityDetection.result }),
    errors,
    () => ({ result: null, unknowns: [] }),
    observer,
    ({ result }) => ({
      // `tight` is deliberately hard to earn. A non-tight bound is a floor with
      // named gaps, so it is not a completed measurement of the exit duration.
      outcome: result && result.tight ? "completed" : "inconclusive",
      detail: result
        ? `${result.status}${result.atLeastSeconds !== null ? ` — ${result.tight ? "" : "at least "}${result.atLeastSeconds}s` : " — no duration established"}`
        : "time-to-exit analysis produced no result",
      metrics: {
        status: result?.status ?? null,
        atLeastSeconds: result?.atLeastSeconds ?? null,
        tight: result?.tight ?? null,
        unmeasuredLegs: result?.unmeasuredLegs.length ?? null,
      },
    }),
  );
  unknowns.push(...timeToExitDetection.unknowns);
  notify(observer, "onTimeToExit", timeToExitDetection.result);

  // The verdict is a pure composition of the above — no chain access, no new
  // facts. The enumeration witness goes in so that no report can ever again say
  // `missing: []` while one of its own reconstruction blocks says the role set
  // may be incomplete: an internally self-contradicting report.
  const verdict = composeVerdict(exitWindowDetection.result, timeToExitDetection.result, enumeration);

  if (!code) {
    unknowns.push({ field: "target", reason: "address has no code at the pinned block (EOA or not yet deployed)" });
  }
  if (proxy.pattern === "unknown") {
    unknowns.push({
      field: "proxy.pattern",
      reason: "bytecode contains a DELEGATECALL but matches no known proxy storage pattern",
    });
  }
  // The dangerous misreading this guards against: an upgradeable proxy with
  // owner=null, accessControl.detected=false, and an empty powerHolders[]
  // looks identical, at a glance, to "no privileged power exists here." For
  // a confirmed proxy that is never true — something can upgrade it — we
  // just didn't recognise the mechanism. Say so explicitly rather than let
  // the absence of findings read as a clean bill of health.
  if (proxy.isProxy && !proxy.admin && !ownership.owner.address && !accessControlDetection.result.detected) {
    unknowns.push({
      field: "authority",
      reason:
        "target is a confirmed upgradeable proxy, but no upgrade authority could be identified via owner()/AccessControl — it likely uses a non-standard or custom access-control scheme; the proxy IS upgradeable by someone, manual review required",
    });
  }

  const blockHash = await runStage(
    "block",
    () => chain.getBlockHash(),
    errors,
    () => "0x" as Hex,
    observer,
    (value) => ({ outcome: "completed", detail: `block hash ${value}`, metrics: { blockHash: value } }),
  );

  const report: Report = {
    schemaVersion,
    rulesetVersion,
    generatedAt: new Date().toISOString(),
    chainId: chain.chainId,
    block: { number: chain.blockNumber.toString(), hash: blockHash },
    target: {
      address: target,
      hasCode: Boolean(code),
      bytecodeSize,
      bytecodeHash,
    },
    proxy,
    authority: {
      owner: ownership.owner,
      pendingOwner: ownership.pendingOwner,
      accessControl: accessControlDetection.result,
    },
    powerHolders,
    authorityResolution,
    capabilities: capabilityDetection.result,
    dependencies: dependencyDetection.result,
    proof: null,
    authorityIndirection,
    enumeration,
    exitWindow: exitWindowDetection.result,
    // The fork exit-restriction engine runs in a separate pass (like the proof
    // engine) via `ripcord restrict`, which merges its result and re-composes
    // the verdict. A plain `scan` never spawns anvil, so it is null here — never
    // a claim that no restriction exists.
    exitRestriction: null,
    timeToExit: timeToExitDetection.result,
    verdict,
    disclosure: assessDisclosure(chain.chainId, capabilityDetection.result, dependencyDetection.result),
    unknowns,
    errors,
  };

  const validated = reportSchema.safeParse(report);
  if (!validated.success) {
    throw new Error(
      `Ripcord produced a report that fails its own schema — this is a Ripcord bug, not a target problem:\n${validated.error.toString()}`,
    );
  }

  // Fires only AFTER schema validation and the disclosure gate, so a consumer
  // can never see a verdict from a report that failed its own schema, and the
  // publishable decision arrives together with the verdict it governs rather
  // than one frame later.
  notify(observer, "onVerdict", validated.data.verdict, validated.data.disclosure);

  return validated.data;
}

/**
 * Runs one detector stage, converting an exception into an `errors[]` entry plus
 * a safe fallback value rather than a crash.
 *
 * The observer notifications here are PURELY ADDITIVE: `notify` cannot throw,
 * the hooks receive already-computed values, and nothing on this path is read
 * back into the report. A stage that threw is reported as `degraded`, never as a
 * completion — the fallback value is a placeholder, and a UI painting it green
 * would assert a clean result the engine never produced.
 */
async function runStage<T>(
  stage: string,
  fn: () => Promise<T>,
  errors: ErrorEntry[],
  fallback: () => T,
  observer?: RunObserver,
  /** Describes the SUCCESSFUL outcome for the observer. Not called on the failure path. */
  describe?: (value: T) => { outcome: StageOutcome; detail: string | null; metrics?: Record<string, number | string | boolean | null> },
): Promise<T> {
  const engineStage = stage as EngineStage;
  notify(observer, "onStageStart", engineStage);
  try {
    const value = await fn();
    const described = describe?.(value);
    notify(observer, "onStageEnd", {
      stage: engineStage,
      outcome: described?.outcome ?? "completed",
      detail: described?.detail ?? null,
      ...(described?.metrics ? { metrics: described.metrics } : {}),
    });
    return value;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push({ stage, message });
    notify(observer, "onStageEnd", { stage: engineStage, outcome: "degraded", detail: message });
    return fallback();
  }
}
