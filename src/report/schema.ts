/**
 * The Ripcord report schema. Every finding carries evidence pointing at the
 * exact read that produced it — a finding without evidence is a rumour, not
 * a finding. `unknowns` and `errors` are always present, always populated
 * honestly: an empty array there is a claim that nothing went wrong, so
 * nothing gets suppressed to make an array empty.
 */
import { z } from "zod";

export const schemaVersion = "0.6.0";
export const rulesetVersion = "0.5.0";

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
 * A privileged-taxonomy capability where probing found no auth-shaped
 * revert from any of (at least) three unrelated probe addresses. This is
 * NEVER a normal finding and NEVER a claim that the function is unguarded —
 * that cannot be proven by probing, and it is a vulnerability claim rather
 * than a capability finding. It is an observation routed to manual review.
 */
export const manualVerificationEntrySchema = z.object({
  selector: hexString,
  signature: z.string(),
  category: capabilityCategorySchema,
  scannedAddress: address,
  /** The address the probes actually called — the target/proxy. See CapabilityFinding.probedAddress. */
  probedAddress: address,
  reason: z.literal("no_auth_revert_observed"),
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
  disclosure: disclosureSchema,
  unknowns: z.array(unknownEntrySchema),
  errors: z.array(errorEntrySchema),
});
export type Report = z.infer<typeof reportSchema>;
