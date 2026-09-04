/**
 * Deriving the aggregate enumeration witness — FAIL-CLOSED.
 *
 * The exit window is the minimum notice across every authority route, and that
 * arithmetic is sound only over a route set that was fully seen: an
 * un-enumerated role holding a zero-notice power makes it a minimum of the WRONG
 * SET. Role enumeration goes partial routinely — a provider that caps
 * `eth_getLogs` turns the event replay into a bounded recent window — and until
 * this module existed that partiality was recorded per scan and read by nothing.
 *
 * Two live instances out of 26 protocols, and the pair is why this AGGREGATES
 * rather than sitting on the target:
 *   Ethena Minting — its own scan covered 6,750 of 5.66M blocks and recovered
 *     only DEFAULT_ADMIN_ROLE, yet reported `can_exit_in_time`, `missing: []`.
 *   Ethena USDe — not an AccessControl contract, so a target-only check calls it
 *     complete; but its single route terminates at a TimelockController whose
 *     OWN roles were partially enumerated, and a timelock's PROPOSER/EXECUTOR
 *     holders are precisely what "this delay is binding" rests on.
 *
 * THE DERIVATION RULE: completeness is a POSITIVE claim. `complete` is true only
 * where every site positively reported it; a missing reconstruction, an
 * `undefined` flag, a stage that threw, a deployment block that could not be
 * found are all INCOMPLETE. Reading an absent flag as complete would launder a
 * failed read into a fact — the exact bug this witness closes — so `=== true`
 * throughout, never `!== false`.
 */
import {
  enumerationSiteKey,
  type AccessControlResult,
  type AuthorityNode,
  type AuthorityResolution,
  type DependencyGraph,
  type EnumerationCompleteness,
  type EnumerationGap,
  type AuthorityIndirection,
  type CapabilitiesResult,
  type EnumerationSite,
  type ErrorEntry,
  type OwnerField,
  type ProxyResult,
} from "./schema.js";

export { enumerationSiteKey };

/** Stages whose failure means some part of the authority picture was never built. */
const ENUMERATION_STAGES = ["accessControl", "authorityResolution", "dependencies"] as const;

/**
 * Judges ONE access-control result. Returns null when nothing is missing.
 *
 * The two fields are read together on purpose. `detected: false` is a positive
 * finding ("we asked, it is not an AccessControl contract") and needs no scan;
 * `detected: true` with a null reconstruction is the opposite — the contract HAS
 * roles and the scan never produced a verdict on them, which is strictly worse
 * than a partial scan and must never be mistaken for the first case.
 */
function judgeAccessControl(
  where: string,
  site: EnumerationSite,
  ac: Pick<AccessControlResult, "detected" | "reconstruction"> | null | undefined,
): EnumerationGap | null {
  if (!ac) {
    return { where, site, reason: "no access-control result is present at all, so role enumeration cannot be shown complete" };
  }
  if (!ac.detected) return null; // positively established: nothing to enumerate
  if (!ac.reconstruction) {
    return {
      where,
      site,
      reason:
        "AccessControl WAS detected but no reconstruction was produced (its deployment block could not be found, so the role scan never ran) — the role set is entirely unknown, not empty",
    };
  }
  // Strict equality: an `undefined` or otherwise unexpected value is incomplete.
  if (ac.reconstruction.complete !== true) {
    return { where, site, reason: ac.reconstruction.note };
  }
  return null;
}

/** Walks the authority tree, judging every node that actually ran a role scan. */
function walkNodes(node: AuthorityNode, gaps: EnumerationGap[]): void {
  const gap = judgeAccessControl(
    `authority:${node.address} (depth ${node.depth}, via ${node.relation})`,
    { kind: "authority", id: node.address.toLowerCase() },
    { detected: node.accessControlDetected, reconstruction: node.roleEnumeration },
  );
  if (gap) gaps.push(gap);
  for (const child of node.children) walkNodes(child, gaps);
}


