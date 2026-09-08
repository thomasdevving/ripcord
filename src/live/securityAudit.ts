/**
 * Differential comparison between Ripcord's pinned selector surface and
 * Mobula's LIVE token-security flags.
 *
 * This module is deliberately in `src/live`: Mobula's answer can change, is
 * assembled from opaque external sources, and is not evidence for a Ripcord
 * verdict. A disagreement is a regression LEAD to inspect, never a finding to
 * import. `verify:boundary` prevents the pinned path from reaching this file.
 */
import type { CapabilitiesResult, Report } from "../report/schema.js";
import {
  fetchTokenSecurity,
  type MobulaTokenSecurity,
} from "./mobula.js";

export const mobulaSecurityAuditVersion = "0.1.0";

export type ComparableSecurityFlag = "minting" | "transfer_pause" | "blacklist" | "whitelist";
export type RipcordSurfaceSignal = "observed" | "not_observed" | "dispatcher_unreadable";
export type ComparisonOutcome =
  | "both_observed"
  | "both_not_observed"
  | "mobula_only"
  | "ripcord_only"
  | "not_comparable";

export interface SecurityComparison {
  flag: ComparableSecurityFlag;
  mobulaField: "isMintable" | "transferPausable" | "isBlacklisted" | "isWhitelisted";
  mobulaValue: boolean | null;
  ripcordSignal: RipcordSurfaceSignal;
  ripcordSignatures: string[];
  outcome: ComparisonOutcome;
  /** The two tools do not assert identical semantics; this caveat is data. */
  note: string;
}

export interface MobulaSecurityAudit {
  mobulaSecurityAuditVersion: string;
  fetchedAt: string;
  target: string;
  chainId: number;
  report: {
    schemaVersion: string;
    rulesetVersion: string;
    blockNumber: string;
    blockHash: string;
    dispatcherRecognized: boolean;
  };
  status: "ok" | "unavailable";
  reason: string | null;
  staticAnalysis: { status: string | null; date: string | null } | null;
  comparisons: SecurityComparison[];
  /** Mobula signals for which Ripcord currently has no honest like-for-like claim. */
  otherMobulaSignals: {
    balanceMutable: boolean | null;
    modifiableTax: boolean | null;
    selfDestruct: boolean | null;
    honeypot: boolean | null;
  } | null;
  summary: {
    comparable: number;
    agreements: number;
    disagreements: number;
    notComparable: number;
  };
}

interface ComparableDefinition {
  flag: ComparableSecurityFlag;
  mobulaField: SecurityComparison["mobulaField"];
  signatures: readonly string[];
  note: string;
}

const DEFINITIONS: readonly ComparableDefinition[] = [
  {
    flag: "minting",
    mobulaField: "isMintable",
    signatures: ["mint(address,uint256)", "mint(uint256,address)", "mint(uint256)", "mint(address,uint256,bytes)"],
    note:
      "Ripcord records known mint dispatcher signatures; Mobula may detect hidden or obfuscated minting from verified source and other providers.",
  },
  {
    flag: "transfer_pause",
    mobulaField: "transferPausable",
    signatures: ["pause()", "unpause()"],
    note:
      "Ripcord records known pause dispatcher signatures; Mobula's flag describes a broader ability to pause or block token transfers.",
  },
  {
    flag: "blacklist",
    mobulaField: "isBlacklisted",
    signatures: ["blacklist(address)", "unBlacklist(address)", "addToBlacklist(address)", "removeFromBlacklist(address)"],
    note:
      "Ripcord records known blacklist dispatcher signatures; Mobula may infer a blacklist from source patterns not represented in Ripcord's taxonomy.",
  },
  {
    flag: "whitelist",
    mobulaField: "isWhitelisted",
    signatures: ["setWhitelist(address,bool)"],
    note:
      "Ripcord records its known whitelist setter signature; Mobula may classify other whitelist implementations.",
  },
] as const;

function nullableBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function ripcordSignatures(capabilities: CapabilitiesResult): Set<string> {
  return new Set([
    ...capabilities.findings.map((finding) => finding.signature),
    ...capabilities.needsManualVerification.map((entry) => entry.signature),
  ]);
}

function outcome(mobula: boolean | null, ripcord: RipcordSurfaceSignal): ComparisonOutcome {
  if (mobula === null || ripcord === "dispatcher_unreadable") return "not_comparable";
  if (mobula && ripcord === "observed") return "both_observed";
  if (!mobula && ripcord === "not_observed") return "both_not_observed";
  return mobula ? "mobula_only" : "ripcord_only";
}

