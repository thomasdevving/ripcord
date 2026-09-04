/**
 * The cleared dependency registry.
 *
 * The disclosure gate makes a report non-publishable if ANY capability — at the
 * target or anywhere in its dependency graph — routes to needsManualVerification.
 * That rule is correct, but without this registry it trips on essentially every
 * protocol on earth, because almost all of them hold USDC, whose
 * blacklist/pause/mint are exactly the powerful probe-resistant capabilities the
 * gate is built to catch.
 *
 * Those are not latent vulnerabilities; they are the documented, audited design
 * of a centrally-issued fiat stablecoin. Circle CAN freeze a USDC balance — the
 * defining public property of the asset, not something Ripcord discovered. So
 * this registry records, per (token, capability), that the capability is
 * DOCUMENTED DESIGN with a justification and a source, and clears it from the
 * gate. The discipline around it matters as much as the data:
 *   - VERSIONED (`clearedRegistryVersion`), and every report records the version
 *     it used — a clearing is auditable and reversible, never a silent allowlist.
 *   - Cleared only on the SPECIFIC token it documents; the same signature on
 *     another token still blocks.
 *   - NEVER clears the target's own capabilities, only dependencies.
 */
import type { Hex } from "viem";

export const clearedRegistryVersion = "0.1.0";

export interface ClearedCapability {
  /** Full function signature, matched exactly (same discipline as the taxonomy). */
  signature: string;
  justification: string;
  source: string;
}

export interface ClearedTokenEntry {
  token: Hex;
  symbol: string;
  capabilities: ClearedCapability[];
}

/**
 * Per-chain cleared entries. Justifications are written to be read by a
 * skeptical auditor: each states WHO holds the power and WHY it is documented
 * design rather than a finding.
 */
export const CLEARED_REGISTRY: Record<number, ClearedTokenEntry[]> = {
  1: [
    {
      token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      symbol: "USDC",
      capabilities: [
        {
          signature: "blacklist(address)",
          justification:
            "Circle FiatToken blacklister role. Circle can freeze any USDC address to meet legal/regulatory obligations — the defining, publicly-documented property of USDC, exercised on-chain many times, not a latent flaw.",
          source: "https://github.com/circlefin/stablecoin-evm (FiatTokenV2_2, Blacklistable)",
        },
        {
          signature: "unBlacklist(address)",
          justification: "Inverse of blacklist(); same Circle blacklister role, same documented compliance design.",
          source: "https://github.com/circlefin/stablecoin-evm (Blacklistable)",
        },
        {
          signature: "pause()",
          justification:
            "Circle FiatToken pauser role. A documented protocol-wide emergency stop held by Circle; publicly known, not a discovered capability.",
          source: "https://github.com/circlefin/stablecoin-evm (Pausable)",
        },
        {
          signature: "unpause()",
          justification: "Inverse of pause(); same Circle pauser role.",
          source: "https://github.com/circlefin/stablecoin-evm (Pausable)",
        },
        {
          signature: "mint(address,uint256)",
          justification:
            "Circle FiatToken minter role. USDC is a centrally-issued fiat-backed stablecoin; controlled minting by Circle-authorized minters against reserves is its core design, not an unguarded mint.",
          source: "https://github.com/circlefin/stablecoin-evm (FiatTokenV2_2)",
        },
        {
          signature: "rescueERC20(address,address,uint256)",
          justification:
            "Circle FiatToken rescuer role — recovers non-USDC tokens sent to the contract by mistake. Cannot touch USDC balances; documented, narrowly-scoped role.",
          source: "https://github.com/circlefin/stablecoin-evm (Rescuable)",
        },
      ],
    },
    {
      token: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      symbol: "USDT",
      capabilities: [
        {
          signature: "pause()",
          justification:
            "Tether owner emergency pause. TetherToken is an owner-controlled centralized stablecoin by design; the owner's pause is documented and publicly known.",
          source: "https://etherscan.io/address/0xdAC17F958D2ee523a2206206994597C13D831ec7#code (TetherToken)",
        },
        {
          signature: "unpause()",
          justification: "Inverse of pause(); same Tether owner.",
          source: "https://etherscan.io/address/0xdAC17F958D2ee523a2206206994597C13D831ec7#code (TetherToken)",
        },
      ],
    },
    {
      token: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
      symbol: "DAI",
      capabilities: [
        {
          signature: "mint(address,uint256)",
          justification:
            "MakerDAO Dai mint is gated by the `wards` authorization set (rely/deny), controlled by Maker governance. Minting DAI against collateral is the protocol's core, documented mechanism, not an unguarded function.",
          source: "https://github.com/makerdao/dss/blob/master/src/dai.sol",
        },
      ],
    },
    {
      token: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
      symbol: "WBTC",
      capabilities: [
        {
          signature: "mint(address,uint256)",
          justification:
            "WBTC is a custodial wrapped-BTC token; mint/burn are owner-gated (the WBTC controller, a merchant/custodian multisig) against BTC held 1:1. Documented custodial design.",
          source: "https://github.com/WrappedBTC/bitcoin-token-smart-contracts",
        },
        {
          signature: "pause()",
          justification: "WBTC owner (controller) pause. Documented custodial emergency control.",
          source: "https://github.com/WrappedBTC/bitcoin-token-smart-contracts",
        },
        {
          signature: "unpause()",
          justification: "Inverse of pause(); same WBTC controller.",
          source: "https://github.com/WrappedBTC/bitcoin-token-smart-contracts",
        },
      ],
    },
    {
      token: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84",
      symbol: "stETH",
      capabilities: [
        {
          signature: "pause()",
          justification:
            "Lido stETH pause is gated by Lido DAO roles (PAUSE_ROLE). A documented, governance-held emergency control over the staking protocol, not a discovered flaw.",
          source: "https://github.com/lidofinance/lido-dao",
        },
        {
          signature: "unpause()",
          justification: "Resume counterpart, held by Lido DAO RESUME_ROLE.",
          source: "https://github.com/lidofinance/lido-dao",
        },
      ],
    },
  ],
};

/** Returns the cleared entry for a (chain, token, signature) triple, or null if this exact capability on this exact token is not documented-design-cleared. */
export function clearedCapability(chainId: number, token: string, signature: string): ClearedCapability | null {
  const entries = CLEARED_REGISTRY[chainId] ?? [];
  const entry = entries.find((e) => e.token.toLowerCase() === token.toLowerCase());
  if (!entry) return null;
  return entry.capabilities.find((c) => c.signature === signature) ?? null;
}
