/**
 * The Ripcord report schema. Every finding carries evidence pointing at the
 * exact read that produced it — a finding without evidence is a rumour, not
 * a finding. `unknowns` and `errors` are always present, always populated
 * honestly: an empty array there is a claim that nothing went wrong, so
 * nothing gets suppressed to make an array empty.
 */
import { z } from "zod";

export const schemaVersion = "0.13.0";
export const rulesetVersion = "0.13.0";

const hexString = z.string().regex(/^0x[0-9a-fA-F]*$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

export const evidenceSchema = z.object({
  kind: z.enum(["storage_slot", "call", "log", "bytecode"]),
  params: z.record(z.string(), z.unknown()),
  rawValue: z.unknown(),
  block: z.string(),
});
export type Evidence = z.infer<typeof evidenceSchema>;

/**
 * The ONE certainty vocabulary, shared across every layer that expresses "how
 * much to trust this" as a degree: authority-depth confidence (high at a direct
 * hop, degrading with each hop), role-reconstruction completeness (high for a
 * full scan / authoritative getters, lower for a partial window), and any
 * future certainty axis. Deliberately NOT reused for things that are not
 * certainty — e.g. taxonomy `nameMatchSpecificity` ("is this a standard name")
 * is a different question and has its own enum, so a generic name is never
 * silently read as low confidence. One scale for certainty, and only certainty.
 */
export const depthConfidenceSchema = z.enum(["high", "medium", "low"]);
export type DepthConfidence = z.infer<typeof depthConfidenceSchema>;

export const unknownEntrySchema = z.object({
  field: z.string(),
  reason: z.string(),
});
export type UnknownEntry = z.infer<typeof unknownEntrySchema>;

export const errorEntrySchema = z.object({
  stage: z.string(),
  message: z.string(),
});
export type ErrorEntry = z.infer<typeof errorEntrySchema>;

// --- proxy ---

export const proxyPatternSchema = z.enum([
  "eip1967_transparent",
  "eip1967_uups",
  "eip1967_beacon",
  "eip1167_minimal_proxy",
  "legacy_zos_unstructured",
  "not_a_proxy",
  "unknown",
]);
export type ProxyPattern = z.infer<typeof proxyPatternSchema>;

export const proxySchema = z.object({
  pattern: proxyPatternSchema,
  isProxy: z.boolean(),
  implementation: address.nullable(),
  beacon: address.nullable(),
  admin: address.nullable(),
  slots: z.record(z.string(), hexString.nullable()),
  evidence: z.array(evidenceSchema),
});
export type ProxyResult = z.infer<typeof proxySchema>;

// --- authority: ownership ---

export const ownerFieldSchema = z.object({
  address: address.nullable(),
  source: z.string(),
  evidence: z.array(evidenceSchema),
});
export type OwnerField = z.infer<typeof ownerFieldSchema>;

// --- authority: access control ---

export const roleEntrySchema = z.object({
  role: hexString,
  name: z.string().nullable(),
  members: z.array(address),
  adminRole: hexString.nullable(),
  evidence: z.array(evidenceSchema),
});
export type RoleEntry = z.infer<typeof roleEntrySchema>;

/**
 * How complete the role reconstruction is, and how much to trust it — the
 * weakest-link principle applied to the AccessControl event scan. The role
 * history is reconstructed by replaying RoleGranted/RoleRevoked over a block
 * range chunked to the provider's real eth_getLogs limit (probed, see
 * rpcPreflight.ts). When the full range can't be covered within the request
 * budget, the scan degrades to a bounded recent window and says so HERE —
 * `complete: false`, a lowered `confidence`, and the exact `scannedFromBlock`
 * so a reader knows precisely what was and wasn't observed. This is never a
 * silent truncation: a partial reconstruction that reads as a full one would
 * be exactly the false-confidence the project forbids.
 *
 * `confidence` uses the same high/medium/low certainty scale as authority-depth
 * confidence (one vocabulary): high = full scan or authoritative Enumerable
 * getters; medium = Enumerable membership is authoritative but the role-hash
 * discovery scan was partial (a role never touched in the covered window could
 * be missed); low = non-Enumerable membership reconstructed from a partial
 * event window (both the role set and its membership may be incomplete).
 */
export const roleReconstructionSchema = z.object({
  complete: z.boolean(),
  confidence: depthConfidenceSchema,
  note: z.string(),
  /** The provider's probed eth_getLogs max block range used for chunking. */
  maxLogRange: z.string().nullable(),
  scannedFromBlock: z.string().nullable(),
  scannedToBlock: z.string().nullable(),
});
export type RoleReconstruction = z.infer<typeof roleReconstructionSchema>;

/**
 * ENUMERATION COMPLETENESS — the aggregate witness (day 5.5).
 *
 * `roleReconstructionSchema` above says whether ONE scan saw everything. This
 * says whether EVERY enumeration the verdict rests on did, across the target,
 * every contract the authority recursion walked at any depth, and every
 * dependency token. It exists because the per-scan flag was recorded and then
 * read by nothing: the exit window computes the minimum notice across the routes
 * it FOUND, so an un-enumerated role holding a zero-notice power produces a
 * reassuring verdict about a protocol nobody can actually leave.
 *
 * Found live on two of the 26 calibration protocols, and the second one is why
 * this is an aggregate rather than a flag on the target:
 *   - Ethena Minting: its own role scan covered 6,750 of 5.66M blocks and
 *     recovered only DEFAULT_ADMIN_ROLE, yet the report said
 *     `can_exit_in_time` with `missing: []`.
 *   - Ethena USDe: not an AccessControl contract at all, so a target-only check
 *     would have called it complete — but its single authority route terminates
 *     at a TimelockController whose OWN roles were partially enumerated, and
 *     those roles are exactly what "the delay is binding" rests on.
 *
 * FAIL-CLOSED BY CONSTRUCTION. `complete` is a POSITIVE claim: it is true only
 * where completeness was positively established at every site. A missing
 * reconstruction, an `undefined` flag, a stage that threw, a contract whose
 * deployment block could not be found — all are incomplete. Reading an absent
 * flag as "complete" would launder a failed read into a fact, which is the exact
 * bug class this witness closes, so the derivation must never do it either.
 */
/**
 * The STRUCTURAL identity of an enumeration site (day 6).
 *
 * `where` is prose meant for a reader ("authority:0x… (depth 2, via owner)").
 * `site` is the same thing as data, and it exists because two layers narrate
 * the same gap — the exit-window assessment when it degrades over one, and the
 * verdict which appends every gap on every branch — and the second must be able
 * to tell "this is the gap the assessment already stated" from "this is a
 * different gap that happens to share some words".
 *
 * The dedup used to compare `where` as a SUBSTRING of each `missing[]` entry.
 * That works on the current calibration set by an accident of wording, not by
 * construction, and the failure it invites is silent: `where` for the target is
 * the bare string "target", so any unrelated missing[] sentence containing the
 * word "target" anywhere would suppress a real enumeration gap and produce a
 * report that under-states what it failed to see. Comparing identities instead
 * means a suppression can only ever collapse the two representations of the
 * SAME site.
 */
export const enumerationSiteSchema = z.object({
  kind: z.enum(["stage", "target", "authority", "dependency", "authorityResolution", "capabilitySurface"]),
  /** The address, stage name, or "" for the singleton kinds. Lowercased where it is an address. */
  id: z.string(),
});
export type EnumerationSite = z.infer<typeof enumerationSiteSchema>;

/** The canonical key for a site. The ONLY thing dedup is allowed to compare. */
export function enumerationSiteKey(site: EnumerationSite): string {
  return site.id ? `${site.kind}:${site.id}` : site.kind;
}

export const enumerationGapSchema = z.object({
  /** Which enumeration fell short — "target", "authority:0x…", "dependency:0x…", or a failed stage. */
  where: z.string(),
  /** The same site as structured data. Dedup keys on this, never on `where`. */
  site: enumerationSiteSchema,
  reason: z.string(),
});
export type EnumerationGap = z.infer<typeof enumerationGapSchema>;

export const enumerationCompletenessSchema = z.object({
  complete: z.boolean(),
  /** Every site where completeness was NOT positively established. Empty if and only if `complete`. */
  gaps: z.array(enumerationGapSchema),
  note: z.string(),
});
export type EnumerationCompleteness = z.infer<typeof enumerationCompletenessSchema>;

/**
 * The witness a reassuring assessment must carry to exist at all.
 *
 * `complete` is a zod LITERAL `true`, so `binding` and `immutable_within_checks`
 * are structurally unconstructable when any enumeration was partial — the same
 * technique `GuardStatus` uses to stop a capability claiming a holder it cannot
 * evidence, applied here to stop a window claiming a route set it did not see.
 * An invariant the compiler and zod enforce cannot be forgotten by a caller.
 */
export const enumerationWitnessSchema = z.object({
  complete: z.literal(true),
  basis: z.string(),
});
export type EnumerationWitness = z.infer<typeof enumerationWitnessSchema>;

export const accessControlSchema = z.object({
  detected: z.boolean(),
  method: z.enum(["enumerable", "event_reconstruction", "not_applicable"]),
  roles: z.array(roleEntrySchema),
  /** Null when not applicable (contract is not AccessControl, or deployment block couldn't be found). */
  reconstruction: roleReconstructionSchema.nullable(),
});
export type AccessControlResult = z.infer<typeof accessControlSchema>;

export const authoritySchema = z.object({
  owner: ownerFieldSchema.nullable(),
  pendingOwner: ownerFieldSchema.nullable(),
  accessControl: accessControlSchema.nullable(),
});
export type AuthorityResult = z.infer<typeof authoritySchema>;

// --- power holders / account classification ---

export const safeInfoSchema = z.object({
  threshold: z.number().int().positive(),
  owners: z.array(address),
  version: z.string().nullable(),
});
export type SafeInfo = z.infer<typeof safeInfoSchema>;

export const accountTypeSchema = z.enum(["eoa", "safe", "contract", "unknown"]);
export type AccountType = z.infer<typeof accountTypeSchema>;

export const powerHolderSchema = z.object({
  address,
  type: accountTypeSchema,
  safe: safeInfoSchema.nullable(),
  viaCapabilities: z.array(z.string()),
  evidence: z.array(evidenceSchema),
});
export type PowerHolder = z.infer<typeof powerHolderSchema>;

// --- capabilities (day 2) ---

export const capabilityCategorySchema = z.enum([
  "CODE_CHANGE",
  "FUND_MOVEMENT",
  "SUPPLY",
  "ACCESS_RESTRICTION",
  "ECONOMIC",
  "AUTHORITY_CHANGE",
]);
export type CapabilityCategory = z.infer<typeof capabilityCategorySchema>;

/**
 * How SPECIFIC a taxonomy signature's NAME is — NOT a certainty score, and
 * deliberately named so it can never be misread as one (it is not on the
 * shared high/medium/low `depthConfidenceSchema` certainty scale). The
 * selector match itself is always exact (a keccak comparison). This field only
 * says how safely the name's conventional MEANING can be assumed:
 *   "standard" — a widely-adopted signature (OZ upgradeTo, transferOwnership,
 *     ERC20 mint) whose name reliably implies the capability.
 *   "generic"  — a commonly-reused name with no single dominant meaning
 *     (sweep/skim/emergencyWithdraw/rescueTokens). The match is exact, but what
 *     the name IMPLIES varies by project, so a reader should not assume intent
 *     from the name alone. This is a semantic caveat, not lower confidence in
 *     the detection.
 */
export const nameMatchSpecificitySchema = z.enum(["standard", "generic"]);
export type NameMatchSpecificity = z.infer<typeof nameMatchSpecificitySchema>;

/**
 * Guard attribution as a discriminated union on `status` — this is the
 * type-level enforcement of weakest-link provenance for capabilities: only
 * the "attributed" variant has a `holders` field, and zod's
 * discriminatedUnion rejects any object that doesn't match one shape
 * exactly, so a capability finding is structurally incapable of claiming an
 * attributed holder without also carrying the evidence a real attribution
 * requires. `holders` (not `holder`) because an AccessControl role can have
 * more than one member — attribution must not silently drop members to fit
 * a single-address shape.
 */
export const guardAttributedSchema = z.object({
  status: z.literal("attributed"),
  holders: z.array(address).min(1),
  authSource: z.enum(["owner", "accessControlRole"]),
  role: hexString.nullable(),
  evidence: z.array(evidenceSchema),
});
export const guardGuardedUnknownHolderSchema = z.object({
  status: z.literal("guarded_unknown_holder"),
  note: z.string(),
  evidence: z.array(evidenceSchema),
});
export const guardInconclusiveSchema = z.object({
  status: z.literal("inconclusive"),
  note: z.string(),
  evidence: z.array(evidenceSchema),
});
export const guardStatusSchema = z.discriminatedUnion("status", [
  guardAttributedSchema,
  guardGuardedUnknownHolderSchema,
  guardInconclusiveSchema,
]);
export type GuardStatus = z.infer<typeof guardStatusSchema>;

export const capabilityFindingSchema = z.object({
  selector: hexString,
  signature: z.string(),
  category: capabilityCategorySchema,
  nameMatchSpecificity: nameMatchSpecificitySchema,
  /** The address whose bytecode this selector was extracted from — the implementation, for a proxy. */
  scannedAddress: address,
  /**
   * The address the guard probe actually called — always the target/proxy,
   * never the implementation. These are different addresses for a proxy and
   * the distinction is load-bearing: a delegatecall through the proxy runs
   * the implementation's code against the PROXY's storage, which is where
   * owner/role state lives. Probing the implementation directly reads its
   * own (usually uninitialized) storage, so any revert it produces says
   * nothing about who controls the proxy.
   */
  probedAddress: address,
  guard: guardStatusSchema,
});
export type CapabilityFinding = z.infer<typeof capabilityFindingSchema>;

/**
 * Why a privileged-taxonomy capability could not become a normal finding.
 * Day 2 had one reason; day-5 calibration showed it was carrying two very
 * different meanings, and that the conflation was making the disclosure gate
 * fire on the wrong thing.
 *
 *  - `no_auth_revert_observed`    — nothing recognisable came back from any of
 *    the three probes. This is NEVER a claim that the function is unguarded
 *    (probing cannot prove that, and asserting it would be a vulnerability
 *    claim about a live contract) — but it cannot rule that reading out
 *    either, so it BLOCKS publication.
 *  - `reverted_before_auth_check` — the contract rejected the probe on a
 *    recognised state or argument precondition, so execution never reached an
 *    authorisation check. Ripcord probes with zero-valued arguments, so this
 *    is a fact about the PROBE, not about the contract's guards. It supports
 *    no vulnerability reading at all, and therefore does NOT block
 *    publication. It is still surfaced, because "we could not test this" must
 *    never silently vanish into a clean-looking report.
 *
 * Neither reason ever asserts a guard exists. That claim requires a recognised
 * auth revert, and it lives in `guard.status`, not here.
 */
export const manualVerificationReasonSchema = z.enum(["no_auth_revert_observed", "reverted_before_auth_check"]);
export type ManualVerificationReason = z.infer<typeof manualVerificationReasonSchema>;

export const manualVerificationEntrySchema = z.object({
  selector: hexString,
  signature: z.string(),
  category: capabilityCategorySchema,
  scannedAddress: address,
  /** The address the probes actually called — the target/proxy. See CapabilityFinding.probedAddress. */
  probedAddress: address,
  reason: manualVerificationReasonSchema,
  note: z.string(),
  probes: z.array(evidenceSchema),
});
export type ManualVerificationEntry = z.infer<typeof manualVerificationEntrySchema>;

export const capabilitiesResultSchema = z.object({
  taxonomyVersion: z.string(),
  dispatcherRecognized: z.boolean(),
  /** Bytecode source: the implementation for a proxy. Null when the dispatcher wasn't recognized, or the scanned address has no code. */
  scannedAddress: address.nullable(),
  /** Guard-probe call target: always the target/proxy itself. */
  probedAddress: address,
  /**
   * Total selectors the dispatcher recovered, and the ones that matched no
   * taxonomy entry. Without these, a contract exposing 60 functions of which
   * Ripcord classifies 2 looks identical in the report to a contract that
   * only has 2 functions — "we found 2 capabilities" would quietly read as
   * "there are only 2." An unmatched selector is not "not privileged," it is
   * "not in Ripcord's taxonomy table"; listing them lets a reader audit that
   * coverage gap instead of taking it on trust.
   */
  selectorsExtracted: z.number().int().nonnegative(),
  unmatchedSelectors: z.array(hexString),
  findings: z.array(capabilityFindingSchema),
  needsManualVerification: z.array(manualVerificationEntrySchema),
  evidence: z.array(evidenceSchema),
});
export type CapabilitiesResult = z.infer<typeof capabilitiesResultSchema>;

// --- timelock (day 3) ---

/**
 * A timelock is a terminal authority worth its own shape: what matters is
 * not just "a contract" but "a contract that imposes a delay," and how long.
 * `kind` records which family the delay accessor came from; `delaySeconds`
 * is null (with a note) when the contract smells like a timelock — has the
 * roles or the neighbouring accessors — but its delay itself could not be
 * read, which is reported as "timelock: delay undetermined," never dropped.
 *
 * `adminCanShortenDelay` is a day-3 FLAG, not a day-3 answer: it records
 * whether the delay-mutation selector (updateDelay/setDelay) is present in
 * the timelock's own bytecode. Presence means the delay is not immutable —
 * the fuller question of who can reach that path and under what constraint
 * (it is normally itself gated by the current delay) is explicitly day-4
 * Exit Window work. `null` = not determined.
 */
export const timelockInfoSchema = z.object({
  kind: z.enum(["openzeppelin", "compound_bravo", "unknown"]),
  delaySeconds: z.string().nullable(),
  cancellers: z.array(address).nullable(),
  executors: z.array(address).nullable(),
  adminCanShortenDelay: z.boolean().nullable(),
  note: z.string(),
  evidence: z.array(evidenceSchema),
});
export type TimelockInfo = z.infer<typeof timelockInfoSchema>;

// --- recursive authority resolution (day 3) ---

export const authorityNodeTypeSchema = z.enum([
  "eoa",
  "safe",
  "timelock",
  "contract",
  "unknown",
]);
export type AuthorityNodeType = z.infer<typeof authorityNodeTypeSchema>;

/**
 * Why a branch of the authority tree stopped where it did. Every leaf states
 * one of these explicitly — "we stopped looking" is never left to be inferred
 * from an empty `children`, exactly as `unknowns[]` is never left empty by
 * omission elsewhere.
 */
export const terminationReasonSchema = z.enum([
  "eoa", // no code — a plain key, the end of the line
  "safe", // Gnosis Safe: recorded threshold+owners, do not recurse into signers
  "timelock", // a delay-imposing contract: recorded, not recursed past
  "max_depth", // hit the depth cap with an unresolved contract — NOT silently truncated
  "cycle", // this address already appears higher in the path (A owns B owns A)
  "no_authority_found", // a contract, but no owner()/AccessControl/proxyAdmin authority could be identified
  "not_a_contract_holder", // resolved as a leaf without recursing (used for direct EOA/Safe roots)
]);
export type TerminationReason = z.infer<typeof terminationReasonSchema>;


export interface AuthorityNode {
  address: string;
  /** How this node was reached from its parent: "owner", "pendingOwner", "proxyAdmin", "accessControl:<role>", or "root". */
  relation: string;
  depth: number;
  confidence: DepthConfidence;
  type: AuthorityNodeType;
  safe: SafeInfo | null;
  timelock: TimelockInfo | null;
  terminal: boolean;
  terminationReason: TerminationReason;
  /**
   * Whether AccessControl was DETECTED on this node, and how complete its role
   * scan was. Two fields rather than one nullable, so "positively established as
   * not an AccessControl contract" is never confused with "we did not manage to
   * enumerate it" — see `enumerationCompletenessSchema`.
   */
  accessControlDetected: boolean;
  roleEnumeration: RoleReconstruction | null;
  /** The resolved authorities of this node, if it is a non-terminal contract. Empty for a terminal leaf. */
  children: AuthorityNode[];
  evidence: Evidence[];
}

export const authorityNodeSchema: z.ZodType<AuthorityNode> = z.lazy(() =>
  z.object({
    address,
    relation: z.string(),
    depth: z.number().int().nonnegative(),
    confidence: depthConfidenceSchema,
    type: authorityNodeTypeSchema,
    safe: safeInfoSchema.nullable(),
    timelock: timelockInfoSchema.nullable(),
    terminal: z.boolean(),
    terminationReason: terminationReasonSchema,
    /**
     * Whether AccessControl was DETECTED on this node, and how complete its role
     * scan was. Recorded per node because a partial enumeration one hop down is
     * just as capable of hiding a zero-notice route as one on the target — see
     * `enumerationCompletenessSchema`, and the live Ethena USDe case that forced
     * it. Two fields rather than one nullable, so "not an AccessControl
     * contract" (positively established) is never confused with "we did not
     * manage to enumerate it".
     */
    accessControlDetected: z.boolean(),
    roleEnumeration: roleReconstructionSchema.nullable(),
    children: z.array(authorityNodeSchema),
    evidence: z.array(evidenceSchema),
  }),
);

/**
 * A single flattened authority PATH — "upgrade → ProxyAdmin → EOA 0x…" —
 * derived from the tree for readability and as the input the proof engine
 * simulates from. `hops` is ordered root-first; `effectiveController` is the
 * terminal address a path resolves to (the address the proof engine would
 * impersonate), with the reason it terminated and the confidence at that
 * depth.
 */
export const authorityPathSchema = z.object({
  label: z.string(),
  hops: z.array(
    z.object({
      address,
      relation: z.string(),
      type: authorityNodeTypeSchema,
      depth: z.number().int().nonnegative(),
    }),
  ),
  effectiveController: address.nullable(),
  effectiveControllerType: authorityNodeTypeSchema.nullable(),
  terminationReason: terminationReasonSchema,
  confidence: depthConfidenceSchema,
});
export type AuthorityPath = z.infer<typeof authorityPathSchema>;

export const authorityResolutionSchema = z.object({
  maxDepth: z.number().int().positive(),
  roots: z.array(authorityNodeSchema),
  paths: z.array(authorityPathSchema),
  /** Addresses where a cycle was detected, recorded as findings rather than looped on. */
  cyclesDetected: z.array(
    z.object({ address, path: z.array(address) }),
  ),
});
export type AuthorityResolution = z.infer<typeof authorityResolutionSchema>;

// --- dependency graph (day 2) ---

export const tokenDependencySchema = z.object({
  token: address,
  balance: z.string(),
  balanceEvidence: z.array(evidenceSchema),
  proxy: proxySchema,
  authority: authoritySchema,
  capabilities: capabilitiesResultSchema,
  powerHolders: z.array(powerHolderSchema),
});
export type TokenDependency = z.infer<typeof tokenDependencySchema>;

export const oracleDependencySchema = z.object({
  /** The getter that resolved this address, e.g. "oracle()" or "priceFeed()". */
  source: z.string(),
  address,
  authority: authoritySchema,
  powerHolders: z.array(powerHolderSchema),
});
export type OracleDependency = z.infer<typeof oracleDependencySchema>;

export const dependencyGraphSchema = z.object({
  tokens: z.array(tokenDependencySchema),
  oracles: z.array(oracleDependencySchema),
});
export type DependencyGraph = z.infer<typeof dependencyGraphSchema>;

// --- disclosure gate ---

/**
 * Machine-checkable publication gate, so the disclosure policy is process
 * discipline rather than a judgement call made per protocol under time
 * pressure on calibration day.
 *
 * The rule: a report whose `needsManualVerification` is non-empty — at the
 * target or anywhere in its dependency graph — is NOT publishable. Those
 * entries are exactly the cases where probing could not tell "guarded by a
 * scheme Ripcord doesn't recognize" apart from "not guarded at all," and the
 * second reading is a vulnerability claim about a live contract. Such a
 * report stays local until either (a) a human clears the entry as a design
 * property, or (b) disclosure to the project has happened.
 *
 * `publishable: true` therefore means "contains only admin-capability
 * findings," which the README's disclosure policy publishes freely. It is
 * deliberately conservative: it gates on the presence of the uncertainty,
 * not on anyone's assessment of how serious it looks.
 */
export const disclosureSchema = z.object({
  publishable: z.boolean(),
  reason: z.string(),
  /** Where the blocking entries are, so a human knows what to clear. */
  blockedBy: z.array(
    z.object({
      location: z.string(),
      signature: z.string(),
      category: capabilityCategorySchema,
    }),
  ),
  /** The version of the cleared-dependency registry this assessment used, so a clearing decision is auditable and reproducible. */
  clearedRegistryVersion: z.string(),
  /**
   * Dependency capabilities that WOULD have blocked publication but were
   * cleared as documented design by the registry (see clearedRegistry.ts).
   * Recorded explicitly — never silently dropped — so a reader sees exactly
   * what was waved through, on which token, and why.
   */
  cleared: z.array(
    z.object({
      location: z.string(),
      token: address,
      signature: z.string(),
      category: capabilityCategorySchema,
      justification: z.string(),
      source: z.string(),
    }),
  ),
});
export type Disclosure = z.infer<typeof disclosureSchema>;

// --- proof engine (day 3) ---

/**
 * The result of trying to turn a static CODE_CHANGE capability claim into an
 * executed demonstration on a sandbox fork. This is the pillar of the tool,
 * and its honesty rules are load-bearing:
 *
 *  - `attempted: false` — no proof was tried (e.g. the target archetype
 *    wasn't present). Neutral.
 *  - `attempted: true, produced: false` — a proof was attempted and could
 *    NOT be produced. `failureReason` says why. A missing proof is honest;
 *    the alternative (a hand-waved or fabricated trace) is disqualifying.
 *  - `attempted: true, produced: true` — the admin's own legitimate path was
 *    executed on a fork and funds were observed to move. Every string here is
 *    CAPABILITY, not intent: "this authority CAN move $X," never "will,"
 *    never "malicious."
 *
 * Everything happens on an anvil mainnet fork pinned to the report's block.
 * No mainnet transaction is ever sent, no key is held. `reproduceCommand`
 * lets a judge replay the exact simulation; `traceArtifact` points at the
 * stored human-readable call trace.
 */
export const proofDeltaSchema = z.object({
  token: address,
  symbol: z.string(),
  decimals: z.number().int().nonnegative(),
  balanceBefore: z.string(),
  balanceAfter: z.string(),
  delta: z.string(),
  /** USD value of the delta, and where the price came from. `null` usd means the price could not be read (see priceSource). */
  usd: z.number().nullable(),
  priceSource: z.string(),
});
export type ProofDelta = z.infer<typeof proofDeltaSchema>;

export const proofSchema = z.object({
  attempted: z.boolean(),
  produced: z.boolean(),
  archetype: z.string(),
  /**
   * The notice period attached to the impersonated authority, from the day-4
   * exit window. Added on day 4 to close an honesty gap the exit-window work
   * exposed in the day-3 engine: anvil impersonation executes as the
   * controller WITHOUT its queue, so a proof driven from a timelocked
   * authority demonstrates a capability that in reality requires N seconds of
   * public notice first. "This authority CAN move $X" was true and misleading
   * at once. The fork cannot skip a delay it never simulated, so the delay is
   * stated instead: null means no notice applies (or none was established, per
   * `noticeNote`), "0" means a genuinely zero-notice authority.
   */
  noticeSeconds: z.string().nullable(),
  /** How `noticeSeconds` was derived, or why it is null. Always populated. */
  noticeNote: z.string(),
  /** The capability this proof demonstrates, e.g. "CODE_CHANGE via upgrade". */
  capability: z.string().nullable(),
  /** The address impersonated — the RESOLVED effective controller from authorityResolution, not the proxy's nominal owner. */
  impersonated: address.nullable(),
  impersonatedVia: z.string().nullable(),
  /** The upgrade authority path the proof was driven from, echoed for the reader. */
  authorityPath: authorityPathSchema.nullable(),
  deltas: z.array(proofDeltaSchema),
  totalUsd: z.number().nullable(),
  headline: z.string(),
  failureReason: z.string().nullable(),
  sandboxNote: z.string(),
  reproduceCommand: z.string().nullable(),
  traceArtifact: z.string().nullable(),
  forkBlock: z.string(),
  evidence: z.array(evidenceSchema),
});
export type Proof = z.infer<typeof proofSchema>;

// --- exit window (day 4) ---

/**
 * Whether a detected delay is actually BINDING on the authority it is meant
 * to constrain. This is the crux of day 4 and the single most dangerous place
 * in the whole tool to be optimistic: reporting a comforting delay that an
 * admin can cut to zero is worse than reporting nothing at all.
 *
 * Determined by PROBE, never by reading source or guessing from a name (see
 * exitWindow.ts). The four outcomes are deliberately asymmetric — the only way
 * to reach `proven_binding` is positive evidence that the delay mutator can be
 * reached ONLY through the timelock itself (so changing the delay is itself
 * subject to the current delay), or that no delay mutator exists in the
 * timelock's own interface at all. Everything else degrades.
 */
export const delayBindingSchema = z.enum([
  /** The delay cannot be shortened faster than the delay itself. Positive evidence required. */
  "proven_binding",
  /** A delay mutator is reachable by a role/owner directly — the delay is a setting, not a constraint. */
  "shortenable",
  /** A mutator exists but its guard could not be read. NEVER treated as binding. */
  "cannot_determine",
]);
export type DelayBinding = z.infer<typeof delayBindingSchema>;

/** How the binding determination was reached — the evidence class, stated so a reader can audit the inference. */
export const delayBindingMethodSchema = z.enum([
  /** Probing the mutator produced a "caller must be the timelock itself" revert. */
  "self_call_gated_revert",
  /** Probing the mutator produced an Ownable/AccessControl-shaped revert — a role holder can call it directly. */
  "role_gated_revert",
  /** Neither updateDelay nor setDelay appears in the timelock's own dispatcher. */
  "no_mutator_present",
  /** A mutator exists; no probe returned an interpretable revert. Not a claim either way. */
  "probe_inconclusive",
  /** The delay itself could not be read, so there is nothing to bind. */
  "delay_unreadable",
]);
export type DelayBindingMethod = z.infer<typeof delayBindingMethodSchema>;

export const timelockBindingSchema = z.object({
  address,
  kind: z.enum(["openzeppelin", "compound_bravo", "unknown"]),
  delaySeconds: z.string().nullable(),
  binding: delayBindingSchema,
  method: delayBindingMethodSchema,
  /**
   * Whether the timelock contract is ITSELF behind a proxy. A delay enforced
   * by upgradeable code is only as binding as the upgrade authority over that
   * code — checked explicitly rather than assumed away.
   */
  timelockIsUpgradeable: z.boolean().nullable(),
  note: z.string(),
  evidence: z.array(evidenceSchema),
});
export type TimelockBinding = z.infer<typeof timelockBindingSchema>;

/**
 * What notice a single authority route imposes. `noticeSeconds` is only ever
 * non-null when the status justifies a number: "immediate" (proven zero — an
 * EOA or Safe imposes no TIME barrier) or "delayed" (a proven-binding delay).
 * A delay that exists but isn't proven binding carries its raw value in
 * `nominalDelaySeconds` and leaves `noticeSeconds` null, so an unverified
 * delay can never be read as a window.
 */
export const routeNoticeStatusSchema = z.enum([
  "immediate",
  "delayed",
  "delay_not_proven_binding",
  "undetermined",
]);
export type RouteNoticeStatus = z.infer<typeof routeNoticeStatusSchema>;

/**
 * Whether an AccessControl role route was established to confer any privilege
 * at all.
 *
 * This exists because of a false positive found live on Ethena's sUSDe: three
 * plain EOAs hold `FULL_RESTRICTED_STAKER_ROLE`, and the day-1/day-3 authority
 * seeding treats every role member as an authority — so the exit window
 * initially reported "3 of 4 routes can change the rules with zero notice"
 * about three addresses that are BLACKLISTED USERS and can change nothing.
 * OpenZeppelin AccessControl roles are used as markers and tags at least as
 * often as they are used for privilege (restricted-staker, KYC, whitelist
 * patterns), and membership alone establishes neither.
 *
 * So a role route must EARN its place in the window arithmetic, by one of
 * three pieces of real evidence:
 *   - it is DEFAULT_ADMIN_ROLE, which is privileged by construction in OZ
 *     AccessControl (it administers every role by default);
 *   - it is the `adminRole` of some other role, so it can grant roles; or
 *   - a day-2 capability probe attributed a guard to this exact role hash.
 * Anything else is `unverified`, and an unverified route contributes
 * `undetermined` — never a proven zero.
 *
 * That direction is deliberate and its safety rests on one property: an
 * unverified route can never produce a confident window either. A single
 * unverified route forces the whole assessment out of `binding`, so this can
 * only ever turn a false "zero notice" into an honest "not established" — it
 * can never turn a real risk into a clean bill.
 */
export const rolePrivilegeSchema = z.enum(["not_a_role", "verified", "unverified"]);
export type RolePrivilege = z.infer<typeof rolePrivilegeSchema>;

export const exitWindowRouteSchema = z.object({
  /** The relation this route was reached by — "proxyAdmin", "owner", "accessControl:MINTER_ROLE". */
  label: z.string(),
  rolePrivilege: rolePrivilegeSchema,
  /** Why the route was or was not credited with privilege. Always populated. */
  rolePrivilegeNote: z.string(),
  /** The depth-1 authority this route starts at. */
  root: address,
  effectiveController: address.nullable(),
  effectiveControllerType: authorityNodeTypeSchema.nullable(),
  terminationReason: terminationReasonSchema,
  noticeStatus: routeNoticeStatusSchema,
  noticeSeconds: z.string().nullable(),
  nominalDelaySeconds: z.string().nullable(),
  timelock: timelockBindingSchema.nullable(),
  /**
   * Capability categories this route is known to reach, cross-referenced from
   * attributed capability findings (plus CODE_CHANGE for a transparent proxy's
   * admin, which is what a ProxyAdmin is FOR). Best-effort and possibly
   * incomplete — an empty array means "none were attributed to this holder,"
   * never "this route is harmless."
   */
  categories: z.array(capabilityCategorySchema),
  confidence: depthConfidenceSchema,
  note: z.string(),
  /**
   * How this route's notice was established. "static" (the default, and every
   * day-4 route) means it was inferred from the authority map and guard/timelock
   * probes without executing anything. "fork_confirmed" means the day-7
   * exit-restriction engine DEMONSTRATED it on a fork: it ran the baseline exit,
   * had this route's party close it, and observed the exit then fail. A reader
   * seeing `no_notice` must be able to tell a delay we could not verify apart
   * from a kill switch we watched fire — this is that field.
   */
  confirmationMethod: z.enum(["fork_confirmed", "static"]).default("static"),
  /**
   * For a fork_confirmed exit-restrictor route only: whether the exit was
   * OPEN at the pinned block and this party can shut it (`restrictable` — the
   * live Comet case: `isWithdrawPaused()` is false now, the guardian can flip
   * it with zero notice), or was ALREADY shut at the pinned block
   * (`already_shut` — the baseline exit itself reverts before any mutation).
   * Null on every static route. This is the "you can be trapped at any moment"
   * versus "you are already trapped" distinction, carried as queryable data.
   */
  restrictionState: z.enum(["restrictable", "already_shut"]).nullable().default(null),
});
export type ExitWindowRoute = z.infer<typeof exitWindowRouteSchema>;

/** A concrete way the real window could be shorter than a nominal delay suggests. */
export const bypassKindSchema = z.enum([
  /** A parallel authority route with no delay at all. A timelock on one path is worth nothing beside it. */
  "ungated_route",
  /** The delay mutator is role-gated, so the constrained party can shorten it directly. */
  "delay_shortenable",
  /** A delay mutator exists and its guard could not be read — cannot rule out shortening. */
  "delay_mutability_undetermined",
  /** The timelock contract is itself upgradeable — the delay is only as binding as that upgrade authority. */
  "timelock_upgradeable",
  /** The timelock's delay reads zero. */
  "zero_delay",
  /** A timelock-shaped contract whose delay could not be read at all. */
  "delay_undetermined",
  /** An authority route whose controller could not be resolved — an un-delayed path cannot be excluded. */
  "unresolved_authority",
]);
export type BypassKind = z.infer<typeof bypassKindSchema>;

export const bypassSchema = z.object({
  kind: bypassKindSchema,
  /** The route this bypass applies to, or null when it is protocol-wide. */
  route: z.string().nullable(),
  detail: z.string(),
  confidence: depthConfidenceSchema,
  evidence: z.array(evidenceSchema),
});
export type Bypass = z.infer<typeof bypassSchema>;

/**
 * The record that a check RAN. Without this, an empty `bypasses[]` is
 * ambiguous between "we checked and found none" and "we never looked" — and
 * the second reading, presented as the first, is exactly the false-clean
 * result this project forbids. `performed: false` entries name the checks
 * Ripcord deliberately does NOT make, so the gaps are enumerated rather than
 * invisible.
 */
export const bypassCheckSchema = z.object({
  check: z.string(),
  description: z.string(),
  performed: z.boolean(),
  found: z.boolean(),
  note: z.string(),
});
export type BypassCheck = z.infer<typeof bypassCheckSchema>;

/**
 * The exit-window assessment, as a discriminated union on `status` — the same
 * type-level enforcement of weakest-link provenance that `GuardStatus` applies
 * to capabilities, applied here to the metric itself. ONLY the `binding`
 * variant carries `windowSeconds`. A delay that could not be proven binding is
 * structurally incapable of appearing as a window: zod rejects the shape. That
 * is deliberate, because "reported a comforting delay an admin can bypass" is
 * the worst failure this tool has available to it.
 *
 *  - `binding`                 every route resolved, every delay proven binding, minimum > 0.
 *  - `no_notice`               at least one resolved route imposes ZERO delay. Proven, not assumed.
 *  - `not_proven_binding`      a delay exists but binding-ness (or another route) is unresolved.
 *  - `immutable_within_checks` POSITIVE evidence of no mutation route, bounded by `caveats`.
 *  - `undetermined`            nothing could be resolved; `missing` names what is absent.
 *
 * THE DAY-5 SPLIT, and why it is an epistemic fix rather than a rename. Until
 * day 5 this union carried a status called `no_rule_change_route_found`, which
 * treated the ABSENCE OF A FOUND ROUTE as the ABSENCE OF A ROUTE. Those are two
 * different claims, and collapsing them let "unknown is never safe" — the rule
 * the whole project is built on — leak back in at the very last layer, where it
 * is hardest to see. Calibration caught it: the status fired on three mainnet
 * contracts and was substantively wrong on two, because both delegate authority
 * through an indirection Ripcord does not model (Balancer's `getAuthorizer()`,
 * rETH's RocketStorage registry). A human read "No exit-window risk was
 * identified" about contracts that are fully controllable.
 *
 * So the DEFAULT IS INVERTED. `undetermined` is the safe outcome and the one
 * reached by falling through; `immutable_within_checks` is a POSITIVE CLAIM that
 * must be earned, and it carries the `basis[]` that earned it. Every condition
 * in that basis is a read Ripcord actually performed — no delegatecall in the
 * runtime bytecode, no owner, no roles, no capability finding, no authority
 * indirection marker, and a dispatcher that was actually decoded. Its bound
 * stays attached in `caveats[]`: unmatched selectors were not evaluated, and a
 * bespoke authority registry that exposes no getter at all remains invisible.
 */
export const exitWindowAssessmentSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("binding"),
    windowSeconds: z.string(),
    /** Unconstructable unless every enumeration the routes rest on was complete. */
    enumeration: enumerationWitnessSchema,
    confidence: depthConfidenceSchema,
    statement: z.string(),
  }),
  z.object({
    status: z.literal("no_notice"),
    confidence: depthConfidenceSchema,
    statement: z.string(),
  }),
  z.object({
    status: z.literal("not_proven_binding"),
    /** The raw delay observed, carried HERE and never as a window. */
    nominalDelaySeconds: z.string().nullable(),
    missing: z.array(z.string()),
    /**
     * The enumeration sites this assessment has ALREADY narrated in `missing`,
     * as canonical keys. The verdict appends every remaining gap and uses this
     * to avoid restating one — structurally, by key equality, never by matching
     * prose. Empty when the assessment degraded for reasons unrelated to
     * enumeration.
     */
    citedGapSites: z.array(z.string()),
    confidence: depthConfidenceSchema,
    statement: z.string(),
  }),
  z.object({
    status: z.literal("immutable_within_checks"),
    /** Unconstructable unless every enumeration the claim rests on was complete. */
    enumeration: enumerationWitnessSchema,
    /**
     * The positive findings that earn this status. Never empty: this variant
     * exists to carry evidence, and a status that asserts something without it
     * would be the very thing the day-5 split was made to prevent.
     */
    basis: z.array(z.string()),
    caveats: z.array(z.string()),
    confidence: depthConfidenceSchema,
    statement: z.string(),
  }),
  z.object({
    status: z.literal("undetermined"),
    missing: z.array(z.string()),
    /** See `not_proven_binding.citedGapSites`. */
    citedGapSites: z.array(z.string()),
    confidence: depthConfidenceSchema,
    statement: z.string(),
  }),
]);
export type ExitWindowAssessment = z.infer<typeof exitWindowAssessmentSchema>;

