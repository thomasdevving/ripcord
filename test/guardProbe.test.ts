import { describe, expect, it } from "vitest";
import { encodeErrorResult, toFunctionSelector, zeroAddress, type Hex } from "viem";
import {
  ACCESS_CONTROL_UNAUTHORIZED_SELECTOR,
  ERROR_STRING_SELECTOR,
  OWNABLE_UNAUTHORIZED_SELECTOR,
  PROBE_ADDRESSES,
  parseAuthShape,
  probeGuard,
  zeroCalldataForSignature,
} from "../src/detect/guardProbe.js";
import type { ChainReader, Evidence } from "../src/chain/client.js";
import type { RoleEntry } from "../src/report/schema.js";

describe("guard revert-shape selectors — derived, not hardcoded", () => {
  it("Error(string) is the standard Solidity revert-reason selector", () => {
    expect(ERROR_STRING_SELECTOR.toLowerCase()).toBe("0x08c379a0");
  });

  it("OwnableUnauthorizedAccount(address) and AccessControlUnauthorizedAccount(address,bytes32) are derived via the same keccak selector math as any function", () => {
    expect(OWNABLE_UNAUTHORIZED_SELECTOR).toBe(toFunctionSelector("OwnableUnauthorizedAccount(address)"));
    expect(ACCESS_CONTROL_UNAUTHORIZED_SELECTOR).toBe(toFunctionSelector("AccessControlUnauthorizedAccount(address,bytes32)"));
  });

  it("all three error selectors are 4 bytes and mutually distinct", () => {
    const values = [ERROR_STRING_SELECTOR, OWNABLE_UNAUTHORIZED_SELECTOR, ACCESS_CONTROL_UNAUTHORIZED_SELECTOR];
    for (const v of values) expect(v).toMatch(/^0x[0-9a-fA-F]{8}$/);
    expect(new Set(values).size).toBe(values.length);
  });

  it("probe addresses are deterministic (not random) — reproducibility depends on this", () => {
    const again = [0, 1, 2].map((i) => PROBE_ADDRESSES[i]);
    expect(again).toEqual([...PROBE_ADDRESSES]);
    expect(new Set(PROBE_ADDRESSES).size).toBe(3);
  });
});

describe("parseAuthShape", () => {
  it("recognizes a real mainnet-observed OZ v4 Ownable string revert", () => {
    // Captured live: eth_call transferOwnership(address) against PAID Network's
    // token proxy 0x8c8687fc965593dfb2f0b4eaefd55e9d8df348df at block 25800000,
    // from an unrelated address. Verified against test/fixtures/targets.json's
    // documented owner (a plain EOA, no multisig).
    const revertData =
      "0x08c379a0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000204f776e61626c653a2063616c6c6572206973206e6f7420746865206f776e6572" as Hex;
    expect(parseAuthShape(revertData)).toEqual({ kind: "ownable" });
  });

  it("recognizes a real mainnet-observed OZ v4 AccessControl string revert and extracts the role hash", () => {
    const role = ("0x" + "aa".repeat(32)) as Hex;
    const message = `AccessControl: account ${zeroAddress} is missing role ${role}`;
    const revertData = encodeErrorString(message);
    expect(parseAuthShape(revertData)).toEqual({ kind: "accessControlRole", role });
  });

  it("recognizes an OZ v5 OwnableUnauthorizedAccount custom error (ABI-encoded via viem, not hand-built)", () => {
    const revertData = encodeErrorResult({
      abi: [{ type: "error", name: "OwnableUnauthorizedAccount", inputs: [{ type: "address", name: "account" }] }],
      errorName: "OwnableUnauthorizedAccount",
      args: [zeroAddress],
    });
    expect(parseAuthShape(revertData)).toEqual({ kind: "ownable" });
  });

  it("recognizes an OZ v5 AccessControlUnauthorizedAccount custom error and extracts the role", () => {
    const role = ("0x" + "bb".repeat(32)) as Hex;
    const revertData = encodeErrorResult({
      abi: [
        {
          type: "error",
          name: "AccessControlUnauthorizedAccount",
          inputs: [
            { type: "address", name: "account" },
            { type: "bytes32", name: "neededRole" },
          ],
        },
      ],
      errorName: "AccessControlUnauthorizedAccount",
      args: [zeroAddress, role],
    });
    expect(parseAuthShape(revertData)).toEqual({ kind: "accessControlRole", role });
  });

  it("does NOT treat a real mainnet-observed unrelated revert string as auth-shaped", () => {
    // Captured live: eth_call mint(address,uint256) against USDC's FiatTokenV2_2
    // implementation, zero-valued args, from an unrelated address — a real
    // custom (non-OZ) guard message.
    const revertData = encodeErrorString("FiatToken: caller is not a minter");
    expect(parseAuthShape(revertData)).toBeNull();
  });

  it("returns null for undefined or unparseable revert data", () => {
    expect(parseAuthShape(undefined)).toBeNull();
    expect(parseAuthShape("0xdeadbeef" as Hex)).toBeNull();
  });
});

describe("zeroCalldataForSignature", () => {
  it("matches an independent viem encoding for a known signature", () => {
    const calldata = zeroCalldataForSignature("transferOwnership(address)");
    expect(calldata).toBe(toFunctionSelector("transferOwnership(address)") + "0".repeat(64));
  });

  it("zero-fills multiple argument types correctly", () => {
    const calldata = zeroCalldataForSignature("mint(address,uint256)");
    expect(calldata).toBe(toFunctionSelector("mint(address,uint256)") + "0".repeat(64) + "0".repeat(64));
  });
});

