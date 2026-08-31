import { describe, expect, it } from "vitest";
import { toFunctionSelector } from "viem";
import { SLOTS, SELECTORS, TIMELOCK_SELECTORS } from "../src/chain/constants.js";

// Known-good reference values, provided independently of the derivation in
// constants.ts. If these ever disagree with the derived values, the
// derivation is authoritative and this test should fail loudly, not be
// "fixed" by copying the derived value back in.
const EXPECTED_EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EXPECTED_EIP1967_ADMIN_SLOT =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

describe("derived EIP-1967 storage slots", () => {
  it("implementation slot matches the canonical EIP-1967 value", () => {
    expect(SLOTS.eip1967Implementation.toLowerCase()).toBe(
      EXPECTED_EIP1967_IMPLEMENTATION_SLOT.toLowerCase(),
    );
  });

  it("admin slot matches the canonical EIP-1967 value", () => {
    expect(SLOTS.eip1967Admin.toLowerCase()).toBe(EXPECTED_EIP1967_ADMIN_SLOT.toLowerCase());
  });

  it("beacon slot is derived (no external reference value given, sanity-check shape)", () => {
    expect(SLOTS.eip1967Beacon).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("all slots are distinct", () => {
    const values = Object.values(SLOTS);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe("derived function selectors", () => {
  it("owner() matches an independent viem derivation", () => {
    expect(SELECTORS.owner).toBe(toFunctionSelector("owner()"));
  });

  it("hasRole(bytes32,address) is derived correctly", () => {
    expect(SELECTORS.hasRole).toBe(toFunctionSelector("hasRole(bytes32,address)"));
  });

  it("all selectors are 4 bytes and distinct", () => {
    const values = Object.values(SELECTORS);
    for (const v of values) {
      expect(v).toMatch(/^0x[0-9a-f]{8}$/);
    }
    expect(new Set(values).size).toBe(values.length);
  });
});

describe("derived timelock selectors (day 3)", () => {
  // Independent, known-good 4byte reference values for the timelock accessors,
  // supplied here separately from the derivation in constants.ts. If the
  // derived value ever disagrees, the derivation is authoritative and this
  // test must fail — the same discipline day 1 applied to the EIP-1967 slots.
  const EXPECTED: Record<keyof typeof TIMELOCK_SELECTORS, string> = {
    getMinDelay: "0xf27a0c92", // OZ TimelockController
    delay: "0x6a42b8f8", // Compound/Bravo Timelock
    admin: "0xf851a440", // Compound Timelock admin()
    GRACE_PERIOD: "0xc1a287e2",
    MINIMUM_DELAY: "0xb1b43ae5",
    MAXIMUM_DELAY: "0x7d645fab",
    updateDelay: "0x64d62353", // OZ: shorten-your-own-delay path
    setDelay: "0xe177246e", // Compound: shorten-your-own-delay path
  };

  it("each timelock selector matches its independent reference value", () => {
    for (const [name, expected] of Object.entries(EXPECTED)) {
      expect(TIMELOCK_SELECTORS[name as keyof typeof TIMELOCK_SELECTORS].toLowerCase()).toBe(
        expected.toLowerCase(),
      );
    }
  });

  it("timelock selectors are 4 bytes and distinct", () => {
    const values = Object.values(TIMELOCK_SELECTORS);
    for (const v of values) expect(v).toMatch(/^0x[0-9a-f]{8}$/);
    expect(new Set(values).size).toBe(values.length);
  });
});