export const exitWindowSchema = z.object({
  rulesVersion: z.string(),
  assessment: exitWindowAssessmentSchema,
  routes: z.array(exitWindowRouteSchema),
  bypasses: z.array(bypassSchema),
  checksPerformed: z.array(bypassCheckSchema),
  evidence: z.array(evidenceSchema),
});
export type ExitWindow = z.infer<typeof exitWindowSchema>;

// --- exit-restriction fork evaluation (day 7) ---

/**
 * THE EXIT-RESTRICTION ENGINE (day 7).
 *
 * Every layer before this REASONS about whether a privileged party could shut a
 * holder's exit. This layer TESTS it: on a sandbox fork pinned to the report
 * block it establishes a real baseline exit, then — one restriction candidate
 * registered by the matched archetype at a time — impersonates its guarding party, calls it with a
 * bounded-adversarial argument, and re-runs the exit. If the exit then fails,
 * the function is a DIRECT exit-restrictor, demonstrated rather than inferred.
 *
 * THE EPISTEMIC CEILING, honoured in the types, not just the copy. You cannot
 * prove a protocol is safe to exit — the absence of ANY restriction path over
 * an open space (arguments, call sequences, oracle/liquidity manipulation) is
 * not provable by testing, for anyone. So a clean run is NEVER `can_exit_in_time`
 * and never claims safety. Its positive outcome is the deliberately weaker
 * `no_direct_restriction_found`, whose scope is stated on every rendering:
 * "evaluated N registered candidates on a fork; none directly blocked a baseline
 * withdrawal. Not a guarantee — argument space and indirect/economic
 * restrictions were not exhausted." A FOUND restrictor, by contrast, is
 * decisive: a party can close the exit, and if un-timelocked it is a zero-notice
 * route that caps the verdict.
 *
 * THE RISKIEST NEW FALSE-CLEAN is misidentifying the exit action. Testing
 * against the wrong exit function would clear a protocol that is actually
 * trappable. So exit-action identification is weakest-link: `no_direct_
 * restriction_found` is unreachable unless the exit action was confidently
 * identified AND a baseline exit was established. Anything less is
 * `exit_action_unconfident` / `baseline_unestablished`, both of which keep the
 * verdict `undetermined`.
 */
