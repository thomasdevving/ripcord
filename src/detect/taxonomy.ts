/**
 * Versioned capability taxonomy: known function signatures grouped by the
 * POWER they grant, not by name. This table — not scattered conditionals —
 * is what a report's capability grouping is driven by, and it is what
 * `rulesetVersion` (schema.ts) actually refers to: bump it whenever this
 * table changes.
 *
 * Every entry is a FULL signature (name + exact parameter types), matched
 * by computing its selector with viem and checking the dispatcher's
 * extracted selector set — never by matching a bare name against anything,
 * since selectors are opaque 4-byte values and the extractor has no access
 * to source-level names at all. `mint(address,uint256)` and `mint(uint256)`
 * are different selectors and different table entries.
 *
 * `confidence` reflects how safely a matched *name* can be assumed to carry
 * the significance this table assigns it, not how sure the selector match
 * itself is (the selector match is always exact — it's a keccak comparison,
 * there's no fuzziness there):
 *   "high" — standard, widely-adopted signatures (OZ Ownable/AccessControl/
 *            Pausable, common ERC20 mint/burn extensions, EIP-1967-adjacent
 *            upgrade functions). A match is strong evidence of the capability.
 *   "low"  — generic, commonly-reused names with no single dominant standard
 *            behind them (sweep, skim, emergencyWithdraw, adminWithdraw,
 *            rescueTokens and similar escape hatches, ad hoc economic
 *            setters). The brief's own example: one project's `sweep()` is
 *            another's unrelated helper. A match here is real (the selector
 *            comparison is exact) but the capability it implies should be
 *            reported with visibly lower confidence.
 *
 * A selector present in a scanned contract but absent from this table is
 * simply unclassified — see KNOWN EDGES in CLAUDE.md: Ripcord does not
 * attempt reverse-lookup against an external 4byte-style selector database,
 * since that would be a live, non-deterministic dependency inconsistent
 * with pinned-block reproducibility. Unclassified is not "no capability."
 */
import { toFunctionSelector, type Hex } from "viem";
import type { CapabilityCategory } from "../report/schema.js";

export const taxonomyVersion = "0.1.0";

export interface TaxonomyEntry {
  signature: string;
  category: CapabilityCategory;
  confidence: "high" | "low";
}

