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
 * Two different addresses are in play here and conflating them is a real
 * correctness bug, so they are named and recorded separately:
 *
 *   scannedAddress — where the BYTECODE comes from. For a proxy this is the
 *     implementation, since the proxy's own bytecode is a delegatecall stub.
 *   probedAddress — where the guard-probe eth_call is SENT. Always the
 *     target/proxy, never the implementation: a delegatecall through the proxy
 *     runs the implementation's code against the PROXY's storage, where
 *     owner/role state lives, while calling the implementation directly runs it
 *     against the implementation's usually uninitialized storage. Verified live
 *     on PAID Network, where the proxy's owner() is 0x53bc21D3… and the
 *     implementation's is address(0), yet both revert "Ownable: caller is not
 *     the owner" — so probing the implementation and attributing that revert to
 *     the proxy's owner is an attribution the evidence does not support.
 *
 * This mirrors the invariant that authority state is always read from the proxy.
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
    probedAddress: target,
    selectorsExtracted: 0,
    unmatchedSelectors: [],
    findings: [],
    needsManualVerification: [],
    evidence,
  });

  // `pattern: "unknown"` is NOT a confirmed proxy whose implementation merely
  // failed to resolve. It means the DELEGATECALL scan found the opcode somewhere
  // in the bytecode with no recognized storage-slot pattern behind it, and the
  // most common real cause is a factory embedding a CHILD contract's creation
  // bytecode (Aave's PoolAddressesProvider deploying a proxy via `new`), not the
  // target being an unresolved proxy. Treating it like a confirmed-but-unresolved
  // proxy would silently skip capability detection on the target's OWN scannable
  // bytecode, so "unknown" falls back to scanning the target directly with the
  // ambiguity recorded rather than hidden.
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

  const unmatchedSelectors: Hex[] = [];

  for (const selector of dispatcherResult.selectors) {
    const entry = lookupTaxonomy(selector);
    if (!entry) {
      // Not in the taxonomy table — recorded, not silently dropped. "Unmatched"
      // means "Ripcord has no entry for this selector," never "not privileged."
      unmatchedSelectors.push(selector);
      continue;
    }

    // Probe the TARGET, not scannedAddress — see the header comment.
    const probe = await probeGuard(chain, target, entry.signature, guardContext);

    // Two probe outcomes are not capability FINDINGS, for opposite reasons:
    //   no_auth_revert_observed    — nothing recognisable came back. Could be a
    //                                custom guard, could be no guard. Blocks
    //                                publication, because the second reading is
    //                                a vulnerability claim we cannot rule out.
    //   reverted_before_auth_check — the contract demonstrably rejected the probe
    //                                on a state/argument precondition, so no auth
    //                                check ran. A fact about OUR probe, which
    //                                supports no vulnerability reading at all.
    if (probe.status === "no_auth_revert_observed" || probe.status === "reverted_before_auth_check") {
      needsManualVerification.push({
        selector,
        signature: entry.signature,
        category: entry.category,
        scannedAddress,
        probedAddress: target,
        reason: probe.status,
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
      nameMatchSpecificity: entry.specificity,
      scannedAddress,
      probedAddress: target,
      guard,
    });
  }

  return {
    result: {
      taxonomyVersion,
      dispatcherRecognized: true,
      scannedAddress,
      probedAddress: target,
      selectorsExtracted: dispatcherResult.selectors.length,
      unmatchedSelectors,
      findings,
      needsManualVerification,
      evidence,
    },
    unknowns,
  };
}
