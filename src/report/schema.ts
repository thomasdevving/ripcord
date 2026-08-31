/**
 * The Ripcord report schema. Every finding carries evidence pointing at the
 * exact read that produced it — a finding without evidence is a rumour, not
 * a finding. `unknowns` and `errors` are always present, always populated
 * honestly: an empty array there is a claim that nothing went wrong, so
 * nothing gets suppressed to make an array empty.
 */
import { z } from "zod";

export const schemaVersion = "0.1.0";
export const rulesetVersion = "0.1.0";

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
  unknowns: z.array(unknownEntrySchema),
  errors: z.array(errorEntrySchema),
});
export type Report = z.infer<typeof reportSchema>;
