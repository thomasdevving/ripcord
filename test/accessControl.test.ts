import { describe, expect, it } from "vitest";
import { encodeAbiParameters, toFunctionSelector, keccak256, toBytes, type Hex } from "viem";
import { detectAccessControl } from "../src/detect/accessControl.js";
import { probeMaxLogRange } from "../src/chain/rpcPreflight.js";
import { ChainReadError, type ChainReader, type Evidence } from "../src/chain/client.js";
import { AnalysisBudget, BudgetExhaustedError, DEFAULT_BUDGET_LIMITS } from "../src/chain/budget.js";
import { BudgetedChainReader } from "../src/chain/budgetedReader.js";

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

/**
 * SINGLE-PASS ROLE REPLAY.
 *
 * Membership used to be reconstructed by scanning the whole collected log stream
 * once PER ROLE — roles x logs, where both factors grow with the same contract,
 * so a governance contract with many roles and a long history paid for the cross
 * product. Replaying once builds every role's membership in one walk.
 *
 * This is a performance change to a function that decides who holds power, so
 * the test that matters is not that it is faster: it is that it produces exactly
 * what the per-role scan produced, INCLUDING the grant/revoke ordering and the
 * raw-string role matching, against a reference implementation written here
 * rather than imported from the code under test.
 */
describe("role replay is single-pass and unchanged", () => {
  const ROLE_A = ("0x" + "11".repeat(32)) as Hex;
  const ROLE_B = ("0x" + "22".repeat(32)) as Hex;
  const u1 = ("0x" + "a1".repeat(20)) as Hex;
  const u2 = ("0x" + "a2".repeat(20)) as Hex;
  const u3 = ("0x" + "a3".repeat(20)) as Hex;

  const grants: SeededGrant[] = [
    { role: ROLE_A, account: u1, block: 10n, kind: "RoleGranted" },
    { role: ROLE_B, account: u2, block: 11n, kind: "RoleGranted" },
    { role: ROLE_A, account: u2, block: 12n, kind: "RoleGranted" },
    { role: ROLE_A, account: u1, block: 13n, kind: "RoleRevoked" },
    { role: ROLE_B, account: u3, block: 14n, kind: "RoleGranted" },
    { role: DEFAULT_ADMIN_ROLE, account: u3, block: 15n, kind: "RoleGranted" },
    // Re-granted after a revoke: the ordering must be respected, not set-unioned.
    { role: ROLE_A, account: u1, block: 16n, kind: "RoleGranted" },
  ];

  /** The OLD shape, kept here as an independent oracle rather than imported. */
  function perRoleReplay(role: Hex): string[] {
    const members = new Set<string>();
    for (const g of [...grants].sort((a, b) => Number(a.block - b.block))) {
      if (g.role !== role) continue;
      if (g.kind === "RoleGranted") members.add(g.account);
      else members.delete(g.account);
    }
    return [...members].sort();
  }

  it("reproduces the per-role result for every role, ordering and revokes included", async () => {
    const chain = fakeChain({
      blockNumber: 1000n,
      maxLogRange: 2_000_000n,
      deploymentBlock: 0n,
      enumerable: false,
      grants,
    });
    const { result } = await detectAccessControl(chain, ("0x" + "78".repeat(20)) as Hex);
    expect(result.reconstruction?.complete).toBe(true);
    for (const role of [ROLE_A, ROLE_B, DEFAULT_ADMIN_ROLE]) {
      const entry = result.roles.find((r) => r.role === role)!;
      expect(entry, `role ${role} missing`).toBeDefined();
      expect([...entry.members].sort()).toEqual(perRoleReplay(role));
    }
    // u1 was granted, revoked, then granted again — present, not absent.
    expect(result.roles.find((r) => r.role === ROLE_A)!.members).toContain(u1);
  });

  it("gives a role with no events an EMPTY membership, not a shared one", async () => {
    // Every role reading from one map is only safe if a role absent from it gets
    // its own empty set; a shared mutable default would leak members between
    // roles, which on this data would be a fabricated power holder.
    const chain = fakeChain({
      blockNumber: 1000n,
      maxLogRange: 2_000_000n,
      deploymentBlock: 0n,
      enumerable: false,
      grants: [{ role: ROLE_A, account: u1, block: 10n, kind: "RoleGranted" }],
    });
    const { result } = await detectAccessControl(chain, ("0x" + "79".repeat(20)) as Hex);
    expect(result.roles.find((r) => r.role === DEFAULT_ADMIN_ROLE)!.members).toEqual([]);
    expect(result.roles.find((r) => r.role === ROLE_A)!.members).toEqual([u1]);
  });
});

/**
 * THE MEMBER CEILING.
 *
 * `getRoleMemberCount` returns a number supplied by the contract under analysis
 * and the enumeration loop is driven by it, so without a ceiling the cost of a
 * report is a value the subject chooses. Capping it is only acceptable because
 * the cap is loud in three places at once: an unknowns entry, a budget
 * exhaustion that reaches the enumeration witness, and — the important one — a
 * reconstruction demoted to `complete: false`.
 *
 * That last one is what stops the worst combination: Enumerable membership is
 * otherwise AUTHORITATIVE, so a truncated list under `complete: true` would let
 * the witness certify a role set provably missing holders, and a missing holder
 * is a missing route in the minimum-notice arithmetic.
 */
