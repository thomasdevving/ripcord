/**
 * Ownable-style ownership detection. Calling `owner()` / `pendingOwner()` on
 * a contract that does not implement them is a normal, expected outcome (a
 * revert) — not an error. We only escalate to `errors[]` in the report if
 * the underlying RPC call itself fails (network/node problem), which the
 * chain client already distinguishes from a contract-level revert.
 */
import { decodeFunctionResult, encodeFunctionData, zeroAddress, type Hex } from "viem";
import type { ChainReader } from "../chain/client.js";
import { ownableAbi } from "../chain/abi.js";
import type { OwnerField } from "../report/schema.js";

async function readAddressGetter(
  chain: ChainReader,
  target: Hex,
  functionName: "owner" | "pendingOwner",
): Promise<OwnerField> {
  const data = encodeFunctionData({ abi: ownableAbi, functionName });
  const { result, reverted, evidence } = await chain.call(target, data);
  if (reverted || !result) {
    return {
      address: null,
      source: `${functionName}() reverted or returned no data — contract likely does not implement it`,
      evidence: [evidence],
    };
  }
  let addr: Hex;
  try {
    addr = decodeFunctionResult({ abi: ownableAbi, functionName, data: result }) as Hex;
  } catch {
    return {
      address: null,
      source: `${functionName}() returned data that does not decode as address`,
      evidence: [evidence],
    };
  }
  return {
    address: addr.toLowerCase() === zeroAddress ? null : addr,
    source: `${functionName}()`,
    evidence: [evidence],
  };
}

export async function detectOwnership(
  chain: ChainReader,
  target: Hex,
): Promise<{ owner: OwnerField; pendingOwner: OwnerField }> {
  const [owner, pendingOwner] = await Promise.all([
    readAddressGetter(chain, target, "owner"),
    readAddressGetter(chain, target, "pendingOwner"),
  ]);
  return { owner, pendingOwner };
}