export const exitActionStatusSchema = z.enum(["identified", "unconfident", "none"]);

/** How a holder actually leaves — identified by interface/signature pattern, never guessed. */
export const exitActionSchema = z.object({
  status: exitActionStatusSchema,
  /** The interface family matched, e.g. "compound-comet-base", "erc4626", "erc20-transfer". */
  interfaceName: z.string(),
  /** The exact exit function, when identified. */
  signature: z.string().nullable(),
  selector: hexString.nullable(),
  confidence: depthConfidenceSchema,
  note: z.string(),
  evidence: z.array(evidenceSchema),
});
export type ExitAction = z.infer<typeof exitActionSchema>;

/** The control: a holder position on the fork for whom the exit action succeeds BEFORE any mutation. */
export const exitBaselineSchema = z.object({
  status: z.enum(["established", "unestablished", "not_attempted"]),
  /** The fork account whose exit was exercised. */
  holder: address.nullable(),
  /** How the position was obtained: an on-chain holder impersonated, or funded+supplied on the fork. */
  holderSource: z.string(),
  note: z.string(),
  evidence: z.array(evidenceSchema),
});
export type ExitBaseline = z.infer<typeof exitBaselineSchema>;

/**
 * One privileged function put through the differential.
 *
 * `result` is the whole point and is POSITIVELY established: `restrictor` only
 * when the baseline exit succeeded before and reverted after this party's
 * mutation; `no_effect` when the exit still succeeded after; `inconclusive`
 * when the mutation itself could not be executed (so nothing about the exit was
 * learned — never read as `no_effect`); `not_evaluated` when the candidate was
 * outside the bounded budget and is reported, not silently dropped.
 */
