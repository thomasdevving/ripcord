/**
 * Chainlink price feeds for the curated MAJOR_TOKENS, used ONLY by the proof
 * engine to convert a drained-balance delta into a dollar headline. Each feed
 * address was verified live against the mainnet fork at block 25800000
 * (latestRoundData() answered, decimals() == 8) before being committed — same
 * discipline as majorTokens.ts and the fixtures.
 *
 * Pricing is a READ, and like every other read it can fail. When a feed can't
 * be read the proof reports that delta's `usd` as null with the price source
 * recorded — a loud "price unavailable," never a silent $0 that would make a
 * real drain look harmless. Feeds are keyed by the token they price; a token
 * held but absent from this map simply has no USD figure (its delta is still
 * reported in native units).
 *
 * WETH is priced by ETH/USD and WBTC by BTC/USD — the peg is 1:1 by
 * construction (wrapping), noted in `note` so the approximation is explicit.
 */
import type { Hex } from "viem";

export interface PriceFeed {
  /** The token this feed prices. */
  token: Hex;
  symbol: string;
  /** Chainlink AggregatorV3 feed address. */
  feed: Hex;
  note: string;
}

export const CHAINLINK_FEEDS: Record<number, PriceFeed[]> = {
  1: [
    {
      token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      symbol: "USDC",
      feed: "0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6",
      note: "Chainlink USDC/USD",
    },
    {
      token: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      symbol: "USDT",
      feed: "0x3E7d1eAB13ad0104d2750B8863b489D65364e32D",
      note: "Chainlink USDT/USD",
    },
    {
      token: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
      symbol: "DAI",
      feed: "0xAed0c38402a5d19df6E4c03F4E2DceD6e29c1ee9",
      note: "Chainlink DAI/USD",
    },
    {
      token: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      symbol: "WETH",
      feed: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
      note: "Chainlink ETH/USD (WETH is 1:1 wrapped ETH)",
    },
    {
      token: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
      symbol: "WBTC",
      feed: "0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c",
      note: "Chainlink BTC/USD (WBTC is 1:1 wrapped BTC)",
    },
    {
      token: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84",
      symbol: "stETH",
      feed: "0xCfE54B5cD566aB89272946F602D76Ea879CAb4a8",
      note: "Chainlink stETH/USD",
    },
  ],
};

export function feedForToken(chainId: number, token: Hex): PriceFeed | null {
  const list = CHAINLINK_FEEDS[chainId] ?? [];
  return list.find((f) => f.token.toLowerCase() === token.toLowerCase()) ?? null;
}