const RAW_TAXONOMY: TaxonomyEntry[] = [
  // --- CODE_CHANGE ---
  { signature: "upgradeTo(address)", category: "CODE_CHANGE", confidence: "high" },
  { signature: "upgradeToAndCall(address,bytes)", category: "CODE_CHANGE", confidence: "high" },
  { signature: "setImplementation(address)", category: "CODE_CHANGE", confidence: "high" },
  { signature: "changeAdmin(address)", category: "CODE_CHANGE", confidence: "high" },
  { signature: "upgradeBeaconTo(address)", category: "CODE_CHANGE", confidence: "high" },
  { signature: "upgradeBeaconToAndCall(address,bytes)", category: "CODE_CHANGE", confidence: "high" },

  // --- FUND_MOVEMENT ---
  { signature: "sweep(address)", category: "FUND_MOVEMENT", confidence: "low" },
  { signature: "sweep(address,address)", category: "FUND_MOVEMENT", confidence: "low" },
  { signature: "sweep()", category: "FUND_MOVEMENT", confidence: "low" },
  { signature: "rescueTokens(address,address,uint256)", category: "FUND_MOVEMENT", confidence: "low" },
  { signature: "rescueTokens(address,address)", category: "FUND_MOVEMENT", confidence: "low" },
  { signature: "rescueERC20(address,address,uint256)", category: "FUND_MOVEMENT", confidence: "low" },
  { signature: "emergencyWithdraw(address)", category: "FUND_MOVEMENT", confidence: "low" },
  { signature: "emergencyWithdraw(address,uint256)", category: "FUND_MOVEMENT", confidence: "low" },
  { signature: "emergencyWithdraw()", category: "FUND_MOVEMENT", confidence: "low" },
  { signature: "adminWithdraw(address,uint256)", category: "FUND_MOVEMENT", confidence: "low" },
  { signature: "adminWithdraw(uint256)", category: "FUND_MOVEMENT", confidence: "low" },
  { signature: "skim(address)", category: "FUND_MOVEMENT", confidence: "low" },
  { signature: "skim()", category: "FUND_MOVEMENT", confidence: "low" },
  { signature: "withdrawFees(address)", category: "FUND_MOVEMENT", confidence: "low" },

  // --- SUPPLY ---
  { signature: "mint(address,uint256)", category: "SUPPLY", confidence: "high" },
  { signature: "mint(uint256)", category: "SUPPLY", confidence: "high" },
  { signature: "mint(address,uint256,bytes)", category: "SUPPLY", confidence: "high" },
  { signature: "burnFrom(address,uint256)", category: "SUPPLY", confidence: "high" },

  // --- ACCESS_RESTRICTION ---
  { signature: "pause()", category: "ACCESS_RESTRICTION", confidence: "high" },
  { signature: "unpause()", category: "ACCESS_RESTRICTION", confidence: "high" },
  { signature: "blacklist(address)", category: "ACCESS_RESTRICTION", confidence: "high" },
  { signature: "unBlacklist(address)", category: "ACCESS_RESTRICTION", confidence: "high" },
  { signature: "addToBlacklist(address)", category: "ACCESS_RESTRICTION", confidence: "high" },
  { signature: "removeFromBlacklist(address)", category: "ACCESS_RESTRICTION", confidence: "high" },
  { signature: "freeze(address)", category: "ACCESS_RESTRICTION", confidence: "high" },
  { signature: "unfreeze(address)", category: "ACCESS_RESTRICTION", confidence: "high" },
  { signature: "setWhitelist(address,bool)", category: "ACCESS_RESTRICTION", confidence: "low" },
  { signature: "setBlocked(address,bool)", category: "ACCESS_RESTRICTION", confidence: "low" },

  // --- ECONOMIC ---
  { signature: "setFee(uint256)", category: "ECONOMIC", confidence: "low" },
  { signature: "setFeeRecipient(address)", category: "ECONOMIC", confidence: "low" },
  { signature: "setInterestRate(uint256)", category: "ECONOMIC", confidence: "low" },
  { signature: "setCollateralFactor(address,uint256)", category: "ECONOMIC", confidence: "low" },
  { signature: "setOracle(address)", category: "ECONOMIC", confidence: "high" },
  { signature: "setPriceFeed(address)", category: "ECONOMIC", confidence: "high" },
  { signature: "setPriceOracle(address)", category: "ECONOMIC", confidence: "high" },
  { signature: "setLTV(uint256)", category: "ECONOMIC", confidence: "low" },

  // --- AUTHORITY_CHANGE ---
  { signature: "transferOwnership(address)", category: "AUTHORITY_CHANGE", confidence: "high" },
  { signature: "renounceOwnership()", category: "AUTHORITY_CHANGE", confidence: "high" },
  { signature: "grantRole(bytes32,address)", category: "AUTHORITY_CHANGE", confidence: "high" },
  { signature: "revokeRole(bytes32,address)", category: "AUTHORITY_CHANGE", confidence: "high" },
  { signature: "renounceRole(bytes32,address)", category: "AUTHORITY_CHANGE", confidence: "high" },
  { signature: "setAdmin(address)", category: "AUTHORITY_CHANGE", confidence: "low" },
];

interface ResolvedEntry extends TaxonomyEntry {
  selector: Hex;
}

/** Selector -> taxonomy entry, computed once from RAW_TAXONOMY via viem (never hardcoded). */
export const TAXONOMY_BY_SELECTOR: ReadonlyMap<Hex, ResolvedEntry> = new Map(
  RAW_TAXONOMY.map((entry) => {
    const selector = toFunctionSelector(entry.signature);
    return [selector, { ...entry, selector }] as const;
  }),
);

export function lookupTaxonomy(selector: Hex): ResolvedEntry | null {
  return TAXONOMY_BY_SELECTOR.get(selector.toLowerCase() as Hex) ?? TAXONOMY_BY_SELECTOR.get(selector) ?? null;
}