export const restrictionCandidateSchema = z.object({
  selector: hexString,
  signature: z.string().nullable(),
  category: capabilityCategorySchema.nullable(),
  /** The party impersonated to call this function, from the resolved authority/guard map. */
  guardingParty: address.nullable(),
  guardingPartyType: authorityNodeTypeSchema.nullable(),
  /** Human description of the bounded-adversarial argument used, e.g. "withdraw-pause = true". */
  args: z.string(),
  result: z.enum(["restrictor", "no_effect", "inconclusive", "not_evaluated"]),
  /** The notice this party's route imposes — 0 for an un-timelocked guardian, sourced from the exit-window route. */
  noticeSeconds: z.string().nullable(),
  detail: z.string(),
  evidence: z.array(evidenceSchema),
});
export type RestrictionCandidate = z.infer<typeof restrictionCandidateSchema>;

export const exitRestrictionOutcomeSchema = z.enum([
  "restrictor_found", // at least one candidate closed the baseline exit — decisive
  "no_direct_restriction_found", // exit ID'd, baseline established, all registered candidates evaluated, none closed it — the weak positive tier
  "evaluation_inconclusive", // a candidate or aggregate-enumeration gap prevents the clean direction from concluding
  "exit_action_unconfident", // could not confidently identify the exit action → undetermined
  "baseline_unestablished", // could not establish a baseline exit on the fork → undetermined
  "no_candidates", // no guarded/restriction-family function to test
  "not_run", // engine did not run (no anvil, non-fork mode)
]);
export type ExitRestrictionOutcome = z.infer<typeof exitRestrictionOutcomeSchema>;

