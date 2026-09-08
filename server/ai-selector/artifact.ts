/**
 * THE PRIVATE ARTIFACT — everything one selector-hypothesis run observed.
 *
 * This is the record the disclosure gate reads, and the gate can only be as
 * reliable as what it is given. So the artifact deliberately holds the whole
 * chain of custody: what the model proposed, what Keccak said about it, what the
 * calldata-length probe observed, exactly which vectors were planned and which
 * were dropped, and then per fork run the full branch records — caller,
 * mutation receipt, revert payload, and the position before and after both the
 * mutation and the exit.
 *
 * NONE OF IT IS PUBLIC BY DEFAULT. `disclosure.ts` projects a sanitised subset,
 * and only for a run the gate cleared. The artifact itself lives in a private
 * directory, or in quarantine when the gate says so.
 *
 * It is validated with zod on the way in AND on the way out. A truncated or
 * hand-edited artifact must fail to parse rather than reach the gate: a gate
 * that silently accepts a partial record is a gate that publishes on missing
 * evidence, which is the failure mode this whole layer exists to avoid.
 */
import { z } from "zod";
import type { Evidence } from "../../src/chain/client.js";
import type { AiCalldataArity, AiSelectorCandidate } from "../shared/ai-selector.js";
import type { BranchRecord, CandidateOutcome, ForkAgreement, ForkIdentity, StepClassification } from "./experiment.js";
import type { ExperimentPlan } from "./plan.js";

export const AI_ARTIFACT_VERSION = "ai-selector-artifact/v1";

/** One argument vector as it was actually executed, with every branch it ran. */
export interface AiForkStepRecord {
  selector: string;
  canonicalSignature: string;
  label: string;
  calldata: string;
  branches: BranchRecord[];
  classification: StepClassification;
}

/**
 * One fork run. Structurally a `ForkRunOutcome`, plus the step records — so it
 * can be handed straight to `agreeAcrossForks` while still carrying the raw
 * evidence that outcome was derived from.
 */
export interface AiForkRunRecord {
  forkIdentity: ForkIdentity;
  candidates: CandidateOutcome[];
  steps: AiForkStepRecord[];
}

export interface AiSelectorArtifact {
  version: typeof AI_ARTIFACT_VERSION;
  reportId: string;
  target: string;
  chainId: number;
  block: { number: string; hash: string };
  scannedAddress: string | null;
  scannedCodeHash: string | null;
  requestedAt: string;
  completedAt: string | null;
  /**
   * A POSITIVE claim that every stage finished. False whenever anything was cut
   * short, and an incomplete artifact can never be published — same discipline
   * as the report's enumeration witness.
   */
  complete: boolean;
  model: {
    provider: string;
    name: string;
    promptVersion: string;
    promptHash: string;
    responseId: string | null;
  } | null;
  totalUnmatchedSelectors: number;
  submittedSelectors: string[];
  candidates: AiSelectorCandidate[];
  /** Observed calldata-length boundaries, with the probe evidence behind them. */
  arity: { selector: string; arity: AiCalldataArity; evidence: Evidence[] }[];
  plan: ExperimentPlan;
  /** Raw per-fork results. The gate reads THESE, not the agreed view. */
  runs: AiForkRunRecord[];
  reproduction: ForkAgreement | null;
  /** Everything that was not established, named. Never empty by omission. */
  gaps: string[];
}

// --- schema ------------------------------------------------------------------
// Kept structural rather than exhaustive on the leaf enums: the enums live in
// TypeScript and are checked at compile time, while what zod is here to catch is
// a truncated or corrupted document reaching the gate.

const hexish = z.string();
const evidenceSchema = z.object({
  kind: z.string(),
  params: z.record(z.unknown()),
  rawValue: z.unknown(),
  block: z.string(),
});

const positionSchema = z.object({
  tokens: z.string(),
  supplied: z.string(),
  borrowed: z.string(),
  principal: z.string(),
});

const exitObservationSchema = z.object({
  outcome: z.string(),
  receiptStatus: z.enum(["success", "reverted"]),
  revertData: z.string().nullable(),
  block: z.string(),
  timestamp: z.string(),
  exitTo: hexish,
  exitCalldata: hexish,
  positionBefore: positionSchema,
  positionAfter: positionSchema,
});

