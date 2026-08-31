/**
 * Classifies an address that turned out to hold power: EOA (no code), Gnosis
 * Safe (code + Safe-shaped getters respond), or other contract (has code,
 * deeper classification deferred to a later day). Never claims a deeper
 * classification than the evidence supports — "other contract" is a
 * deliberate stopping point, not a placeholder for "unknown."
 */
import { decodeFunctionResult, encodeFunctionData, type Hex } from "viem";
import type { Evidence, ChainReader } from "../chain/client.js";
import { safeAbi } from "../chain/abi.js";
import type { AccountType, PowerHolder, RoleEntry, SafeInfo } from "../report/schema.js";

export async function classifyAccount(
  chain: ChainReader,
  address: Hex,
  viaCapabilities: string[],
): Promise<PowerHolder> {
  const evidence: Evidence[] = [];
  const { code, evidence: codeEvidence } = await chain.getCode(address);
  evidence.push(codeEvidence);

  if (!code) {
    return { address, type: "eoa", safe: null, viaCapabilities, evidence };
  }

  const safeInfo = await tryReadSafe(chain, address, evidence);
  if (safeInfo) {
    return { address, type: "safe", safe: safeInfo, viaCapabilities, evidence };
  }

  const type: AccountType = "contract";
  return { address, type, safe: null, viaCapabilities, evidence };
}

/**
 * A Gnosis Safe is identified by getOwners() and getThreshold() both
 * resolving — these two together are specific enough (few non-Safe
 * contracts implement both with this exact shape) for a day-1 heuristic.
 * VERSION() is read best-effort; its absence doesn't disqualify a match.
 */
async function tryReadSafe(chain: ChainReader, address: Hex, evidence: Evidence[]): Promise<SafeInfo | null> {
  const ownersCall = encodeFunctionData({ abi: safeAbi, functionName: "getOwners" });
  const thresholdCall = encodeFunctionData({ abi: safeAbi, functionName: "getThreshold" });

  const [ownersRes, thresholdRes] = await Promise.all([
    chain.call(address, ownersCall),
    chain.call(address, thresholdCall),
  ]);
  evidence.push(ownersRes.evidence, thresholdRes.evidence);

  if (ownersRes.reverted || !ownersRes.result || thresholdRes.reverted || !thresholdRes.result) {
    return null;
  }

  let owners: readonly Hex[];
  let threshold: bigint;
  try {
    owners = decodeFunctionResult({ abi: safeAbi, functionName: "getOwners", data: ownersRes.result }) as readonly Hex[];
    threshold = decodeFunctionResult({ abi: safeAbi, functionName: "getThreshold", data: thresholdRes.result }) as bigint;
  } catch {
    return null;
  }

  const versionCall = encodeFunctionData({ abi: safeAbi, functionName: "VERSION" });
  const versionRes = await chain.call(address, versionCall);
  evidence.push(versionRes.evidence);
  let version: string | null = null;
  if (!versionRes.reverted && versionRes.result) {
    try {
      version = decodeFunctionResult({ abi: safeAbi, functionName: "VERSION", data: versionRes.result }) as string;
    } catch {
      version = null;
    }
  }

  return { threshold: Number(threshold), owners: [...owners], version };
}

export interface PowerHolderSources {
  owner?: Hex | null;
  pendingOwner?: Hex | null;
  proxyAdmin?: Hex | null;
  accessControlRoles?: RoleEntry[];
  /** Addresses attributed as guarding a capability (day 2), labeled per capability signature. */
  capabilityHolders?: { address: string; label: string }[];
}

/**
 * Dedupes every address found holding some form of power across owner/
 * pendingOwner/proxyAdmin/AccessControl roles/attributed capability guards,
 * classifies each (eoa/safe/contract), and records which capability(ies)
 * route through it. Shared between the top-level report (build.ts) and the
 * one-level-deep dependency graph (dependencies.ts) so both apply identical
 * classification logic.
 */
export async function collectPowerHolders(chain: ChainReader, sources: PowerHolderSources): Promise<PowerHolder[]> {
  // Addresses reach this function in two different casings and comparing
  // them raw would be a real bug: viem's decodeFunctionResult returns
  // EIP-55 checksummed addresses (owner, pendingOwner, role members), while
  // slotToAddress slices raw storage words and returns lowercase (proxy
  // admin, implementation). A proxy whose admin IS its owner would
  // otherwise produce two separate power-holder entries for one address,
  // each carrying only half its viaCapabilities. Everything is therefore
  // keyed on the lowercase form, while the first-seen casing is kept for
  // display so the report still shows checksummed addresses where we have
  // them.
  const key = (a: string) => a.toLowerCase();
  const eq = (a: string | null | undefined, b: string) => Boolean(a) && key(a!) === b;

  const display = new Map<string, string>();
  const remember = (a: string | null | undefined) => {
    if (a && !display.has(key(a))) display.set(key(a), a);
  };
  remember(sources.owner);
  remember(sources.pendingOwner);
  remember(sources.proxyAdmin);
  for (const role of sources.accessControlRoles ?? []) role.members.forEach(remember);
  for (const { address } of sources.capabilityHolders ?? []) remember(address);

  const holders: PowerHolder[] = [];
  for (const [lower, shown] of display) {
    const viaCapabilities: string[] = [];
    if (eq(sources.owner, lower)) viaCapabilities.push("owner");
    if (eq(sources.pendingOwner, lower)) viaCapabilities.push("pendingOwner");
    if (eq(sources.proxyAdmin, lower)) viaCapabilities.push("proxyAdmin");
    for (const role of sources.accessControlRoles ?? []) {
      if (role.members.some((m) => key(m) === lower)) {
        viaCapabilities.push(`accessControl:${role.name ?? role.role}`);
      }
    }
    for (const cap of sources.capabilityHolders ?? []) {
      if (key(cap.address) === lower) viaCapabilities.push(`capability:${cap.label}`);
    }
    holders.push(await classifyAccount(chain, shown as Hex, viaCapabilities));
  }
  return holders;
}