export const exitRestrictionSchema = z.object({
  rulesVersion: z.string(),
  attempted: z.boolean(),
  archetype: z.string(),
  outcome: exitRestrictionOutcomeSchema,
  exitAction: exitActionSchema,
  baseline: exitBaselineSchema,
  /** Every candidate the differential considered, with its result. */
  candidates: z.array(restrictionCandidateSchema),
  /** The subset with result === "restrictor". Redundant with candidates, surfaced for the reader. */
  restrictors: z.array(restrictionCandidateSchema),
  /** Every condition that blocks the deliberately weak clean outcome. Empty only when none exists. */
  evaluationGaps: z.array(z.string()),
  coverage: z.object({
    /** Restriction candidates registered by the matched exit archetype. */
    guardedTotal: z.number().int().nonnegative(),
    /** How many were actually put through the differential (the rest are `not_evaluated`). */
    evaluated: z.number().int().nonnegative(),
  }),
  /**
   * `restrictable` — the exit is open now and a party can shut it (Comet).
   * `already_shut` — the baseline exit itself fails at the pinned block.
   * `none_found` — evaluated, nothing closed the exit. `undetermined` — not run
   * or exit/baseline not established. This is the "already trapped" vs "can be
   * trapped at any moment" distinction as data.
   */
  restrictionState: z.enum(["restrictable", "already_shut", "none_found", "undetermined"]),
  confirmationMethod: z.enum(["fork_confirmed", "not_confirmed"]),
  forkBlock: z.string(),
  sandboxNote: z.string(),
  /** The three named ceiling items — rendered verbatim so the scope is never hidden. */
  ceiling: z.array(z.string()),
  reproduceCommand: z.string().nullable(),
  evidence: z.array(evidenceSchema),
}).superRefine((value, ctx) => {
  const issue = (message: string, path: (string | number)[] = []) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });

  if (value.outcome === "no_direct_restriction_found") {
    if (value.exitAction.status !== "identified") issue("a clean fork outcome requires an identified exit action", ["exitAction", "status"]);
    if (value.baseline.status !== "established") issue("a clean fork outcome requires an established baseline", ["baseline", "status"]);
    if (value.restrictors.length !== 0) issue("a clean fork outcome cannot contain restrictors", ["restrictors"]);
    if (value.evaluationGaps.length !== 0) issue("a clean fork outcome cannot contain evaluation gaps", ["evaluationGaps"]);
    if (value.coverage.guardedTotal === 0) issue("a clean fork outcome requires at least one registered candidate", ["coverage", "guardedTotal"]);
    if (value.candidates.length !== value.coverage.guardedTotal) issue("candidate count must equal guardedTotal for a clean fork outcome", ["candidates"]);
    if (value.coverage.evaluated !== value.coverage.guardedTotal) issue("every registered candidate must be evaluated for a clean fork outcome", ["coverage"]);
    if (value.candidates.some((candidate) => candidate.result !== "no_effect")) issue("every candidate must positively return no_effect for a clean fork outcome", ["candidates"]);
    if (value.restrictionState !== "none_found") issue("a clean fork outcome requires restrictionState=none_found", ["restrictionState"]);
    if (value.confirmationMethod !== "fork_confirmed") issue("a clean fork outcome requires fork confirmation", ["confirmationMethod"]);
  }

  if (value.outcome === "evaluation_inconclusive") {
    if (value.exitAction.status !== "identified") issue("an inconclusive evaluation requires an identified exit action", ["exitAction", "status"]);
    if (value.baseline.status !== "established") issue("an inconclusive evaluation requires an established baseline", ["baseline", "status"]);
    if (value.restrictors.length !== 0) issue("an inconclusive evaluation cannot contain a demonstrated restrictor", ["restrictors"]);
    if (value.evaluationGaps.length === 0) issue("an inconclusive evaluation must name at least one evaluation gap", ["evaluationGaps"]);
    if (value.restrictionState !== "undetermined") issue("an inconclusive evaluation requires restrictionState=undetermined", ["restrictionState"]);
    if (value.confirmationMethod !== "not_confirmed") issue("an inconclusive evaluation cannot claim fork confirmation", ["confirmationMethod"]);
  }

  if (value.outcome === "restrictor_found") {
    if (value.restrictors.length === 0) issue("restrictor_found requires at least one restrictor", ["restrictors"]);
    if (value.restrictors.some((candidate) => candidate.result !== "restrictor")) issue("every recorded restrictor must have result=restrictor", ["restrictors"]);
    if (value.confirmationMethod !== "fork_confirmed") issue("restrictor_found requires fork confirmation", ["confirmationMethod"]);
    if (value.restrictionState !== "restrictable" && value.restrictionState !== "already_shut") issue("restrictor_found requires a restrictive state", ["restrictionState"]);
  }
});
export type ExitRestriction = z.infer<typeof exitRestrictionSchema>;

