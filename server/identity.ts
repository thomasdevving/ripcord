import type { Hex } from "viem";
/** Uncached identity check shared by admission and worker. No credentials or
 * provider text enter this error; callers must fail rather than change the pin. */
export async function verifyBlockIdentity(
  client: { getChainId(): Promise<number>; getBlock(args: { blockNumber: bigint }): Promise<{ hash: string | null; number: bigint | null }> },
  chainId: number,
  blockNumber: bigint,
  expectedHash?: string | null,
): Promise<Hex> {
  if (await client.getChainId() !== chainId) throw new Error("RPC chain identity does not match the selected chain");
  const block = await client.getBlock({ blockNumber });
  if (block.number !== blockNumber || !block.hash || !/^0x[0-9a-f]{64}$/i.test(block.hash)) throw new Error("RPC did not return the requested pinned block identity");
  if (expectedHash && block.hash.toLowerCase() !== expectedHash.toLowerCase()) throw new Error("Pinned block identity changed; discard this run and retry");
  return block.hash as Hex;
}
