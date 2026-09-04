/**
 * The guard-revert DIALECT dictionary, built from calibration.
 *
 * Day 2 recognised four shapes (OZ v4/v5 Ownable and AccessControl). Across the
 * calibration set that produced 27 "no auth-shaped revert observed" results of
 * which ZERO were genuinely unguarded; most were contracts stating plainly, in
 * their own revert string, that a guard had fired — Circle FiatToken "caller is
 * not the blacklister", Maker "Dai/not-authorized", OZ v3, Morpho "not owner",
 * Rocket Pool "Invalid or outdated contract", Ethena OnlyMinter(). The contract
 * itself is the witness, the same evidence class as the day-2 four.
 *
 * THE HARD BOUNDARY: this dictionary may only ever move a RECOGNISED revert
 * toward "guarded". There is deliberately no rule reading "we did not recognise
 * it, so assume guarded" — that inference is how false-clean gets built.
 * Unrecognised stays unrecognised and keeps blocking publication.
 *
 * It also classifies a second, different thing: a revert proving the probe
 * never REACHED an auth check (a zero-argument or state precondition firing
 * first). That is inconclusive, not suspicious, and does not block.
 *
 * IN-SAMPLE, and said out loud: these dialects were found by reading the
 * calibration set's own reverts, so the claim is "this dictionary knows these
 * N dialects", never "Ripcord recognises guards in general".
 */
import { toFunctionSelector, type Hex } from "viem";

/** Bump whenever an entry is added, removed or loosened. Recorded in the report. */
export const guardDialectsVersion = "0.2.0";

export type DialectKind =
  /** A guard fired: the contract rejected the caller on an authorisation check. */
  | "auth"
  /**
   * The call was rejected on a state or argument precondition BEFORE any auth
   * check could run — so this probe says nothing either way about a guard.
   */
  | "reverted_before_auth_check";

export interface GuardDialect {
  /** The family this revert belongs to, named so a reader can audit the match. */
  dialect: string;
  kind: DialectKind;
  /** Anchored on purpose: a substring match would let an unrelated message impersonate a guard. */
  pattern: RegExp;
  /** Where this exact string was read live, or how it was derived if it was not. */
  provenance: string;
}

/**
 * `Error(string)` dialects. Every pattern is anchored (^...$) — never a
 * substring test. A loose match here would let an unrelated revert message
 * masquerade as a guard, which is the one direction this file must not move in.
 */
export const STRING_DIALECTS: readonly GuardDialect[] = [
  // --- authorisation ---
  {
    dialect: "openzeppelin-v3-accesscontrol",
    kind: "auth",
    pattern: /^AccessControl: sender must be an admin to (grant|revoke)$/,
    provenance: "read live on Frax Share (FXS) 0x3432B6A6… at block 25800000, probing grantRole/revokeRole",
  },
  {
    dialect: "openzeppelin-accesscontrol-self-renounce",
    kind: "auth",
    pattern: /^AccessControl: can only renounce roles for self$/,
    provenance:
      "read live on Frax Share (FXS) 0x3432B6A6… at block 25800000, probing renounceRole. A self-scope check IS an authorisation check: it establishes the caller may only act on itself, so the function confers no power over anyone else",
  },
  {
    // Circle's FiatToken contracts and their forks. The role name varies by
    // module (pauser / blacklister / minter / rescuer / owner), so the family
    // is matched with the module and role names left open — but the sentence
    // shape is fixed and anchored.
    dialect: "circle-fiattoken",
    kind: "auth",
    pattern: /^[A-Z][A-Za-z]+: caller is not (a |the )?[a-z]+( [a-z]+)?$/,
    provenance:
      "read live on USDC 0xA0b86991… and cbETH 0xBe989514… at block 25800000: \"Pausable: caller is not the pauser\", \"Blacklistable: caller is not the blacklister\", \"FiatToken: caller is not a minter\", \"Rescuable: caller is not the rescuer\"",
  },
  {
    // MakerDAO's ds-auth / `auth` modifier convention: "<ContractName>/not-authorized".
    dialect: "ds-auth",
    kind: "auth",
    pattern: /^[A-Za-z][A-Za-z0-9]*\/not-authorized$/,
    provenance: "read live on DAI 0x6B175474… at block 25800000, probing mint: \"Dai/not-authorized\"",
  },
  {
    dialect: "morpho-blue",
    kind: "auth",
    pattern: /^not owner$/,
    provenance: "read live on Morpho Blue 0xBBBBBbbB… at block 25800000, probing setFeeRecipient",
  },
  {
    dialect: "frax-owner-or-governance",
    kind: "auth",
    pattern: /^You are not an owner or the governance timelock$/,
    provenance: "read live on Frax Share (FXS) 0x3432B6A6… at block 25800000, probing setOracle",
  },
  {
    dialect: "frax-pools-only",
    kind: "auth",
    pattern: /^Only frax pools can mint new FRAX$/,
    provenance: "read live on Frax Share (FXS) 0x3432B6A6… at block 25800000, probing mint",
  },
  {
    dialect: "rocketpool-network-contract",
    kind: "auth",
    pattern: /^Invalid or outdated contract$/,
    provenance:
      "read live on Rocket Pool ETH (rETH) 0xae78736C… at block 25800000, probing mint(uint256,address). This is Rocket Pool's `onlyLatestNetworkContract` guard: the caller is checked against the RocketStorage registry",
  },

  // --- rejected before any auth check could run ---
  {
    // Our own zero-valued probe arguments coming back at us. The ERC20 family
    // validates addresses before doing anything else, so a zero `from`/`to`/
    // `spender` is rejected long before a mint/burn guard is consulted.
    dialect: "erc20-zero-address-precondition",
    kind: "reverted_before_auth_check",
    pattern: /^ERC20: (approve|transfer|mint|burn) (from|to) the zero address$/,
    provenance:
      "read live on FXS 0x3432B6A6… and Ethena USDe 0x4c9EDD58… at block 25800000, probing burnFrom: \"ERC20: approve from the zero address\". The zero address is OUR probe's argument, so this reverts on argument validation, not authorisation. The transfer/mint/burn variants are the same OpenZeppelin family and were NOT observed live",
  },
  {
    dialect: "openzeppelin-pausable-state",
    kind: "reverted_before_auth_check",
    pattern: /^Pausable: (not paused|paused)$/,
    provenance:
      "\"Pausable: not paused\" read live on PAID Network 0x8c8687fc… at block 25800000, probing unpause — the contract is unpaused, so unpause() fails its state precondition before reaching the auth check. The \"paused\" variant is the same OpenZeppelin modifier pair and was NOT observed live",
  },
  {
    dialect: "compound-market-paused",
    kind: "reverted_before_auth_check",
    pattern: /^(mint|borrow|transfer|seize) is paused$/,
    provenance:
      "\"mint is paused\" read live on Compound cDAI 0x5d3a536E… at block 25800000. Compound's Comptroller checks the market's guardian pause flag before the action runs. The other three verbs are the same Comptroller guard family and were NOT observed live",
  },
] as const;

