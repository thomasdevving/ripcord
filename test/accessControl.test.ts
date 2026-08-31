import { describe, expect, it } from "vitest";
import { encodeAbiParameters, toFunctionSelector, keccak256, toBytes, type Hex } from "viem";
import { detectAccessControl } from "../src/detect/accessControl.js";
import { probeMaxLogRange } from "../src/chain/rpcPreflight.js";
import { ChainReadError, type ChainReader, type Evidence } from "../src/chain/client.js";

const DEFAULT_ADMIN_ROLE = ("0x" + "00".repeat(32)) as Hex;
const DEFAULT_ADMIN_ROLE_SEL = toFunctionSelector("DEFAULT_ADMIN_ROLE()");
const GET_ROLE_MEMBER_COUNT_SEL = toFunctionSelector("getRoleMemberCount(bytes32)");
const GET_ROLE_ADMIN_SEL = toFunctionSelector("getRoleAdmin(bytes32)");
const ev = (): Evidence => ({ kind: "call", params: {}, rawValue: "0x", block: "1" });

interface SeededGrant {
  role: Hex;
  account: Hex;
  block: bigint;
  kind: "RoleGranted" | "RoleRevoked";
}

interface FakeOpts {
  blockNumber: bigint;
  /** Max eth_getLogs block range the fake provider accepts; larger requests throw ChainReadError. */
  maxLogRange: bigint;
  deploymentBlock: bigint;
  enumerable: boolean;
  grants: SeededGrant[];
  /** For the enumerable path: current authoritative membership per role. */
  enumerableMembers?: Record<string, Hex[]>;
}

function fakeChain(opts: FakeOpts): ChainReader {
  return {
    chainId: 1,
    blockNumber: opts.blockNumber,
    async getBlockHash() {
      return "0x0" as Hex;
    },
    async getCodeAtBlock(_address: Hex, block: bigint) {
      return { code: block >= opts.deploymentBlock ? ("0x6001" as Hex) : undefined };
    },
    async getCode(address: Hex) {
      return { code: "0x6001" as Hex, evidence: { kind: "bytecode", params: { address }, rawValue: "0x", block: "1" } as Evidence };
    },
    async getStorageAt() {
      return { value: ("0x" + "0".repeat(64)) as Hex, evidence: ev() };
    },
    async call(_address: Hex, data: Hex) {
      const sel = data.slice(0, 10).toLowerCase();
      if (sel === DEFAULT_ADMIN_ROLE_SEL.toLowerCase()) {
        return { result: encodeAbiParameters([{ type: "bytes32" }], [DEFAULT_ADMIN_ROLE]), reverted: false, evidence: ev() };
      }
      if (sel === GET_ROLE_MEMBER_COUNT_SEL.toLowerCase()) {
        if (!opts.enumerable) return { result: undefined, reverted: true, evidence: ev() };
        // decode role arg
        const role = ("0x" + data.slice(10, 74)) as Hex;
        const members = opts.enumerableMembers?.[role.toLowerCase()] ?? [];
        return { result: encodeAbiParameters([{ type: "uint256" }], [BigInt(members.length)]), reverted: false, evidence: ev() };
      }
      if (sel === toFunctionSelector("getRoleMember(bytes32,uint256)").toLowerCase()) {
        const role = ("0x" + data.slice(10, 74)) as Hex;
        const idx = Number(BigInt("0x" + data.slice(74, 138)));
        const m = (opts.enumerableMembers?.[role.toLowerCase()] ?? [])[idx]!;
        return { result: encodeAbiParameters([{ type: "address" }], [m]), reverted: false, evidence: ev() };
      }
      if (sel === GET_ROLE_ADMIN_SEL.toLowerCase()) {
        return { result: encodeAbiParameters([{ type: "bytes32" }], [DEFAULT_ADMIN_ROLE]), reverted: false, evidence: ev() };
      }
      return { result: undefined, reverted: true, evidence: ev() };
    },
    async probeCall() {
      return { revertData: undefined, reverted: true, evidence: ev() };
    },
    async getLogs(params) {
      const span = params.toBlock - params.fromBlock;
      if (span > opts.maxLogRange) {
        throw new ChainReadError("getLogs", `range ${span} exceeds provider cap ${opts.maxLogRange}`);
      }
      const wantGranted = params.event.includes("RoleGranted");
      const logs = opts.grants
        .filter((g) => (wantGranted ? g.kind === "RoleGranted" : g.kind === "RoleRevoked"))
        .filter((g) => g.block >= params.fromBlock && g.block <= params.toBlock)
        .map((g, i) => ({
          args: { role: g.role, account: g.account, sender: g.account },
          eventName: g.kind,
          blockNumber: g.block,
          logIndex: i,
        }));
      return { logs, evidence: ev() };
    },
  };
}

