/**
 * Orchestrates capability detection for a single address: resolve the
 * correct bytecode to scan (the implementation, for a proxy), extract its
 * selector set via the reachability-limited dispatcher walk, match against
 * the versioned taxonomy, and probe each match's guard. Weakest-link
 * provenance is enforced structurally by GuardStatus (schema.ts) and by
 * routing "no auth-shaped revert observed" out of `findings` entirely.
 */
import type { Hex } from "viem";
import type { ChainReader, Evidence } from "../chain/client.js";
import { extractDispatcherSelectors } from "./dispatcher.js";
import { lookupTaxonomy, taxonomyVersion } from "./taxonomy.js";
import { probeGuard, type GuardProbeContext } from "./guardProbe.js";
import type {
  CapabilitiesResult,
  CapabilityFinding,
  GuardStatus,
  ManualVerificationEntry,
  ProxyResult,
  RoleEntry,
  UnknownEntry,
} from "../report/schema.js";

export interface CapabilityDetection {
  result: CapabilitiesResult;
  unknowns: UnknownEntry[];
}

/**
 * `target` is passed only to decide the scan address; capability detection
 * always reads bytecode from the resolved address (the implementation for a
 * proxy) and records that address in every finding — never the proxy
 * address — per the day-2 brief's proxy-resolution requirement.
 */
export async function detectCapabilities(
  chain: ChainReader,
  target: Hex,
  proxy: ProxyResult,
  authorityOwner: Hex | null,
  accessControlRoles: RoleEntry[],
): Promise<CapabilityDetection> {
  const unknowns: UnknownEntry[] = [];
  const evidence: Evidence[] = [];

  const empty = (scannedAddress: Hex | null, dispatcherRecognized: boolean): CapabilitiesResult => ({
    taxonomyVersion,
    dispatcherRecognized,
    scannedAddress,
    findings: [],
    needsManualVerification: [],
    evidence,
  });

  // `pattern: "unknown"` is NOT the same situation as a confirmed proxy
  // (beacon, transparent, UUPS, ...) whose implementation just failed to
  // resolve. It means day 1's DELEGATECALL scan found the opcode somewhere
  // in the bytecode but no recognized storage-slot pattern backs it up —
  // per the day-1 known edge, the single most common real cause is a
  // factory embedding a CHILD contract's creation bytecode (e.g. Aave's
  // PoolAddressesProvider deploying a proxy via `new`), not the target
  // itself being an unresolved proxy. Treating "unknown" the same as a
  // confirmed-but-unresolved proxy would silently skip capability detection
  // on the target's OWN real, scannable bytecode — verified against exactly
  // that fixture. So "unknown" falls back to scanning the target directly,
  // with the ambiguity recorded rather than hidden.
  let scannedAddress: Hex = target;
  if (proxy.isProxy && proxy.pattern !== "unknown") {
    if (!proxy.implementation) {
      unknowns.push({
        field: "capabilities",
        reason: `target is a confirmed proxy (pattern=${proxy.pattern}) but its implementation address could not be resolved — capability detection skipped`,
      });
      return { result: empty(null, false), unknowns };
    }
    scannedAddress = proxy.implementation as Hex;
  } else if (proxy.pattern === "unknown") {
    unknowns.push({
      field: "capabilities",
      reason:
        "target's proxy pattern is 'unknown' (a DELEGATECALL was found but no recognized storage pattern) — capability detection scanned the target's OWN bytecode as a best-effort fallback, but if this DELEGATECALL actually belongs to a genuine unrecognized proxy scheme rather than an embedded child contract (see day-1 known edge), the real capabilities may belong to an unidentified implementation instead",
    });
  }

  const { code, evidence: codeEvidence } = await chain.getCode(scannedAddress);
  evidence.push(codeEvidence);
  if (!code) {
    unknowns.push({ field: "capabilities", reason: `no code at scan address ${scannedAddress}` });
    return { result: empty(scannedAddress, false), unknowns };
  }

  const dispatcherResult = extractDispatcherSelectors(code);
  evidence.push({
    kind: "bytecode",
    params: { address: scannedAddress, purpose: "dispatcher_selector_extraction" },
    rawValue: dispatcherResult.recognized
      ? { selectorCount: dispatcherResult.selectors.length, pivotComparisonCount: dispatcherResult.pivotComparisonCount }
      : { recognized: false, reason: dispatcherResult.reason },
    block: chain.blockNumber.toString(),
  });

  if (!dispatcherResult.recognized) {
    unknowns.push({
      field: "capabilities",
      reason: `dispatcher not recognized at ${scannedAddress}: ${dispatcherResult.reason}`,
    });
    return { result: empty(scannedAddress, false), unknowns };
  }

  const findings: CapabilityFinding[] = [];
  const needsManualVerification: ManualVerificationEntry[] = [];
  const guardContext: GuardProbeContext = { authorityOwner, accessControlRoles };

  for (const selector of dispatcherResult.selectors) {
    const entry = lookupTaxonomy(selector);
    if (!entry) continue; // unclassified selector — not a capability finding, see KNOWN EDGES

    const probe = await probeGuard(chain, scannedAddress, entry.signature, guardContext);

    if (probe.status === "no_auth_revert_observed") {
      needsManualVerification.push({
        selector,
        signature: entry.signature,
        category: entry.category,
        scannedAddress,
        reason: "no_auth_revert_observed",
        note: probe.note,
        probes: probe.evidence,
      });
      continue;
    }

    const guard: GuardStatus =
      probe.status === "attributed"
        ? { status: "attributed", holders: probe.holders, authSource: probe.authSource, role: probe.role, evidence: probe.evidence }
        : { status: probe.status, note: probe.note, evidence: probe.evidence };

    findings.push({
      selector,
      signature: entry.signature,
      category: entry.category,
      matchConfidence: entry.confidence,
      scannedAddress,
      guard,
    });
  }

  return {
    result: { taxonomyVersion, dispatcherRecognized: true, scannedAddress, findings, needsManualVerification, evidence },
    unknowns,
  };
}
