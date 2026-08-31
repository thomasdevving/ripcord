/**
 * The Ripcord report schema. Every finding carries evidence pointing at the
 * exact read that produced it — a finding without evidence is a rumour, not
 * a finding. `unknowns` and `errors` are always present, always populated
 * honestly: an empty array there is a claim that nothing went wrong, so
 * nothing gets suppressed to make an array empty.
 */
import { z } from "zod";

export const schemaVersion = "0.3.0";
export const rulesetVersion = "0.3.0";

const hexString = z.string().regex(/^0x[0-9a-fA-F]*$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

export const evidenceSchema = z.object({
  kind: z.enum(["storage_slot", "call", "log", "bytecode"]),
  params: z.record(z.string(), z.unknown()),
  rawValue: z.unknown(),
  block: z.string(),
});
export type Evidence = z.infer<typeof evidenceSchema>;

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

export const accessControlSchema = z.object({
  detected: z.boolean(),
  method: z.enum(["enumerable", "event_reconstruction", "not_applicable"]),
  roles: z.array(roleEntrySchema),
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

export const matchConfidenceSchema = z.enum(["high", "low"]);
export type MatchConfidence = z.infer<typeof matchConfidenceSchema>;

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
  matchConfidence: matchConfidenceSchema,
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
  capabilities: capabilitiesResultSchema,
  dependencies: dependencyGraphSchema,
  unknowns: z.array(unknownEntrySchema),
  errors: z.array(errorEntrySchema),
});
export type Report = z.infer<typeof reportSchema>;