describe("adaptive getLogs role reconstruction", () => {
  const acctRecent = ("0x" + "aa".repeat(20)) as Hex;
  const acctOld = ("0x" + "bb".repeat(20)) as Hex;

  it("probeMaxLogRange binary-searches the provider's real limit", async () => {
    const chain = fakeChain({ blockNumber: 100_000n, maxLogRange: 137n, deploymentBlock: 0n, enumerable: false, grants: [] });
    expect(await probeMaxLogRange(chain)).toBe(137n);
  });

  it("full scan: complete reconstruction, high confidence, all grants captured", async () => {
    const chain = fakeChain({
      blockNumber: 1000n,
      maxLogRange: 2_000_000n, // generous: whole history in one chunk
      deploymentBlock: 0n,
      enumerable: false,
      grants: [{ role: DEFAULT_ADMIN_ROLE, account: acctRecent, block: 100n, kind: "RoleGranted" }],
    });
    const { result } = await detectAccessControl(chain, ("0x" + "12".repeat(20)) as Hex);
    expect(result.detected).toBe(true);
    expect(result.method).toBe("event_reconstruction");
    expect(result.reconstruction?.complete).toBe(true);
    expect(result.reconstruction?.confidence).toBe("high");
    const admin = result.roles.find((r) => r.role === DEFAULT_ADMIN_ROLE)!;
    expect(admin.members).toContain(acctRecent);
  });

  it("partial scan: labelled complete=false, low confidence, older grant honestly missed", async () => {
    const chain = fakeChain({
      blockNumber: 100_000n,
      maxLogRange: 5n, // tiny cap → full history exceeds the request budget
      deploymentBlock: 0n,
      enumerable: false,
      grants: [
        { role: DEFAULT_ADMIN_ROLE, account: acctOld, block: 100n, kind: "RoleGranted" }, // before the covered window
        { role: DEFAULT_ADMIN_ROLE, account: acctRecent, block: 99_000n, kind: "RoleGranted" }, // inside it
      ],
    });
    const { result, unknowns } = await detectAccessControl(chain, ("0x" + "34".repeat(20)) as Hex);
    expect(result.reconstruction?.complete).toBe(false);
    expect(result.reconstruction?.confidence).toBe("low");
    expect(result.reconstruction?.maxLogRange).toBe("5");
    // The covered window starts well after deployment — stated, not hidden.
    expect(BigInt(result.reconstruction!.scannedFromBlock!)).toBeGreaterThan(0n);
    expect(result.reconstruction?.note).toMatch(/partial/i);
    // A partial reconstruction surfaces an explicit unknowns entry.
    expect(unknowns.some((u) => /partial/i.test(u.reason))).toBe(true);
    // The recent grant is captured; the old one is honestly missed (not fabricated as present).
    const admin = result.roles.find((r) => r.role === DEFAULT_ADMIN_ROLE)!;
    expect(admin.members).toContain(acctRecent);
    expect(admin.members).not.toContain(acctOld);
  });

  it("enumerable + partial discovery: membership authoritative, confidence only medium", async () => {
    const chain = fakeChain({
      blockNumber: 100_000n,
      maxLogRange: 5n,
      deploymentBlock: 0n,
      enumerable: true,
      grants: [{ role: DEFAULT_ADMIN_ROLE, account: acctRecent, block: 99_000n, kind: "RoleGranted" }],
      enumerableMembers: { [DEFAULT_ADMIN_ROLE.toLowerCase()]: [acctRecent, acctOld] },
    });
    const { result } = await detectAccessControl(chain, ("0x" + "56".repeat(20)) as Hex);
    expect(result.method).toBe("enumerable");
    expect(result.reconstruction?.complete).toBe(false);
    // Enumerable getters are authoritative for membership, so a partial DISCOVERY
    // scan is medium, not low — both members are present despite the partial window.
    expect(result.reconstruction?.confidence).toBe("medium");
    const admin = result.roles.find((r) => r.role === DEFAULT_ADMIN_ROLE)!;
    const lowered = admin.members.map((m) => m.toLowerCase());
    expect(lowered).toEqual(expect.arrayContaining([acctRecent.toLowerCase(), acctOld.toLowerCase()]));
  });
});