/** Pure comparison: network-free and suitable for regression tests. */
export function compareMobulaSecurity(
  capabilities: CapabilitiesResult,
  mobula: MobulaTokenSecurity,
): SecurityComparison[] {
  const observed = ripcordSignatures(capabilities);
  return DEFINITIONS.map((definition) => {
    const matches = definition.signatures.filter((signature) => observed.has(signature));
    const ripcordSignal: RipcordSurfaceSignal = !capabilities.dispatcherRecognized
      ? "dispatcher_unreadable"
      : matches.length > 0
        ? "observed"
        : "not_observed";
    const mobulaValue = nullableBoolean(mobula[definition.mobulaField]);
    return {
      flag: definition.flag,
      mobulaField: definition.mobulaField,
      mobulaValue,
      ripcordSignal,
      ripcordSignatures: matches,
      outcome: outcome(mobulaValue, ripcordSignal),
      note: definition.note,
    };
  });
}

function emptySummary(): MobulaSecurityAudit["summary"] {
  return { comparable: 0, agreements: 0, disagreements: 0, notComparable: DEFINITIONS.length };
}

function unavailable(
  report: Pick<Report, "schemaVersion" | "rulesetVersion" | "chainId" | "block" | "target" | "capabilities">,
  fetchedAt: string,
  reason: string,
): MobulaSecurityAudit {
  return {
    mobulaSecurityAuditVersion,
    fetchedAt,
    target: report.target.address,
    chainId: report.chainId,
    report: {
      schemaVersion: report.schemaVersion,
      rulesetVersion: report.rulesetVersion,
      blockNumber: report.block.number,
      blockHash: report.block.hash,
      dispatcherRecognized: report.capabilities.dispatcherRecognized,
    },
    status: "unavailable",
    reason,
    staticAnalysis: null,
    comparisons: [],
    otherMobulaSignals: null,
    summary: emptySummary(),
  };
}

/** One live vendor request followed by a pure, explicitly non-verdict comparison. */
export async function buildMobulaSecurityAudit(
  report: Pick<Report, "schemaVersion" | "rulesetVersion" | "chainId" | "block" | "target" | "capabilities">,
  opts: { signal?: AbortSignal } = {},
): Promise<MobulaSecurityAudit> {
  const fetchedAt = new Date().toISOString();
  const chainRef = `evm:${report.chainId}`;
  const response = await fetchTokenSecurity(report.target.address, chainRef, opts);
  if (!response.ok) return unavailable(report, fetchedAt, response.reason);
  const data = response.data.data;
  if (!data) return unavailable(report, fetchedAt, "token security: response contained no data object");
  if (!data.address || data.address.toLowerCase() !== report.target.address.toLowerCase()) {
    return unavailable(report, fetchedAt, "token security: response identity did not match the report target");
  }
  if (!data.chainId || data.chainId.toLowerCase() !== chainRef) {
    return unavailable(report, fetchedAt, "token security: response chain did not match the report chain");
  }

  const comparisons = compareMobulaSecurity(report.capabilities, data);
  const agreements = comparisons.filter((comparison) =>
    comparison.outcome === "both_observed" || comparison.outcome === "both_not_observed").length;
  const disagreements = comparisons.filter((comparison) =>
    comparison.outcome === "mobula_only" || comparison.outcome === "ripcord_only").length;
  const notComparable = comparisons.filter((comparison) => comparison.outcome === "not_comparable").length;

  return {
    mobulaSecurityAuditVersion,
    fetchedAt,
    target: report.target.address,
    chainId: report.chainId,
    report: {
      schemaVersion: report.schemaVersion,
      rulesetVersion: report.rulesetVersion,
      blockNumber: report.block.number,
      blockHash: report.block.hash,
      dispatcherRecognized: report.capabilities.dispatcherRecognized,
    },
    status: "ok",
    reason: null,
    staticAnalysis: {
      status: data.staticAnalysisStatus ?? null,
      date: data.staticAnalysisDate ?? null,
    },
    comparisons,
    otherMobulaSignals: {
      balanceMutable: nullableBoolean(data.balanceMutable),
      modifiableTax: nullableBoolean(data.modifyableTax),
      selfDestruct: nullableBoolean(data.selfDestruct),
      honeypot: nullableBoolean(data.isHoneypot),
    },
    summary: {
      comparable: comparisons.length - notComparable,
      agreements,
      disagreements,
      notComparable,
    },
  };
}
