import { describe, expect, it } from "vitest";
import { getAddress, type Hex } from "viem";
import { collectPowerHolders } from "../src/detect/accounts.js";
import type { ChainReader, Evidence } from "../src/chain/client.js";
import type { RoleEntry } from "../src/report/schema.js";

/** Network-free ChainReader: every address classifies as an EOA (no code). */
function fakeChain(): ChainReader {
  return {
    chainId: 1,
    blockNumber: 1n,
    async getBlockHash() {
      return "0x0" as Hex;
    },
    async getCodeAtBlock() {
      return { code: undefined };
    },
    async getCode(address: Hex) {
      return { code: undefined, evidence: { kind: "bytecode", params: { address }, rawValue: "0x", block: "1" } as Evidence };
    },
    async getStorageAt() {
      return { value: "0x0" as Hex, evidence: {} as Evidence };
    },
    async call() {
      return { result: undefined, reverted: true, evidence: {} as Evidence };
    },
    async probeCall() {
      return { revertData: undefined, reverted: true, evidence: {} as Evidence };
    },
    async getLogs() {
      return { logs: [], evidence: {} as Evidence };
    },
  };
}

describe("collectPowerHolders", () => {
  // Addresses arrive here in two different casings and this is not
  // hypothetical: viem's decodeFunctionResult returns EIP-55 checksummed
  // addresses (owner, pendingOwner, role members), while slotToAddress
  // slices raw storage words and returns lowercase (proxy admin,
  // implementation). Both appear in real report output side by side.
  const raw = "0x53bc21d38281d6acdfe0b92e0b534a19c90344cc";
  const lowercase = raw as Hex;
  const checksummed = getAddress(raw);

  it("sanity: the two casings really are different strings", () => {
    expect(checksummed).not.toBe(lowercase);
    expect(checksummed.toLowerCase()).toBe(lowercase);
  });

  it("REGRESSION: one address reached via differently-cased sources is a single power holder, not two", async () => {
    const holders = await collectPowerHolders(fakeChain(), {
      owner: checksummed, // as decoded from owner()
      proxyAdmin: lowercase, // as sliced from the EIP-1967 admin slot
    });

    expect(holders).toHaveLength(1);
    // ...and it must carry BOTH labels — the failure mode isn't only a
    // duplicated entry, it's two entries each claiming half the power.
    expect(holders[0]!.viaCapabilities.sort()).toEqual(["owner", "proxyAdmin"]);
  });

  it("REGRESSION: role membership and capability attribution match case-insensitively too", async () => {
    const roles: RoleEntry[] = [
      { role: ("0x" + "11".repeat(32)) as Hex, name: "MINTER_ROLE", members: [checksummed], adminRole: null, evidence: [] },
    ];

    const holders = await collectPowerHolders(fakeChain(), {
      proxyAdmin: lowercase,
      accessControlRoles: roles,
      capabilityHolders: [{ address: lowercase, label: "mint(address,uint256)" }],
    });

    expect(holders).toHaveLength(1);
    expect(holders[0]!.viaCapabilities.sort()).toEqual([
      "accessControl:MINTER_ROLE",
      "capability:mint(address,uint256)",
      "proxyAdmin",
    ]);
  });

  it("still separates genuinely distinct addresses", async () => {
    const other = getAddress("0x" + "22".repeat(20));
    const holders = await collectPowerHolders(fakeChain(), { owner: checksummed, proxyAdmin: other });
    expect(holders).toHaveLength(2);
  });
});