describe("member enumeration is bounded, and says so", () => {
  const members = Array.from({ length: 12 }, (_, i) => ("0x" + String(i + 10).repeat(20).slice(0, 40)) as Hex);

  const capped = (roleMembers: number) => {
    const budget = new AnalysisBudget({ ...DEFAULT_BUDGET_LIMITS, roleMembers });
    const chain = new BudgetedChainReader(
      fakeChain({
        blockNumber: 1000n,
        maxLogRange: 2_000_000n,
        deploymentBlock: 0n,
        enumerable: true,
        grants: [],
        enumerableMembers: { [DEFAULT_ADMIN_ROLE.toLowerCase()]: members },
      }),
      budget,
    );
    return { budget, chain };
  };

  it("reads every member when the budget allows it, and stays complete", async () => {
    const { budget, chain } = capped(100);
    const { result } = await detectAccessControl(chain, ("0x" + "80".repeat(20)) as Hex);
    expect(result.roles[0]!.members).toHaveLength(12);
    expect(result.reconstruction?.complete).toBe(true);
    expect(budget.exhausted).toHaveLength(0);
  });

  it("stops at the ceiling, demotes the reconstruction, and records the boundary", async () => {
    const { budget, chain } = capped(5);
    const { result, unknowns } = await detectAccessControl(chain, ("0x" + "81".repeat(20)) as Hex);
    expect(result.roles[0]!.members).toHaveLength(5);
    // Not "5 members", but "at least 5 of 12" — the list is a floor.
    expect(result.reconstruction?.complete).toBe(false);
    expect(result.reconstruction?.confidence).toBe("low");
    expect(result.reconstruction?.note).toMatch(/12 members/);
    expect(unknowns.some((u) => /FLOOR/.test(u.reason))).toBe(true);
    expect(budget.exhausted.some((e) => e.dimension === "roleMembers")).toBe(true);
  });
});

/**
 * THE REPORT-WIDE LOG CEILING.
 *
 * MAX_LOG_REQUESTS bounds what ONE scan may spend. Nothing bounded what all of
 * them spend together, so a target whose authority graph and dependency list
 * reach a dozen AccessControl contracts was entitled to that ceiling a dozen
 * times over, and the report's real limit was however many such contracts
 * happened to be reachable.
 */
describe("the role scan respects what the REPORT has left", () => {
  it("degrades to a labelled partial when the report-wide log budget is the smaller ceiling", async () => {
    // 200 leaves room for the one-off provider preflight probe (a binary search
    // over the accepted range, ~22 requests, memoized per reader) and still
    // leaves far less than the module's own 1500-request ceiling — so the
    // REPORT's remaining budget is the one that binds.
    const budget = new AnalysisBudget({ ...DEFAULT_BUDGET_LIMITS, logRequests: 200 });
    const chain = new BudgetedChainReader(
      fakeChain({
        blockNumber: 100_000n,
        maxLogRange: 10n, // a full history needs far more than 20 requests
        deploymentBlock: 0n,
        enumerable: false,
        grants: [{ role: DEFAULT_ADMIN_ROLE, account: ("0x" + "aa".repeat(20)) as Hex, block: 99_999n, kind: "RoleGranted" }],
      }),
      budget,
    );
    const { result } = await detectAccessControl(chain, ("0x" + "82".repeat(20)) as Hex);
    expect(result.reconstruction?.complete).toBe(false);
    // The note names the ceiling that ACTUALLY bit, not the module constant —
    // quoting 1500 when the report had 178 left would misdescribe why the scan
    // is short, which is the only thing the note exists to say.
    const quoted = /(\d+)-request budget/.exec(result.reconstruction!.note)!;
    expect(quoted).not.toBeNull();
    expect(Number(quoted[1])).toBeLessThan(1500);
    expect(budget.exhausted.some((e) => e.dimension === "logRequests")).toBe(true);
    // It planned AROUND the budget rather than crashing into it: the scan never
    // exceeded what was left, so no read was refused mid-scan.
    expect(budget.consumed("logRequests")).toBeLessThanOrEqual(200);
  });

  it("never lets a budget refusal be read as a provider range rejection", async () => {
    // probeMaxLogRange decides the provider's limit by treating a ChainReadError
    // from getLogs as "that range was rejected". A budget refusal that arrived
    // as a ChainReadError would therefore be interpreted as a narrow provider,
    // and the scan would quietly chunk to a range the provider never named —
    // an infrastructure fact laundered into a fact about the endpoint.
    const budget = new AnalysisBudget({ ...DEFAULT_BUDGET_LIMITS, logRequests: 1 });
    const chain = new BudgetedChainReader(
      fakeChain({ blockNumber: 100_000n, maxLogRange: 10n, deploymentBlock: 0n, enumerable: false, grants: [] }),
      budget,
    );
    await expect(detectAccessControl(chain, ("0x" + "83".repeat(20)) as Hex)).rejects.toThrow(BudgetExhaustedError);
  });
});
