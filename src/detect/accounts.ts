/**
 * Classifies an address that turned out to hold power: EOA (no code), Gnosis
 * Safe (code + Safe-shaped getters respond), or other contract (has code,
 * deeper classification deferred to a later day). Never claims a deeper
 * classification than the evidence supports — "other contract" is a
 * deliberate stopping point, not a placeholder for "unknown."
 */
import { decodeFunctionResult, encodeFunctionData, type Hex } from "viem";
import type { Evidence, PinnedChain } from "../chain/client.js";
import { safeAbi } from "../chain/abi.js";
import type { AccountType, PowerHolder, SafeInfo } from "../report/schema.js";

export async function classifyAccount(
  chain: PinnedChain,
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
async function tryReadSafe(chain: PinnedChain, address: Hex, evidence: Evidence[]): Promise<SafeInfo | null> {
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
