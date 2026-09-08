/**
 * Fork funding: how a sandbox holder comes to own something to exit with.
 *
 * Impersonating a real large holder and transferring is more robust than
 * guessing an ERC20's `balanceOf` storage slot, and it keeps the baseline
 * deterministic — a fixed whale, a fixed amount, a historical balance that never
 * changes at a pinned block.
 *
 * KEYED BY (chainId, token). The previous table was keyed by bare token address,
 * which is the same defect the live layer already had to fix once: an address is
 * not an identity across chains, and USDC's mainnet address is a perfectly valid
 * — and completely different — contract elsewhere. A funding table that answered
 * for the wrong chain would seed a baseline from a contract nobody checked.
 */
import type { Hex } from "viem";

export const fundingVersion = "0.4.0";

export const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

export interface TokenWhale {
  chainId: number;
  token: Hex;
  /** A known holder with a large balance at the pinned block — verified live before being committed. */
  whale: Hex;
  symbol: string;
  decimals: number;
}

const key = (chainId: number, token: Hex) => `${chainId}:${token.toLowerCase()}`;

/** Curated and verified live on the fork at the pinned block. */
export const TOKEN_WHALES: Record<string, TokenWhale> = {
  // USDC — verified live at block 25800000: 0x3730… held ~4.08e15 (4.08B USDC).
  [key(1, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")]: {
    chainId: 1,
    token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    whale: "0x37305B1cD40574E4C5Ce33f8e8306Be057fD7341",
    symbol: "USDC",
    decimals: 6,
  },
};

export function whaleFor(chainId: number, token: Hex): TokenWhale | null {
  return TOKEN_WHALES[key(chainId, token)] ?? null;
}
