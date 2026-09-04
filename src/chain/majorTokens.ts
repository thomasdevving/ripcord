/**
 * A curated, non-exhaustive list of major ERC20 tokens checked for target
 * holdings by the dependency graph. A deliberate limitation, not an oversight:
 * Ripcord runs no indexer or balance-discovery service, so it can only report
 * balances in tokens it already knows to look for, and a large position in a
 * token NOT on this list produces no dependency finding.
 *
 * Every address was independently verified live against mainnet at block
 * 25800000 — symbol()/decimals() both read and checked — before being committed.
 */
import type { Hex } from "viem";

export interface MajorToken {
  symbol: string;
  address: Hex;
}

export const MAJOR_TOKENS: Record<number, MajorToken[]> = {
  1: [
    { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
    { symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7" },
    { symbol: "DAI", address: "0x6B175474E89094C44Da98b954EedeAC495271d0F" },
    { symbol: "WETH", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" },
    { symbol: "WBTC", address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599" },
    { symbol: "stETH", address: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84" },
  ],
};