/**
 * THE CAPABILITY-SURFACE JUDGEMENT.
 *
 * The original witness asked whether ROLE enumeration was complete. Compound III
 * passed that test and was still wrong: a decoded dispatcher, a clean
 * `reconstruction`, and a `pause(bool,bool,bool,bool,bool)` sitting in its 67
 * `unmatchedSelectors`, guarded, callable by a Safe that can shut withdrawals
 * with no notice. The report said "You can exit before the rules CAN change."
 *
 * No detector was at fault. `capabilities` recorded the selector, and
 * `timeToExit.blockable` noted that unmatched selectors were not evaluated —
 * but `blockable` is computed from TAXONOMY-MATCHED findings, so an unmatched
 * selector is invisible to it by construction, and the composition layer turned
 * that silence into reassurance.
 *
 * The rule is not "any unmatched selector": all 26 calibration reports have
 * some, so that would delete every reassuring verdict including WETH9's, earned
 * by deriving all 11 of its selectors. THE DISCRIMINATOR IS WHO COULD CALL ONE.
 * WETH9 and wstETH have no owner, no proxy admin, no role members and no
 * indirection marker — nobody for an unevaluated selector to be privileged FOR.
 *
 * So: a reassuring assessment may not stand while a privileged party exists AND
 * the privileged surface was not fully evaluated. Subtractive and caution-only.
 * "Fully evaluated" is a POSITIVE claim: the dispatcher decoded AND every
 * recovered selector classified. A dispatcher that failed to parse is not "no
 * selectors", it is "no answer".
 */
function judgeCapabilitySurface(args: {
  capabilities: CapabilitiesResult | null;
  owner: OwnerField | null;
  pendingOwner: OwnerField | null;
  proxy: ProxyResult | null;
  accessControl: AccessControlResult | null;
  indirection: AuthorityIndirection | null;
  authorityResolution: AuthorityResolution | null;
}): EnumerationGap | null {
  const site: EnumerationSite = { kind: "capabilitySurface", id: "" };
  if (!args.capabilities) {
    return {
      where: "capabilitySurface",
      site,
      reason: "no capability result is present at all, so the privileged surface cannot be shown to have been evaluated",
    };
  }
  const c = args.capabilities;
  const fullyEvaluated = c.dispatcherRecognized === true && c.unmatchedSelectors.length === 0;
  if (fullyEvaluated) return null;

  // Who could hold an unevaluated privileged selector? Each reason is a
  // positively-read pointer to a party, never an inference from absence.
  const parties: string[] = [];
  if (args.owner?.address) parties.push("owner()");
  if (args.pendingOwner?.address) parties.push("pendingOwner()");
  if (args.proxy?.admin) parties.push("proxy admin");
  for (const r of args.accessControl?.roles ?? []) {
    if (r.members.length > 0) parties.push(`role ${r.name ?? r.role}`);
  }
  for (const m of args.indirection?.markers ?? []) parties.push(m.signature);
  if ((args.authorityResolution?.roots.length ?? 0) > 0 && parties.length === 0) parties.push("a resolved authority route");
  if (parties.length === 0) return null; // nobody to be privileged: unevaluated selectors are inert

  const unevaluated = c.dispatcherRecognized
    ? `${c.unmatchedSelectors.length} of ${c.selectorsExtracted} selector(s) are not in Ripcord's taxonomy and were never evaluated for privilege`
    : "the dispatcher could not be decoded, so the privileged surface was never enumerated at all";
  return {
    where: "capabilitySurface",
    site,
    reason: `${unevaluated}, while ${parties.length} privileged party/parties exist over this contract (${[...new Set(parties)].join(", ")}). An unevaluated selector is "unclassified", never "not privileged" — so a capability that restricts or halts the exit cannot be ruled out, and no reassuring assessment can rest on this surface. Evaluating those selectors requires their signatures, which Ripcord does not retrieve from any external source — see the README on why a block-explorer lookup would break the pinned-and-cached determinism model.`,
  };
}

/**
 * The aggregate. Every site the minimum-window computation could rest on is
 * judged: the target, every contract the recursion walked at any depth, every
 * dependency token, and the stages themselves.
 */