const branchRecordSchema = z.object({
  branch: z.enum(["control", "unattributed", "controller"]),
  caller: z.string(),
  mutation: z.enum(["not_applicable", "succeeded", "reverted"]),
  mutationRevertData: z.string().nullable().optional(),
  positionAfterMutation: positionSchema.nullable(),
  exit: exitObservationSchema.nullable(),
});

const classificationSchema = z.object({
  status: z.string(),
  note: z.string(),
  gaps: z.array(z.string()),
  evaluations: z.array(z.object({ branch: z.string(), status: z.string(), note: z.string() })),
});

const candidateOutcomeSchema = z.object({
  selector: hexish,
  canonicalSignature: z.string(),
  status: z.string(),
  note: z.string(),
  gaps: z.array(z.string()),
  confirmedBy: z.array(z.object({ label: z.string(), calldata: hexish })),
  stepsRun: z.number().int().nonnegative(),
});

const forkIdentitySchema = z.object({
  runId: z.string().min(1),
  chainId: z.number().int(),
  blockNumber: z.string(),
  blockHash: z.string(),
  targetCodeHash: z.string(),
  planHash: z.string(),
});

const stepRecordSchema = z.object({
  selector: hexish,
  canonicalSignature: z.string(),
  label: z.string(),
  calldata: hexish,
  branches: z.array(branchRecordSchema),
  classification: classificationSchema,
});

const runRecordSchema = z.object({
  forkIdentity: forkIdentitySchema,
  candidates: z.array(candidateOutcomeSchema),
  steps: z.array(stepRecordSchema),
});

const arityObservationSchema = z.object({
  status: z.string(),
  minimumWords: z.number().int().nullable(),
  observations: z.array(z.object({ words: z.number().int(), outcome: z.string() })),
  note: z.string(),
});

const candidateSchema = z.object({
  selector: hexish,
  proposedSignature: z.string(),
  canonicalSignature: z.string().nullable(),
  capabilityHint: z.string(),
  rationale: z.string(),
  validationStatus: z.string(),
  computedSelector: z.string().nullable(),
  inputTypes: z.array(z.string()),
  booleanArgumentsEnumerable: z.boolean(),
  arityCompatibility: z.string(),
  behaviorStatus: z.string(),
  behaviorNote: z.string(),
});

const planSchema = z.object({
  version: z.string(),
  plans: z.array(z.object({
    selector: hexish,
    canonicalSignature: z.string(),
    inputTypes: z.array(z.string()),
    priority: z.number(),
    exhaustive: z.boolean(),
    steps: z.array(z.object({ label: z.string(), calldata: hexish })),
    note: z.string(),
  })),
  skipped: z.array(z.object({ selector: hexish, canonicalSignature: z.string().nullable(), reason: z.string() })),
  totalSteps: z.number().int().nonnegative(),
  budgetExhausted: z.boolean(),
  planHash: z.string(),
});

export const aiSelectorArtifactSchema = z.object({
  version: z.literal(AI_ARTIFACT_VERSION),
  reportId: z.string().min(1),
  target: hexish,
  chainId: z.number().int(),
  block: z.object({ number: z.string(), hash: z.string() }),
  scannedAddress: z.string().nullable(),
  scannedCodeHash: z.string().nullable(),
  requestedAt: z.string(),
  completedAt: z.string().nullable(),
  complete: z.boolean(),
  model: z.object({
    provider: z.string(),
    name: z.string(),
    promptVersion: z.string(),
    promptHash: z.string(),
    responseId: z.string().nullable(),
  }).nullable(),
  totalUnmatchedSelectors: z.number().int().nonnegative(),
  submittedSelectors: z.array(hexish),
  candidates: z.array(candidateSchema),
  arity: z.array(z.object({ selector: hexish, arity: arityObservationSchema, evidence: z.array(evidenceSchema) })),
  plan: planSchema,
  runs: z.array(runRecordSchema),
  reproduction: z.object({
    independent: z.boolean(),
    gaps: z.array(z.string()),
    candidates: z.array(candidateOutcomeSchema),
  }).nullable(),
  gaps: z.array(z.string()),
});

export function parseArtifact(value: unknown): AiSelectorArtifact | null {
  const parsed = aiSelectorArtifactSchema.safeParse(value);
  return parsed.success ? (parsed.data as AiSelectorArtifact) : null;
}
