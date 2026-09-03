import { encodeFunctionData, type Hex } from "viem";
import type { Evidence } from "../chain/client.js";
import type { ForkHandle } from "./anvil.js";
import { cometAbi } from "./exitActions.js";

export interface WithdrawalPosition {
  tokens: bigint;
  supplied: bigint;
  borrowed: bigint;
  principal: bigint;
  block: bigint;
  timestamp: bigint;
}

/** Every balance is observed at the same local block, with executable read parameters. */
export async function readWithdrawalPosition(
  fork: ForkHandle, target: Hex, token: Hex, holder: Hex, phase: string,
  forkBlock: bigint, evidence: Evidence[],
): Promise<WithdrawalPosition> {
  const head = await fork.client.getBlock();
  const read = async (address: Hex, functionName: "balanceOf" | "borrowBalanceOf" | "userBasic") => {
    const data = encodeFunctionData({ abi: cometAbi, functionName, args: [holder] });
    const value = await fork.client.readContract({ address, abi: cometAbi, functionName, args: [holder], blockNumber: head.number });
    evidence.push({ kind: "call", block: forkBlock.toString(),
      params: { method: "eth_call", address, data, phase, localBlock: head.number.toString(), localTimestamp: head.timestamp.toString(), forkOnly: true },
      rawValue: Array.isArray(value) ? value.map(String) : String(value),
    });
    return value;
  };
  const tokens = await read(token, "balanceOf") as bigint;
  const supplied = await read(target, "balanceOf") as bigint;
  const borrowed = await read(target, "borrowBalanceOf") as bigint;
  const [principal] = await read(target, "userBasic") as readonly [bigint, bigint, bigint, number, number];
  return { tokens, supplied, borrowed, principal, block: head.number, timestamp: head.timestamp };
}

/** Receipt success alone cannot establish an exit. Require recovered assets, zero supply and no new debt. */
export function fullWithdrawalVerified(before: WithdrawalPosition, after: WithdrawalPosition): boolean {
  return before.supplied > 0n && before.principal > 0n && before.borrowed === 0n &&
    after.tokens - before.tokens >= before.supplied && after.principal === 0n &&
    after.supplied === 0n && after.borrowed === 0n;
}

export function samePosition(a: WithdrawalPosition, b: WithdrawalPosition): boolean {
  return a.tokens === b.tokens && a.principal === b.principal && a.supplied === b.supplied && a.borrowed === b.borrowed;
}
