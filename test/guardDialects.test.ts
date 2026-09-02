/**
 * The dialect dictionary's tests exist mainly to pin its BOUNDARY, not its
 * coverage. Coverage can be extended safely; the boundary cannot be crossed
 * safely, so most of what follows checks that an unrecognised revert stays
 * unrecognised and that nothing here can manufacture a guard.
 *
 * Every "recognised" case below quotes a revert string that was read live off
 * mainnet during day-5 calibration at block 25800000 — the provenance is on the
 * dictionary entry itself.
 */
import { describe, expect, it } from "vitest";
import { toFunctionSelector } from "viem";
import {
  CUSTOM_ERROR_DIALECTS,
  CUSTOM_ERROR_DIALECTS_BY_SELECTOR,
  STRING_DIALECTS,
  guardDialectsVersion,
  matchGuardDialect,
} from "../src/detect/guardDialects.js";

describe("guard dialect dictionary", () => {
  it("recognises every auth string read live during calibration", () => {
    const observed: [string, string][] = [
      ["AccessControl: sender must be an admin to grant", "openzeppelin-v3-accesscontrol"],
      ["AccessControl: sender must be an admin to revoke", "openzeppelin-v3-accesscontrol"],
      ["AccessControl: can only renounce roles for self", "openzeppelin-accesscontrol-self-renounce"],
      ["Pausable: caller is not the pauser", "circle-fiattoken"],
      ["Blacklistable: caller is not the blacklister", "circle-fiattoken"],
      ["FiatToken: caller is not a minter", "circle-fiattoken"],
      ["Rescuable: caller is not the rescuer", "circle-fiattoken"],
      ["Dai/not-authorized", "ds-auth"],
      ["not owner", "morpho-blue"],
      ["You are not an owner or the governance timelock", "frax-owner-or-governance"],
      ["Only frax pools can mint new FRAX", "frax-pools-only"],
      ["Invalid or outdated contract", "rocketpool-network-contract"],
    ];
    for (const [message, dialect] of observed) {
      const hit = matchGuardDialect({ message });
      expect(hit, `expected to recognise ${JSON.stringify(message)}`).not.toBeNull();
      expect(hit!.kind).toBe("auth");
      expect(hit!.dialect).toBe(dialect);
    }
  });

  it("classifies a revert that fired BEFORE any auth check as exactly that", () => {
    // These are the probe's own zero-valued arguments and the contract's own
    // state coming back at us — not evidence about a guard in either direction.
    for (const message of ["ERC20: approve from the zero address", "Pausable: not paused", "mint is paused"]) {
      const hit = matchGuardDialect({ message });
      expect(hit, message).not.toBeNull();
      expect(hit!.kind).toBe("reverted_before_auth_check");
    }
  });

  it("derives custom-error selectors rather than trusting a copied constant", () => {
    for (const d of CUSTOM_ERROR_DIALECTS) {
      const derived = toFunctionSelector(d.signature).toLowerCase();
      expect(CUSTOM_ERROR_DIALECTS_BY_SELECTOR.get(derived)?.signature).toBe(d.signature);
    }
    // The exact bytes read from Ethena USDe 0x4c9EDD58… while probing mint.
    expect(toFunctionSelector("OnlyMinter()")).toBe("0x9cdc2ed5");
    // And the ERC-4626 selector collision read off sUSDe in the same run: the
    // SAME mint(uint256,address) selector, rejected on an amount precondition
    // rather than a guard. Classified as pre-auth, never as authorisation.
    expect(toFunctionSelector("InvalidAmount()")).toBe("0x2c5211c6");
    expect(matchGuardDialect({ selector: "0x2c5211c6" })?.kind).toBe("reverted_before_auth_check");
    const hit = matchGuardDialect({ selector: "0x9cdc2ed5" });
    expect(hit?.kind).toBe("auth");
    expect(hit?.dialect).toBe("ethena-only-minter");
  });

  // --- THE BOUNDARY. These are the tests that make the dictionary safe. ---

  it("returns null for anything it does not recognise, and never a guess", () => {
    const unrecognised = [
      "some entirely unrelated failure",
      "", // an empty revert string
      "SafeMath: subtraction overflow",
      // Wasabi's real revert, read live: auth-SHAPED (it echoes the caller) but
      // not a signature this dictionary knows. It must stay unrecognised.
      "0xf07e038f",
    ];
    for (const message of unrecognised) {
      expect(matchGuardDialect({ message }), message).toBeNull();
    }
    expect(matchGuardDialect({ selector: "0xf07e038f" })).toBeNull();
    expect(matchGuardDialect({})).toBeNull();
  });

  it("anchors every pattern, so an unrelated message cannot embed a guard phrase", () => {
    // A substring matcher would accept all of these. That would let a contract's
    // unrelated revert impersonate a guard — the one direction this file must
    // never move in.
    const embedded = [
      "prefix Dai/not-authorized",
      "Dai/not-authorized suffix",
      "reason: not owner",
      "not owner of this token id",
      "Pausable: caller is not the pauser, retry later",
    ];
    for (const message of embedded) {
      expect(matchGuardDialect({ message }), message).toBeNull();
    }
    for (const d of STRING_DIALECTS) {
      expect(d.pattern.source.startsWith("^"), `${d.dialect} must be anchored at the start`).toBe(true);
      expect(d.pattern.source.endsWith("$"), `${d.dialect} must be anchored at the end`).toBe(true);
    }
  });

  it("every entry records where it came from, so a match is auditable", () => {
    for (const d of [...STRING_DIALECTS, ...CUSTOM_ERROR_DIALECTS]) {
      expect(d.provenance.length, d.dialect).toBeGreaterThan(30);
    }
    expect(guardDialectsVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