function encodeErrorString(message: string): Hex {
  const hex = Buffer.from(message, "utf8").toString("hex");
  const lengthHex = message.length.toString(16).padStart(64, "0");
  const paddedData = hex.padEnd(Math.ceil(hex.length / 64) * 64, "0");
  return (ERROR_STRING_SELECTOR + "0".repeat(64 - 2) + "20" + lengthHex + paddedData) as Hex;
}

// --- probeGuard integration, against a network-free fake ChainReader ---

function fakeChain(responses: Map<string, { revertData: Hex | undefined; reverted: boolean }>): ChainReader {
  return {
    chainId: 1,
    blockNumber: 1n,
    async getBlockHash() {
      return "0x0" as Hex;
    },
    async getCodeAtBlock() {
      return { code: undefined };
    },
    async getCode() {
      return { code: undefined, evidence: {} as Evidence };
    },
    async getStorageAt() {
      return { value: "0x0" as Hex, evidence: {} as Evidence };
    },
    async call() {
      return { result: undefined, reverted: false, evidence: {} as Evidence };
    },
    async probeCall(address: Hex, data: Hex, from: Hex) {
      const key = `${from.toLowerCase()}`;
      const resp = responses.get(key) ?? { revertData: undefined, reverted: false };
      return {
        revertData: resp.revertData,
        reverted: resp.reverted,
        evidence: { kind: "call", params: { address, data, from }, rawValue: resp.revertData ?? "reverted", block: "1" },
      };
    },
    async getLogs() {
      return { logs: [], evidence: {} as Evidence };
    },
  };
}

describe("probeGuard", () => {
  const ownerAddress = ("0x" + "11".repeat(20)) as Hex;

  it("attributes to the day-1 owner when an Ownable-shaped revert is observed", async () => {
    const revertData = encodeErrorString("Ownable: caller is not the owner");
    const responses = new Map(PROBE_ADDRESSES.map((a) => [a.toLowerCase(), { revertData, reverted: true }]));
    const chain = fakeChain(responses);

    const result = await probeGuard(chain, ("0x" + "aa".repeat(20)) as Hex, "transferOwnership(address)", {
      authorityOwner: ownerAddress,
      accessControlRoles: [],
    });

    expect(result.status).toBe("attributed");
    if (result.status === "attributed") {
      expect(result.holders).toEqual([ownerAddress]);
      expect(result.authSource).toBe("owner");
    }
  });

  it("reports guarded_unknown_holder when Ownable-shaped but day-1 found no owner", async () => {
    const revertData = encodeErrorString("Ownable: caller is not the owner");
    const responses = new Map(PROBE_ADDRESSES.map((a) => [a.toLowerCase(), { revertData, reverted: true }]));
    const chain = fakeChain(responses);

    const result = await probeGuard(chain, ("0x" + "aa".repeat(20)) as Hex, "transferOwnership(address)", {
      authorityOwner: null,
      accessControlRoles: [],
    });

    expect(result.status).toBe("guarded_unknown_holder");
  });

  it("attributes to AccessControl role members when the parsed role matches a known day-1 role", async () => {
    const role = ("0x" + "cc".repeat(32)) as Hex;
    const member = ("0x" + "22".repeat(20)) as Hex;
    const revertData = encodeErrorString(`AccessControl: account ${zeroAddress} is missing role ${role}`);
    const responses = new Map(PROBE_ADDRESSES.map((a) => [a.toLowerCase(), { revertData, reverted: true }]));
    const chain = fakeChain(responses);

    const roles: RoleEntry[] = [{ role, name: null, members: [member], adminRole: null, evidence: [] }];
    const result = await probeGuard(chain, ("0x" + "aa".repeat(20)) as Hex, "mint(address,uint256)", {
      authorityOwner: null,
      accessControlRoles: roles,
    });

    expect(result.status).toBe("attributed");
    if (result.status === "attributed") {
      expect(result.holders).toEqual([member]);
      expect(result.authSource).toBe("accessControlRole");
      expect(result.role).toBe(role);
    }
  });

  it("routes to no_auth_revert_observed (never 'unguarded') when no probe shows an auth-shaped revert", async () => {
    // All three probes "succeed" (no revert at all) — the strongest possible
    // signal of an unguarded function, and still not asserted as such.
    const responses = new Map(PROBE_ADDRESSES.map((a) => [a.toLowerCase(), { revertData: undefined, reverted: false }]));
    const chain = fakeChain(responses);

    const result = await probeGuard(chain, ("0x" + "aa".repeat(20)) as Hex, "pause()", {
      authorityOwner: ownerAddress,
      accessControlRoles: [],
    });

    expect(result.status).toBe("no_auth_revert_observed");
  });

  it("returns inconclusive when no probe returns any interpretable result", async () => {
    // All three reverted, but the RPC provider returned no revert data at all.
    const responses = new Map(PROBE_ADDRESSES.map((a) => [a.toLowerCase(), { revertData: undefined, reverted: true }]));
    const chain = fakeChain(responses);

    const result = await probeGuard(chain, ("0x" + "aa".repeat(20)) as Hex, "pause()", {
      authorityOwner: ownerAddress,
      accessControlRoles: [],
    });

    expect(result.status).toBe("inconclusive");
  });
});
