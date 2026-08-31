/**
 * Finds the block a contract's code first appeared at, via binary search
 * over getCode. This is the standard trustless way to find a deployment
 * block without an indexer (which the brief explicitly says not to build).
 * Every getCode call in the search is disk-cached, and a contract's
 * deployment block never changes, so repeated runs make zero new calls.
 */
import type { Hex } from "viem";
import type { ChainReader } from "../chain/client.js";

export interface DeploymentSearchResult {
  /** null if the target has no code at the pinned block, or genuinely could not be bounded. */
  deploymentBlock: bigint | null;
  callsMade: number;
}

export async function findDeploymentBlock(
  chain: ChainReader,
  address: Hex,
): Promise<DeploymentSearchResult> {
  let calls = 0;
  const atPinned = await chain.getCodeAtBlock(address, chain.blockNumber);
  calls++;
  if (!atPinned.code) {
    return { deploymentBlock: null, callsMade: calls };
  }

  let lo = 0n;
  let hi = chain.blockNumber;
  const atGenesis = await chain.getCodeAtBlock(address, lo);
  calls++;
  if (atGenesis.code) {
    // Present at block 0 — a genesis-allocated contract. Nothing to binary search for.
    return { deploymentBlock: lo, callsMade: calls };
  }

  while (hi - lo > 1n) {
    const mid = lo + (hi - lo) / 2n;
    const atMid = await chain.getCodeAtBlock(address, mid);
    calls++;
    if (atMid.code) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return { deploymentBlock: hi, callsMade: calls };
}
