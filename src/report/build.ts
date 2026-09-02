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
 * happens to look, so calibration day is a mechanical check rather than a
 * per-protocol ethics call under time pressure.
 *
 * DAY 5: only `reason: "no_auth_revert_observed"` blocks. The day-5 sibling
 * reason `reverted_before_auth_check` does not, and the distinction is a
 * correctness fix rather than a relaxation. The gate exists because "no
 * recognised auth revert" cannot be told apart from "no guard at all," and
 * publishing the second reading would be a vulnerability claim about a live
 * contract. When the contract demonstrably rejected the probe on a state or
 * argument precondition — Ripcord's own zero-valued argument coming back as
 * "ERC20: approve from the zero address" — no auth check ran, so there is no
 * unguarded reading to protect against and nothing to disclose to anyone. It is
 * still reported in needsManualVerification, because an untested capability must
 * stay visible; it simply no longer pretends to be a possible vulnerability.
 */
export function assessDisclosure(chainId: number, capabilities: CapabilitiesResult, dependencies: DependencyGraph): Disclosure {
  // SURFACE COVERAGE. This gate must see every needsManualVerification entry
  // anywhere it can arise. Today those arise in exactly two places: the
  // target's own `capabilities`, and each dependency token's `capabilities`
  // (below). The day-3 authority path (authorityResolution) does NOT appear
  // here, and that omission is CORRECT ONLY BECAUSE the recursion runs
  // ownership/AccessControl/timelock detection but NOT capability probing — so
  // it structurally cannot produce a needsManualVerification entry. If capability
  // probing is ever added to the recursion (e.g. probing a resolved controller's
  // own functions), it will start producing that surface, and THIS function must
  // be extended to fold authorityResolution's entries into `blockedBy` — or a
  // new unguarded-looking capability would silently escape the publication gate.
  // Do not add capability probing to authority.ts without updating this gate.
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

export async function buildReport(chain: ChainReader, target: Hex): Promise<Report> {
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
  );

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
  );

  const accessControlDetection = await runStage(
    "accessControl",
    () => detectAccessControl(chain, target),
    errors,
    () => ({ result: { detected: false, method: "not_applicable" as const, roles: [], reconstruction: null }, unknowns: [] }),
  );
  unknowns.push(...accessControlDetection.unknowns);

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
  );
  unknowns.push(...capabilityDetection.unknowns);

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
  );
  const authorityResolution = authorityDetection.resolution;
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

  // --- Day 4: the Exit Window, the time to exit, and the verdict. ---
  //
  // Ordering matters and is not incidental. Both stages consume what the
  // earlier ones produced (authorityResolution for the routes, capabilities
  // for the guard attributions and the dispatcher's selector set), so they run
  // AFTER them and never re-derive any of it — a route whose delay came from
  // one walk of the authority tree and whose controller came from another
  // would be exactly the kind of quiet attribution error this project forbids.
  //
  // A null result here means the STAGE FAILED (and said so in errors[]). It
  // never means the window is fine: the verdict below degrades to
  // "undetermined" on a null, it does not skip the question.
  // Day-5 authority-indirection markers. Runs BEFORE the exit window because
  // the window's "clean" status is conditional on it: a null here (stage
  // failure) is treated as "a delegated-authorisation handle cannot be ruled
  // out," not as "there is none" — see the inverted default in exitWindow.ts.
  const authorityIndirection = await runStage<AuthorityIndirection | null>(
    "authorityIndirection",
    () => detectAuthorityIndirection(chain, target),
    errors,
    () => null,
  );

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
  );
  unknowns.push(...exitWindowDetection.unknowns);

  const timeToExitDetection = await runStage<{ result: TimeToExit | null; unknowns: UnknownEntry[] }>(
    "timeToExit",
    () => analyseTimeToExit(chain, target, { proxy, capabilities: capabilityDetection.result }),
    errors,
    () => ({ result: null, unknowns: [] }),
  );
  unknowns.push(...timeToExitDetection.unknowns);

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

  return validated.data;
}

async function runStage<T>(
  stage: string,
  fn: () => Promise<T>,
  errors: ErrorEntry[],
  fallback: () => T,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    errors.push({ stage, message: err instanceof Error ? err.message : String(err) });
    return fallback();
  }
}