export function deriveEnumerationCompleteness(args: {
  accessControl: AccessControlResult | null;
  authorityResolution: AuthorityResolution | null;
  dependencies: DependencyGraph | null;
  errors: ErrorEntry[];
  /**
   * The target's own privileged surface, and who exists to hold it.
   *
   * REQUIRED, not optional, and deliberately so. An absent capability result
   * fail-closes to "incomplete" — which is the right default but a silent one,
   * and a caller who simply forgets the field would get a permanently
   * unreachable reassuring verdict with no compile error to explain it. Making
   * it required turns "you must think about this" into something tsc enforces,
   * the same technique the z.literal(true) witnesses use downstream.
   */
  capabilities: CapabilitiesResult | null;
  owner: OwnerField | null;
  pendingOwner: OwnerField | null;
  proxy: ProxyResult | null;
  indirection: AuthorityIndirection | null;
}): EnumerationCompleteness {
  const gaps: EnumerationGap[] = [];

  // A stage that threw was replaced by a safe fallback whose shape is
  // indistinguishable from a real "nothing found" — so the failure itself is the
  // evidence, and it is read from errors[] rather than from the fabricated value.
  for (const stage of ENUMERATION_STAGES) {
    for (const e of args.errors.filter((x) => x.stage === stage)) {
      gaps.push({
        where: `stage:${stage}`,
        site: { kind: "stage", id: stage },
        reason: `the ${stage} stage failed (${e.message}), so its result is a fallback rather than an observation — nothing it reports can establish completeness`,
      });
    }
  }

  const targetGap = judgeAccessControl("target", { kind: "target", id: "" }, args.accessControl);
  if (targetGap) gaps.push(targetGap);

  // The privileged SURFACE, not just the role set — see judgeCapabilitySurface.
  const surfaceGap = judgeCapabilitySurface({
    capabilities: args.capabilities ?? null,
    owner: args.owner ?? null,
    pendingOwner: args.pendingOwner ?? null,
    proxy: args.proxy ?? null,
    accessControl: args.accessControl ?? null,
    indirection: args.indirection ?? null,
    authorityResolution: args.authorityResolution,
  });
  if (surfaceGap) gaps.push(surfaceGap);

  if (args.authorityResolution === null) {
    gaps.push({
      where: "authorityResolution",
      site: { kind: "authorityResolution", id: "" },
      reason: "authority resolution produced no result, so the routes feeding the window were never enumerated",
    });
  } else {
    for (const root of args.authorityResolution.roots) walkNodes(root, gaps);
  }

  if (args.dependencies === null) {
    gaps.push({
      where: "dependencies",
      site: { kind: "dependency", id: "" },
      reason: "the dependency graph produced no result, so dependency authority was never enumerated",
    });
  } else {
    for (const t of args.dependencies.tokens) {
      const gap = judgeAccessControl(
        `dependency:${t.token}`,
        { kind: "dependency", id: t.token.toLowerCase() },
        t.authority.accessControl,
      );
      if (gap) gaps.push(gap);
    }
  }

  const complete = gaps.length === 0;
  return {
    complete,
    gaps,
    note: complete
      ? "Every enumeration this verdict rests on reported itself complete: the target's role set, every contract the authority recursion walked, every dependency token, and the target's own privileged surface. No stage failed."
      : `${gaps.length} enumeration site(s) could not be shown complete, so the authority picture may be missing routes. The exit window is the MINIMUM notice across routes, and a minimum over an incomplete set can only be too generous — so no reassuring assessment is available here, whatever the routes that WERE found happen to say.`,
  };
}

/**
 * How to NAME a gap in prose. The two layers that narrate gaps — the exit-window
 * assessment and the verdict — used to hardcode "role enumeration at X", which
 * was accurate while role reconstruction was the only dimension. It no longer
 * is: a `capabilitySurface` gap is not a role scan, and calling it one is the
 * same prose-drifts-from-data failure the claim auditor exists to catch.
 */
export function gapSubject(site: EnumerationSite): string {
  switch (site.kind) {
    case "capabilitySurface":
      return "the privileged-surface evaluation";
    case "stage":
      return "a stage that failed";
    case "dependency":
      return "dependency role enumeration";
    default:
      return "role enumeration";
  }
}

/**
 * The witness a reassuring assessment needs. Returns null when enumeration was
 * not complete, which is what makes `binding` and `immutable_within_checks`
 * unconstructable in that case — the caller cannot proceed without it, because
 * the type demands a `complete: true` it has no way to fabricate.
 */
export function witnessOf(e: EnumerationCompleteness): { complete: true; basis: string } | null {
  return e.complete ? { complete: true, basis: e.note } : null;
}
