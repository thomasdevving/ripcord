import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { assessDisclosure } from "../src/report/build.js";
import { clearedCapability, clearedRegistryVersion } from "../src/chain/clearedRegistry.js";
import type { CapabilitiesResult, DependencyGraph, ManualVerificationEntry, TokenDependency } from "../src/report/schema.js";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Hex;
const RANDOM_TOKEN = ("0x" + "cd".repeat(20)) as Hex;

const emptyCaps = (): CapabilitiesResult => ({
  taxonomyVersion: "0.1.0",
  dispatcherRecognized: true,
  scannedAddress: null,
  probedAddress: ("0x" + "11".repeat(20)) as Hex,
  selectorsExtracted: 0,
  unmatchedSelectors: [],
  findings: [],
  needsManualVerification: [],
  evidence: [],
});

const mv = (signature: string): ManualVerificationEntry => ({
  selector: "0x12345678",
  signature,
  category: "ACCESS_RESTRICTION",
  scannedAddress: ("0x" + "22".repeat(20)) as Hex,
  probedAddress: ("0x" + "22".repeat(20)) as Hex,
  reason: "no_auth_revert_observed",
  note: "n/a",
  probes: [],
});

const tokenDep = (token: Hex, mvs: ManualVerificationEntry[]): TokenDependency =>
  ({
    token,
    balance: "1",
    balanceEvidence: [],
    proxy: { pattern: "not_a_proxy", isProxy: false, implementation: null, beacon: null, admin: null, slots: {}, evidence: [] },
    authority: { owner: null, pendingOwner: null, accessControl: null },
    capabilities: { ...emptyCaps(), needsManualVerification: mvs },
    powerHolders: [],
  }) as TokenDependency;

const deps = (tokens: TokenDependency[]): DependencyGraph => ({ tokens, oracles: [] });

describe("cleared registry lookup", () => {
  it("clears a documented USDC capability, and only on USDC", () => {
    expect(clearedCapability(1, USDC, "blacklist(address)")).not.toBeNull();
    // Same signature on a different token is NOT cleared.
    expect(clearedCapability(1, RANDOM_TOKEN, "blacklist(address)")).toBeNull();
    // An undocumented signature on USDC is NOT cleared.
    expect(clearedCapability(1, USDC, "selfDestructEverything()")).toBeNull();
  });
});

describe("disclosure gate honours the cleared registry (both directions)", () => {
  it("a cleared USDC dependency finding does NOT block publication", () => {
    const d = assessDisclosure(1, emptyCaps(), deps([tokenDep(USDC, [mv("blacklist(address)")])]));
    expect(d.publishable).toBe(true);
    expect(d.blockedBy).toHaveLength(0);
    expect(d.cleared).toHaveLength(1);
    expect(d.cleared[0]!.signature).toBe("blacklist(address)");
    expect(d.cleared[0]!.justification).toMatch(/Circle/);
    expect(d.clearedRegistryVersion).toBe(clearedRegistryVersion);
  });

  it("an UNCLEARED finding on another token STILL blocks", () => {
    const d = assessDisclosure(1, emptyCaps(), deps([tokenDep(RANDOM_TOKEN, [mv("freeze(address)")])]));
    expect(d.publishable).toBe(false);
    expect(d.blockedBy).toHaveLength(1);
    expect(d.blockedBy[0]!.signature).toBe("freeze(address)");
  });

  it("a cleared USDC capability does not launder an UNcleared one on the same graph", () => {
    const d = assessDisclosure(
      1,
      emptyCaps(),
      deps([tokenDep(USDC, [mv("blacklist(address)"), mv("someUndocumentedPower(address)")])]),
    );
    expect(d.publishable).toBe(false); // the undocumented one still blocks
    expect(d.cleared.map((c) => c.signature)).toEqual(["blacklist(address)"]);
    expect(d.blockedBy.map((b) => b.signature)).toEqual(["someUndocumentedPower(address)"]);
  });

  it("the TARGET's own needsManualVerification is NEVER cleared, even for a signature the registry documents on a token", () => {
    const targetCaps = { ...emptyCaps(), needsManualVerification: [mv("blacklist(address)")] };
    const d = assessDisclosure(1, targetCaps, deps([]));
    expect(d.publishable).toBe(false);
    expect(d.blockedBy).toHaveLength(1);
  });
});