// --- time to exit (day 4) ---

/**
 * One measured (or explicitly unmeasured) leg of the journey out. Legs
 * compose SEQUENTIALLY in the request → wait → claim shape these mechanisms
 * almost always take, so the model sums measured legs — see timeToExit.ts for
 * that assumption stated in full.
 *
 * `measured: false` is a first-class outcome: a two-step withdrawal whose
 * duration Ripcord cannot read is a leg of UNKNOWN length, which makes the
 * whole time-to-exit "at least X, possibly more." It is never quietly treated
 * as zero, which would flatter the protocol in exactly the direction that
 * matters.
 *
 * `mutableBy` records that the leg's own duration is a privileged SETTING
 * rather than a constant — e.g. a cooldown an owner can raise. A time-to-exit
 * that the same authority can extend is not a property of the protocol, it is
 * a property of that authority's current choice, and the distinction belongs
 * in the report.
 */
export const exitLegKindSchema = z.enum([
  "cooldown",
  "claim_window",
  "two_step",
  "queue",
  "pause",
]);
export type ExitLegKind = z.infer<typeof exitLegKindSchema>;

export const exitLegSchema = z.object({
  kind: exitLegKindSchema,
  /** The exact accessor or selector pair this leg was detected from. */
  name: z.string(),
  seconds: z.string().nullable(),
  measured: z.boolean(),
  confidence: depthConfidenceSchema,
  /** Non-null when the leg's duration is itself settable by a privileged holder — names the setter. */
  mutableBy: z.string().nullable(),
  note: z.string(),
  evidence: z.array(evidenceSchema),
});
export type ExitLeg = z.infer<typeof exitLegSchema>;

