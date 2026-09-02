/**
 * Deriving the aggregate enumeration witness — FAIL-CLOSED.
 *
 * The exit window is the minimum notice across every authority route. That
 * arithmetic is only sound over a route set that was fully seen: an
 * un-enumerated role holding a zero-notice power makes the minimum a minimum of
 * the wrong set, and the verdict comes out reassuring about a protocol nobody
 * can leave in time. Role enumeration goes partial routinely — a provider that
 * caps `eth_getLogs` turns the event replay into a bounded recent window — and
 * until this module existed that partiality was recorded per scan and read by
 * nothing downstream.
 *
 * Two live instances out of 26 calibration protocols, and the pair is the reason
 * this is an AGGREGATE and not a flag on the target:
 *
 *   Ethena Minting — its own scan covered 6,750 of 5.66M blocks and recovered
 *     only DEFAULT_ADMIN_ROLE (0 members). Verdict: `can_exit_in_time`,
 *     `missing: []`, window `binding` at `confidence: high`.
 *   Ethena USDe   — NOT an AccessControl contract, so a target-only check calls
 *     it complete. Its single authority route terminates at a
 *     TimelockController whose OWN roles were partially enumerated — and a
 *     timelock's PROPOSER/EXECUTOR/TIMELOCK_ADMIN holders are precisely what
 *     "this delay is binding" rests on. Same verdict, one hop deeper.
 *
 * THE DERIVATION RULE, and the reason this file is separate and small enough to
 * read in one sitting: **completeness is a positive claim.** `complete` is true
 * only where every enumeration site positively reported completeness. Every
 * other shape — a missing reconstruction, an `undefined` flag, a stage that
 * threw and was replaced by a fallback, a contract whose deployment block could
 * not be found so the scan never ran — is INCOMPLETE. Reading an absent flag as
 * "complete" would launder a failed read into a fact, which is the exact bug
 * class this witness closes; introducing it here, inside the fix, would be the
 * worst possible place for it. Hence `=== true` throughout, never `!== false`.
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
 * THE CAPABILITY-SURFACE JUDGEMENT (added after Compound III proved role
 * enumeration is not the only way the picture can be incomplete).
 *
 * The original witness asked whether ROLE enumeration was complete. Comet passed
 * that test and was still wrong: a fully-resolved implementation, a decoded
 * dispatcher, `reconstruction` clean — and a `pause(bool,bool,bool,bool,bool)`
 * sitting in its 67 `unmatchedSelectors`, guarded, callable by a 5-of-N Safe
 * that can shut withdrawals with no notice at all. The report said "You can exit
 * before the rules CAN change." A holder reading that would believe the door
 * stays open.
 *
 * The failure was not in any detector. `capabilities` recorded the selector
 * honestly, and `timeToExit.blockable` said in its own note that "unmatched
 * selectors were not evaluated for privilege". But `blockable` is computed from
 * TAXONOMY-MATCHED findings, so an unmatched selector is invisible to it BY
 * CONSTRUCTION, however privileged it is — and the composition layer turned that
 * silence into reassurance. Same shape as KNOWN EDGE #24, one layer down.
 *
 * WHY THE RULE IS NOT "ANY UNMATCHED SELECTOR". Measured before it was written:
 * all 26 calibration reports have unmatched selectors, so that rule would delete
 * every reassuring verdict in the set — including WETH9's, which was earned by
 * deriving all 11 of its selectors and confirming none is privileged. A rule
 * that fires everywhere discriminates nowhere.
 *
 * THE DISCRIMINATOR IS WHO COULD CALL ONE. An unevaluated selector is only a
 * risk if some party holds privilege over this contract. WETH9 and wstETH have
 * no owner, no pendingOwner, no proxy admin, no role members and no authority
 * indirection — there is nobody for an unevaluated selector to be privileged
 * FOR, so theirs are harmless and their true negative survives. Comet has a
 * timelock governor, a proxy admin and a guardian pointer, any of which might
 * hold one of 67 unevaluated selectors.
 *
 * So: a reassuring assessment may not stand while a privileged party exists AND
 * the privileged surface was not fully evaluated. Subtractive only — it can
 * withhold the witness, never fabricate a route — and caution-only in direction,
 * exactly like every other gap here.
 *
 * "Fully evaluated" is a POSITIVE claim, in keeping with the rest of this file:
 * the dispatcher must have been decoded AND every selector it recovered must
 * have been classified. One implementation address resolved is not enough; a
 * dispatcher that failed to parse is not "no selectors", it is "no answer".
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
