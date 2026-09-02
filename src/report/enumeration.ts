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
  type EnumerationSite,
  type ErrorEntry,
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
 * The aggregate. Every site the minimum-window computation could rest on is
 * judged: the target, every contract the recursion walked at any depth, every
 * dependency token, and the stages themselves.
 */
export function deriveEnumerationCompleteness(args: {
  accessControl: AccessControlResult | null;
  authorityResolution: AuthorityResolution | null;
  dependencies: DependencyGraph | null;
  errors: ErrorEntry[];
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
      ? "Every role enumeration this verdict rests on reported itself complete: the target, every contract the authority recursion walked, and every dependency token. No stage failed."
      : `${gaps.length} enumeration site(s) could not be shown complete, so the authority picture may be missing routes. The exit window is the MINIMUM notice across routes, and a minimum over an incomplete set can only be too generous — so no reassuring assessment is available here, whatever the routes that WERE found happen to say.`,
  };
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