/**
 * Custom-error dialects, keyed by the 4-byte selector DERIVED from the error
 * signature (never copied from an explorer) — the same discipline day 2 applied
 * to the four OZ selectors and day 3 to the timelock accessors.
 */
export const CUSTOM_ERROR_DIALECTS: ReadonlyArray<{
  signature: string;
  dialect: string;
  kind: DialectKind;
  provenance: string;
}> = [
  {
    signature: "InvalidAmount()",
    dialect: "zero-amount-precondition",
    kind: "reverted_before_auth_check",
    provenance:
      "read live on Ethena sUSDe 0x9D39A5DE… at block 25800000, probing ERC-4626 mint(uint256,address) with zero-valued arguments: the raw revert 0x2c5211c6 equals toFunctionSelector(\"InvalidAmount()\"). The zero amount is OUR probe's argument, so this is the same class as the ERC20 zero-address preconditions above",
  },
  {
    signature: "OnlyMinter()",
    dialect: "ethena-only-minter",
    kind: "auth",
    provenance:
      "read live on Ethena USDe 0x4c9EDD58… at block 25800000, probing mint(address,uint256): the raw revert 0x9cdc2ed5 equals toFunctionSelector(\"OnlyMinter()\")",
  },
] as const;

/** selector -> dialect, derived at module load so a hand-typed selector cannot drift from its signature. */
export const CUSTOM_ERROR_DIALECTS_BY_SELECTOR: ReadonlyMap<string, (typeof CUSTOM_ERROR_DIALECTS)[number]> = new Map(
  CUSTOM_ERROR_DIALECTS.map((d) => [toFunctionSelector(d.signature).toLowerCase(), d]),
);

export interface DialectMatch {
  dialect: string;
  kind: DialectKind;
  /** The decoded revert string, or the custom-error signature — quoted back so the match is auditable. */
  matched: string;
  provenance: string;
}

/**
 * Matches one probe's revert against the dictionary.
 *
 * `message` is the already-decoded `Error(string)` payload when there was one;
 * `selector` is the raw 4-byte prefix. Returns null for anything unrecognised —
 * and null must always be handled as "still unknown", never as "not guarded"
 * and never as "guarded".
 */
export function matchGuardDialect(args: { message?: string | undefined; selector?: Hex | undefined }): DialectMatch | null {
  if (args.message !== undefined) {
    for (const d of STRING_DIALECTS) {
      if (d.pattern.test(args.message)) {
        return { dialect: d.dialect, kind: d.kind, matched: args.message, provenance: d.provenance };
      }
    }
  }
  if (args.selector !== undefined) {
    const hit = CUSTOM_ERROR_DIALECTS_BY_SELECTOR.get(args.selector.toLowerCase());
    if (hit) {
      return { dialect: hit.dialect, kind: hit.kind, matched: hit.signature, provenance: hit.provenance };
    }
  }
  return null;
}
