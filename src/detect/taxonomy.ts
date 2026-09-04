/**
 * Versioned capability taxonomy: known function signatures grouped by the POWER
 * they grant, not by name. This table — not scattered conditionals — drives a
 * report's capability grouping, and is what `rulesetVersion` refers to.
 *
 * Every entry is a FULL signature, matched by computing its selector with viem
 * against the dispatcher's extracted set, never by matching a bare name (the
 * extractor has no access to source-level names at all): `mint(address,uint256)`
 * and `mint(uint256)` are different entries.
 *
 * `specificity` says how safely a matched NAME can be assumed to carry the
 * significance this table assigns it. It is not a certainty score, and is
 * surfaced as `nameMatchSpecificity` precisely so it is never read as one.
 * "standard" — widely-adopted signatures where the name reliably implies the
 * capability; "generic" — reused names with no dominant standard behind them
 * (sweep, skim, emergencyWithdraw, ad hoc setters), where the match is exact but
 * what the name IMPLIES varies by project.
 *
 * A selector absent from this table is unclassified, never "no capability".
 * There is no reverse-lookup against a 4byte-style database: that would be a
 * live, non-deterministic dependency.
 */
import { toFunctionSelector, type Hex } from "viem";
import type { CapabilityCategory } from "../report/schema.js";

export const taxonomyVersion = "0.2.0";

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
  // Argument-swapped mint. A different selector, so it needs its own entry —
  // found live on Rocket Pool's rETH (selector 0x94bf804d), where its absence
  // was the sole reason a contract with a real privileged minter came back as
  // having no rule-change route at all.
  //
  // `generic`, and the clearest example in the table of why that field exists:
  // this exact selector is ALSO ERC-4626's `mint(uint256 shares, address
  // receiver)`, the public deposit function every vault exposes to everybody.
  // Matching it on Ethena's sUSDe returns InvalidAmount(), a zero-amount
  // precondition, because there is no privilege there to find. Selectors are not
  // names — the probe tells the two apart on evidence, which is the point of
  // probing rather than reasoning from the name.
  { signature: "mint(uint256,address)", category: "SUPPLY", specificity: "generic" },
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
