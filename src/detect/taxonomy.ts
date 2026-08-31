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
 * `specificity` reflects how safely a matched *name* can be assumed to carry
 * the significance this table assigns it — it is NOT a confidence/certainty
 * score, and is named `nameMatchSpecificity` in the report precisely so it is
 * never read as one (see the schema note). The selector match itself is always
 * exact — a keccak comparison, no fuzziness:
 *   "standard" — widely-adopted signatures (OZ Ownable/AccessControl/Pausable,
 *            common ERC20 mint/burn extensions, EIP-1967-adjacent upgrade
 *            functions). The name reliably implies the capability.
 *   "generic"  — commonly-reused names with no single dominant standard behind
 *            them (sweep, skim, emergencyWithdraw, adminWithdraw, rescueTokens
 *            and similar escape hatches, ad hoc economic setters). The brief's
 *            own example: one project's `sweep()` is another's unrelated
 *            helper. The match is exact, but what the name IMPLIES varies by
 *            project — a semantic caveat, not lower detection certainty.
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
  specificity: "standard" | "generic";
}

const RAW_TAXONOMY: TaxonomyEntry[] = [
  // --- CODE_CHANGE ---
  { signature: "upgradeTo(address)", category: "CODE_CHANGE", specificity: "standard" },
  { signature: "upgradeToAndCall(address,bytes)", category: "CODE_CHANGE", specificity: "standard" },
  { signature: "setImplementation(address)", category: "CODE_CHANGE", specificity: "standard" },
  { signature: "changeAdmin(address)", category: "CODE_CHANGE", specificity: "standard" },
  { signature: "upgradeBeaconTo(address)", category: "CODE_CHANGE", specificity: "standard" },
  { signature: "upgradeBeaconToAndCall(address,bytes)", category: "CODE_CHANGE", specificity: "standard" },

  // --- FUND_MOVEMENT ---
  { signature: "sweep(address)", category: "FUND_MOVEMENT", specificity: "generic" },
  { signature: "sweep(address,address)", category: "FUND_MOVEMENT", specificity: "generic" },
  { signature: "sweep()", category: "FUND_MOVEMENT", specificity: "generic" },
  { signature: "rescueTokens(address,address,uint256)", category: "FUND_MOVEMENT", specificity: "generic" },
  { signature: "rescueTokens(address,address)", category: "FUND_MOVEMENT", specificity: "generic" },
  { signature: "rescueERC20(address,address,uint256)", category: "FUND_MOVEMENT", specificity: "generic" },
  { signature: "emergencyWithdraw(address)", category: "FUND_MOVEMENT", specificity: "generic" },
  { signature: "emergencyWithdraw(address,uint256)", category: "FUND_MOVEMENT", specificity: "generic" },
  { signature: "emergencyWithdraw()", category: "FUND_MOVEMENT", specificity: "generic" },
  { signature: "adminWithdraw(address,uint256)", category: "FUND_MOVEMENT", specificity: "generic" },
  { signature: "adminWithdraw(uint256)", category: "FUND_MOVEMENT", specificity: "generic" },
  { signature: "skim(address)", category: "FUND_MOVEMENT", specificity: "generic" },
  { signature: "skim()", category: "FUND_MOVEMENT", specificity: "generic" },
  { signature: "withdrawFees(address)", category: "FUND_MOVEMENT", specificity: "generic" },

  // --- SUPPLY ---
  { signature: "mint(address,uint256)", category: "SUPPLY", specificity: "standard" },
  { signature: "mint(uint256)", category: "SUPPLY", specificity: "standard" },
  { signature: "mint(address,uint256,bytes)", category: "SUPPLY", specificity: "standard" },
  { signature: "burnFrom(address,uint256)", category: "SUPPLY", specificity: "standard" },

  // --- ACCESS_RESTRICTION ---
  { signature: "pause()", category: "ACCESS_RESTRICTION", specificity: "standard" },
  { signature: "unpause()", category: "ACCESS_RESTRICTION", specificity: "standard" },
  { signature: "blacklist(address)", category: "ACCESS_RESTRICTION", specificity: "standard" },
  { signature: "unBlacklist(address)", category: "ACCESS_RESTRICTION", specificity: "standard" },
  { signature: "addToBlacklist(address)", category: "ACCESS_RESTRICTION", specificity: "standard" },
  { signature: "removeFromBlacklist(address)", category: "ACCESS_RESTRICTION", specificity: "standard" },
  { signature: "freeze(address)", category: "ACCESS_RESTRICTION", specificity: "standard" },
  { signature: "unfreeze(address)", category: "ACCESS_RESTRICTION", specificity: "standard" },
  { signature: "setWhitelist(address,bool)", category: "ACCESS_RESTRICTION", specificity: "generic" },
  { signature: "setBlocked(address,bool)", category: "ACCESS_RESTRICTION", specificity: "generic" },

  // --- ECONOMIC ---
  { signature: "setFee(uint256)", category: "ECONOMIC", specificity: "generic" },
  { signature: "setFeeRecipient(address)", category: "ECONOMIC", specificity: "generic" },
  { signature: "setInterestRate(uint256)", category: "ECONOMIC", specificity: "generic" },
  { signature: "setCollateralFactor(address,uint256)", category: "ECONOMIC", specificity: "generic" },
  { signature: "setOracle(address)", category: "ECONOMIC", specificity: "standard" },
  { signature: "setPriceFeed(address)", category: "ECONOMIC", specificity: "standard" },
  { signature: "setPriceOracle(address)", category: "ECONOMIC", specificity: "standard" },
  { signature: "setLTV(uint256)", category: "ECONOMIC", specificity: "generic" },

  // --- AUTHORITY_CHANGE ---
  { signature: "transferOwnership(address)", category: "AUTHORITY_CHANGE", specificity: "standard" },
  { signature: "renounceOwnership()", category: "AUTHORITY_CHANGE", specificity: "standard" },
  { signature: "grantRole(bytes32,address)", category: "AUTHORITY_CHANGE", specificity: "standard" },
  { signature: "revokeRole(bytes32,address)", category: "AUTHORITY_CHANGE", specificity: "standard" },
  { signature: "renounceRole(bytes32,address)", category: "AUTHORITY_CHANGE", specificity: "standard" },
  { signature: "setAdmin(address)", category: "AUTHORITY_CHANGE", specificity: "generic" },
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