/**
 * Liquidity depth is deliberately NOT modelled. Estimating whether a given
 * position could actually be sold requires pool discovery and depth
 * integration across venues — an indexer, which this project explicitly does
 * not have (same reason the major-token list is curated, KNOWN EDGE #5). A
 * fabricated depth number would be the least defensible figure in the report,
 * so the field exists to say so out loud rather than to be silently absent.
 * `modelled` is a literal false: the schema cannot express a made-up number.
 */
export const liquidityDepthSchema = z.object({
  modelled: z.literal(false),
  reason: z.string(),
});
export type LiquidityDepth = z.infer<typeof liquidityDepthSchema>;

/**
 * Whether someone can stop you leaving. This is separate from the exit WINDOW
 * on purpose: a pause guardian does not shorten the notice before a rule
 * change, it removes the exit entirely, which is a time-to-exit fact of
 * unbounded size. `currently_blocked` is read state at the pinned block;
 * `blockable` is a capability finding (an ACCESS_RESTRICTION capability
 * attributed to a holder) and is CAPABILITY, not prediction.
 */
export const exitBlockabilitySchema = z.object({
  status: z.enum(["currently_blocked", "blockable", "not_observed", "undetermined"]),
  by: z.array(address),
  note: z.string(),
  evidence: z.array(evidenceSchema),
});
export type ExitBlockability = z.infer<typeof exitBlockabilitySchema>;

/**
 * How long a holder needs to get out, as a LOWER BOUND with its gaps named.
 *
 *  - `measured`               every detected leg was read; `tight` is true.
 *  - `lower_bound`            at least one detected leg is of unknown length.
 *  - `no_mechanism_detected`  no cooldown/queue/two-step pattern was found AND
 *                             the dispatcher was readable — a positive
 *                             observation at medium confidence, not proof of
 *                             instant exit.
 *  - `blocked`                exit is halted at the pinned block; the time is
 *                             unbounded, not large.
 *  - `undetermined`           the interface could not be read at all.
 *
 * `atLeastSeconds` is always a floor. `tight` says whether Ripcord believes
 * that floor is the whole story; it is the only thing that lets the verdict
 * make a two-sided comparison, and it is deliberately hard to earn.
 */
