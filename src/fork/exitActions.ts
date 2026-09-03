/**
 * Exit-action identification (day 7, Part 1 — the riskiest new false-clean).
 *
 * The exit-restriction engine can only ever be as trustworthy as its answer to
 * one question: how does a holder actually LEAVE this protocol? Test against the
 * wrong exit function and a `no_direct_restriction_found` verdict is a
 * false-clean — you would have proven that closing a door nobody uses does not
 * trap anyone. So identification is deliberately conservative and versioned: a
 * protocol is matched to a known interface only when a FINGERPRINT of
 * characteristic selectors is present, and the positive verdict inherits the
 * confidence of that match (weakest-link). Anything unmatched stays
 * `unconfident`, which keeps the verdict `undetermined` — never the new tier.
 *
 * An interface descriptor is a small, auditable plugin. It names:
 *   - the fingerprint that identifies the interface from the decoded selectors,
 *   - the exit action (the function a holder calls to leave),
 *   - how to BUILD a baseline position on the fork and exercise that exit,
 *   - the restriction candidates to put through the differential, each with the
 *     party that guards it and the single exit-restricting argument to try.
 *
 * This mirrors the proof engine's discipline: ONE archetype done properly
 * (Compound III / Comet-style base withdrawal), with the structure built so
 * adding an interface is data, not a rewrite. Every interface added here must be
 * validated live before it is trusted — see docs/CALIBRATION.md.
 */
import { encodeFunctionData, type Hex } from "viem";

export const exitActionsVersion = "0.2.0";

/** A curated large holder of a base token, used to fund a fork baseline position by impersonation. */
export interface TokenWhale {
  token: Hex;
  /** A known holder with a large balance at the pinned block — verified live before being committed. */
  whale: Hex;
  symbol: string;
  decimals: number;
}

/**
 * Base-token whales, curated and verified live on the fork at the pinned block.
 * Impersonating a real holder and transferring is more robust than guessing an
 * ERC20's `balanceOf` storage slot, and it keeps the baseline deterministic (a
 * fixed whale, a fixed amount, a historical balance that never changes).
 */
export const BASE_TOKEN_WHALES: Record<string, TokenWhale> = {
  // USDC — verified live at block 25800000: 0x3730… held ~4.08e15 (4.08B USDC).
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": {
    token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    whale: "0x37305B1cD40574E4C5Ce33f8e8306Be057fD7341",
    symbol: "USDC",
    decimals: 6,
  },
};

const cometAbi = [
  { type: "function", name: "baseToken", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "pauseGuardian", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "isWithdrawPaused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "supply", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [] },
  {
    type: "function",
    name: "pause",
    stateMutability: "nonpayable",
    inputs: [{ type: "bool" }, { type: "bool" }, { type: "bool" }, { type: "bool" }, { type: "bool" }],
    outputs: [],
  },
] as const;

/** Pinned selectors, each asserted against viem derivation from its signature in tests. */
export const SELECTORS = {
  cometSupply: "0xf2b9fdb8" as Hex, // supply(address,uint256)
  cometWithdraw: "0xf3fef3a3" as Hex, // withdraw(address,uint256)
  cometBaseToken: "0xc55dae63" as Hex, // baseToken()
  cometIsWithdrawPaused: "0x67800b5f" as Hex, // isWithdrawPaused()
  cometPauseGuardian: "0x24a3d622" as Hex, // pauseGuardian()
  cometPause: "0x44c35d07" as Hex, // pause(bool,bool,bool,bool,bool)
} as const;

/** Builds `pause(supply,transfer,withdraw,absorb,buy)` calldata with withdraw-pause = true (the exit-restricting argument). */
export function cometWithdrawPauseCalldata(): Hex {
  return encodeFunctionData({
    abi: cometAbi,
    functionName: "pause",
    args: [false, false, true, false, false],
  });
}

export function cometSupplyCalldata(baseToken: Hex, amount: bigint): Hex {
  return encodeFunctionData({ abi: cometAbi, functionName: "supply", args: [baseToken, amount] });
}

export function cometWithdrawCalldata(baseToken: Hex, amount: bigint): Hex {
  return encodeFunctionData({ abi: cometAbi, functionName: "withdraw", args: [baseToken, amount] });
}

export { cometAbi };

/**
 * The identifiable exit interfaces. Each descriptor is matched by requiring
 * EVERY selector in `fingerprint` to be present in the target's decoded selector
 * set — a partial match is not a match.
 */
export interface ExitInterface {
  id: string;
  /** Human label for the report. */
  label: string;
  /** Characteristic selectors that must ALL be present to claim this interface. */
  fingerprint: Hex[];
  /** The function a holder calls to leave. */
  exitSignature: string;
  exitSelector: Hex;
  /** Confidence in the identification when the fingerprint matches. */
  confidence: "high" | "medium" | "low";
}

export const EXIT_INTERFACES: ExitInterface[] = [
  {
    id: "compound-comet-base",
    label: "Compound III (Comet) base-asset supplier",
    // supply + baseToken + isWithdrawPaused together are unique to Comet and
    // cannot be confused with a plain ERC20 or an ERC4626 vault.
    fingerprint: [SELECTORS.cometSupply, SELECTORS.cometBaseToken, SELECTORS.cometIsWithdrawPaused],
    exitSignature: "withdraw(address,uint256)",
    exitSelector: SELECTORS.cometWithdraw,
    confidence: "high",
  },
];

/**
 * Identify the exit interface from a decoded selector set. Returns null when no
 * fingerprint matches — the caller reports `exit_action_unconfident` and the
 * verdict stays undetermined, never the reassuring tier.
 */
export function identifyExitInterface(selectors: readonly string[]): ExitInterface | null {
  const set = new Set(selectors.map((s) => s.toLowerCase()));
  for (const iface of EXIT_INTERFACES) {
    if (iface.fingerprint.every((s) => set.has(s.toLowerCase()))) return iface;
  }
  return null;
}