export const timeToExitSchema = z.object({
  rulesVersion: z.string(),
  status: z.enum(["measured", "lower_bound", "no_mechanism_detected", "blocked", "undetermined"]),
  atLeastSeconds: z.string().nullable(),
  tight: z.boolean(),
  legs: z.array(exitLegSchema),
  /** Legs known to exist but not measurable, and legs never attempted — each named with why. */
  unmeasuredLegs: z.array(z.object({ name: z.string(), reason: z.string() })),
  liquidity: liquidityDepthSchema,
  blockable: exitBlockabilitySchema,
  confidence: depthConfidenceSchema,
  statement: z.string(),
  evidence: z.array(evidenceSchema),
});
export type TimeToExit = z.infer<typeof timeToExitSchema>;

// --- authority indirection (day 5) ---

/**
 * A handle to authority that Ripcord found but deliberately does NOT follow —
 * see src/detect/authorityIndirection.ts for why this exists and what
 * calibration failure produced it.
 *
 * Its only effect on the report is subtractive: a marker prevents the exit
 * window from claiming `immutable_within_checks`. It never establishes a
 * window, never shortens one, and never attributes power to the address it
 * names. `gettersProbed` is present for the same reason `checksPerformed[]` is:
 * without it, an empty `markers` array cannot be told apart from a check that
 * never ran.
 */
export const indirectionMarkerSchema = z.object({
  signature: z.string(),
  selector: hexString,
  /** The address the getter returned. NOT resolved further — that is the point. */
  target: address,
  evidence: evidenceSchema,
});
export type IndirectionMarker = z.infer<typeof indirectionMarkerSchema>;

export const authorityIndirectionSchema = z.object({
  version: z.string(),
  gettersProbed: z.array(z.string()),
  markers: z.array(indirectionMarkerSchema),
});
export type AuthorityIndirection = z.infer<typeof authorityIndirectionSchema>;

// --- the verdict (day 4) ---

/**
 * The headline judgement, composed from the two sides. It is DATA, with every
 * input and its confidence attached, not a prose sentence bolted onto the end
 * of a report.
 *
 * The comparison is `timeToExit >= exitWindow` → trapped, using >= and not >
 * deliberately: if leaving takes exactly as long as the notice you are
 * guaranteed, you finish leaving at the moment the change takes effect, which
 * is not leaving BEFORE it. `marginSeconds` is published so a dead heat is
 * visible as a dead heat rather than disappearing into a category.
 *
 * Every statement is CAPABILITY, not intent: "before the rules CAN change,"
 * never "will."
 *
 *  - `trapped`                     both sides determined, timeToExit >= window.
 *  - `no_notice`                   a zero-notice rule-change route exists, so no
 *                                  exit speed can beat it — the comparison
 *                                  collapses rather than being computed.
 *  - `can_exit_in_time`            both sides determined and tight, timeToExit < window.
 *                                  RETIRED since the enumeration-completeness /
 *                                  capability-surface fixes: not establishable
 *                                  for any contract with both a privileged party
 *                                  and an unevaluated surface, and it occurs
 *                                  nowhere in the calibration set.
 *  - `immutable_within_checks`     POSITIVE evidence of no rule-change route, so
 *                                  there is nothing to compare against. Earned,
 *                                  never reached by falling through — see the
 *                                  day-5 split on `exitWindowAssessmentSchema`.
 *  - `no_direct_restriction_found` (day 7) The fork exit-restriction engine
 *                                  established a baseline exit and evaluated every
 *                                  registered candidate without any of them closing
 *                                  it. DELIBERATELY WEAKER than can_exit_in_time
 *                                  and never a safety guarantee: it is scoped to
 *                                  the N functions actually evaluated and states
 *                                  so, because argument space and indirect/
 *                                  economic restrictions are not exhausted by
 *                                  testing. Unreachable unless the exit action was
 *                                  confidently identified and a baseline
 *                                  established.
 *  - `undetermined`                either side is unresolved; `missing` names exactly what.
 */
export const verdictStatusSchema = z.enum([
  "trapped",
  "no_notice",
  "can_exit_in_time",
  "immutable_within_checks",
  "no_direct_restriction_found",
  "undetermined",
]);
export type VerdictStatus = z.infer<typeof verdictStatusSchema>;

export const verdictInputSchema = z.object({
  name: z.string(),
  value: z.string().nullable(),
  confidence: depthConfidenceSchema,
  source: z.string(),
});
export type VerdictInput = z.infer<typeof verdictInputSchema>;

export const verdictSchema = z.object({
  status: verdictStatusSchema,
  statement: z.string(),
  exitWindowSeconds: z.string().nullable(),
  timeToExitSeconds: z.string().nullable(),
  /** window - timeToExit. Negative or zero means you cannot finish leaving first. */
  marginSeconds: z.string().nullable(),
  confidence: depthConfidenceSchema,
  /** What is missing when the verdict degrades — never left to be inferred from a vague status. */
  missing: z.array(z.string()),
  inputs: z.array(verdictInputSchema),
});
export type Verdict = z.infer<typeof verdictSchema>;

// --- top-level report ---

export const reportSchema = z.object({
  schemaVersion: z.string(),
  rulesetVersion: z.string(),
  generatedAt: z.string(),
  chainId: z.number().int().positive(),
  block: z.object({
    number: z.string(),
    hash: hexString,
  }),
  target: z.object({
    address,
    hasCode: z.boolean(),
    bytecodeSize: z.number().int().nonnegative(),
    bytecodeHash: hexString.nullable(),
  }),
  proxy: proxySchema,
  authority: authoritySchema,
  powerHolders: z.array(powerHolderSchema),
  /**
   * Day-3 recursive resolution of each power holder's own authority, up to
   * max depth, with cycle detection and depth-degraded confidence. Optional
   * so a `scan` that doesn't run recursion (or a proof-only invocation) still
   * validates; when present it carries the paths the proof engine drives from.
   */
  authorityResolution: authorityResolutionSchema.nullable(),
  capabilities: capabilitiesResultSchema,
  dependencies: dependencyGraphSchema,
  /** Day-3 proof engine. Null when no proof was attempted for this scan. */
  proof: proofSchema.nullable(),
  /**
   * Day-4 Exit Window: how long between a rule change becoming possible and it
   * taking effect, minus every way that delay can be cut. Nullable so a scan
   * that could not run the stage at all still validates — but a null here means
   * the stage FAILED (see errors[]), never that the window is fine.
   */
  exitWindow: exitWindowSchema.nullable(),
  /**
   * Day-7 fork exit-restriction evaluation. Null when the engine did not run
   * for this scan (plain `scan` mode, or no anvil) — never a statement that no
   * restriction exists. When present it carries the baseline, the differential
   * over every guarded function, and the outcome; a `restrictor_found` here is
   * what turns Comet's `undetermined` into a fork-confirmed `no_notice`.
   */
  exitRestriction: exitRestrictionSchema.nullable(),
  /** Day-4 time-to-exit model: cooldowns, queues, and what is explicitly not modelled. */
  timeToExit: timeToExitSchema.nullable(),
  /** Day-4 composed judgement. Null only when both sides failed to run. */
  verdict: verdictSchema.nullable(),
  /**
   * Day-5 authority-indirection markers. Nullable so a scan whose stage failed
   * still validates — but a null here means the check did NOT run, which is
   * exactly why the exit window refuses `immutable_within_checks` without it.
   */
  authorityIndirection: authorityIndirectionSchema.nullable(),
  /**
   * The aggregate enumeration witness the verdict was computed under. Always
   * present: whether the authority picture was complete is a property of every
   * scan, not an optional extra, and a reader must be able to see it without
   * reconstructing it from the reconstruction blocks scattered below.
   */
  enumeration: enumerationCompletenessSchema,
  disclosure: disclosureSchema,
  unknowns: z.array(unknownEntrySchema),
  errors: z.array(errorEntrySchema),
});
export type Report = z.infer<typeof reportSchema>;
