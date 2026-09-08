import { describe, expect, it } from "vitest";
import { encodeAbiParameters, toFunctionSelector, type Hex } from "viem";
import { resolveAuthorityGraph, detectTimelock, confidenceForDepth } from "../src/detect/authority.js";
import type { ChainReader, Evidence } from "../src/chain/client.js";
import { AnalysisBudget, DEFAULT_BUDGET_LIMITS } from "../src/chain/budget.js";
import { BudgetedChainReader } from "../src/chain/budgetedReader.js";
import type { RoleEntry } from "../src/report/schema.js";

const OWNER_SEL = toFunctionSelector("owner()");
const GET_MIN_DELAY_SEL = toFunctionSelector("getMinDelay()");
const ev = (): Evidence => ({ kind: "call", params: {}, rawValue: "0x", block: "1" });

function addr(n: number): Hex {
  return ("0x" + n.toString(16).padStart(40, "0")) as Hex;
}
function encAddress(a: Hex): Hex {
  return encodeAbiParameters([{ type: "address" }], [a]) as Hex;
}

interface FakeContract {
  /** address this contract's owner() returns, if any */
  owner?: Hex;
  /** raw call answers keyed by 4-byte selector (overrides owner) */
  calls?: Record<string, Hex>;
  /** getMinDelay() answer (marks it a timelock) */
  minDelay?: bigint;
}

/**
 * Programmable network-free ChainReader. An address present in `contracts`
 * has code (so it classifies as a contract); anything else is a codeless EOA.
 * Only the selectors a test needs are answered; everything else reverts,
 * which is exactly how a real contract behaves for functions it lacks.
 */
function fakeChain(contracts: Record<string, FakeContract>): ChainReader {
  const norm = (a: string) => a.toLowerCase();
  const get = (a: Hex) => contracts[norm(a)];
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
      const c = get(address);
      return {
        code: c ? ("0x60016000" as Hex) : undefined, // non-empty, no DELEGATECALL byte
        evidence: { kind: "bytecode", params: { address }, rawValue: "0x", block: "1" } as Evidence,
      };
    },
    async getStorageAt() {
      return { value: ("0x" + "0".repeat(64)) as Hex, evidence: ev() };
    },
    async call(address: Hex, data: Hex) {
      const c = get(address);
      if (!c) return { result: undefined, reverted: true, evidence: ev() };
      const sel = data.slice(0, 10).toLowerCase();
      if (c.calls && c.calls[sel]) return { result: c.calls[sel], reverted: false, evidence: ev() };
      if (sel === OWNER_SEL.toLowerCase() && c.owner) {
        return { result: encAddress(c.owner), reverted: false, evidence: ev() };
      }
      if (sel === GET_MIN_DELAY_SEL.toLowerCase() && c.minDelay !== undefined) {
        return {
          result: encodeAbiParameters([{ type: "uint256" }], [c.minDelay]) as Hex,
          reverted: false,
          evidence: ev(),
        };
      }
      return { result: undefined, reverted: true, evidence: ev() };
    },
    async probeCall() {
      return { revertData: undefined, reverted: true, evidence: ev() };
    },
    async getLogs() {
      return { logs: [], evidence: ev() };
    },
  };
}

describe("recursive authority resolution", () => {
  it("resolves a ProxyAdmin one hop to its terminal EOA owner", async () => {
    // A (ProxyAdmin contract) owned by B (an EOA, no code).
    const A = addr(0xa);
    const B = addr(0xb);
    const chain = fakeChain({ [A.toLowerCase()]: { owner: B } });

    const { resolution: res } = await resolveAuthorityGraph(chain, [{ address: A, relation: "proxyAdmin" }]);
    expect(res.roots).toHaveLength(1);
    const path = res.paths[0]!;
    expect(path.hops.map((h) => h.address)).toEqual([A, B]);
    expect(path.effectiveController).toBe(B);
    expect(path.effectiveControllerType).toBe("eoa");
    expect(path.terminationReason).toBe("eoa");
    // Reached at depth 2 → medium confidence, not the certainty of a direct owner.
    expect(path.confidence).toBe("medium");
  });

  it("detects a cycle (A owns B owns A) and records it instead of looping", async () => {
    const A = addr(0xaa);
    const B = addr(0xbb);
    const chain = fakeChain({
      [A.toLowerCase()]: { owner: B },
      [B.toLowerCase()]: { owner: A },
    });

    const { resolution: res } = await resolveAuthorityGraph(chain, [{ address: A, relation: "owner" }]);
    expect(res.cyclesDetected.length).toBeGreaterThanOrEqual(1);
    // Walk to the leaf: A(d1) -> B(d2) -> A(d3, cycle)
    const leaf = res.paths[0]!.hops[res.paths[0]!.hops.length - 1]!;
    // The path stops; the cycle node is terminal with reason "cycle".
    const cyc = res.cyclesDetected[0]!;
    expect(cyc.address.toLowerCase()).toBe(A.toLowerCase());
    // No infinite loop implies the test simply returns — reaching here proves it.
    expect(leaf).toBeDefined();
  });

  it("stops at max depth with an explicit reason, never silent truncation", async () => {
    // A(d1) -> B(d2) -> C(d3, max depth) -> D never reached
    const A = addr(0x1a);
    const B = addr(0x1b);
    const C = addr(0x1c);
    const D = addr(0x1d);
    const chain = fakeChain({
      [A.toLowerCase()]: { owner: B },
      [B.toLowerCase()]: { owner: C },
      [C.toLowerCase()]: { owner: D },
      [D.toLowerCase()]: { owner: A },
    });

    const { resolution: res } = await resolveAuthorityGraph(chain, [{ address: A, relation: "owner" }]);
    // Depth-first to C at depth 3, terminating on max_depth.
    let node = res.roots[0]!;
    while (!node.terminal) node = node.children[0]!;
    expect(node.address).toBe(C);
    expect(node.depth).toBe(3);
    expect(node.terminationReason).toBe("max_depth");
    expect(res.paths[0]!.terminationReason).toBe("max_depth");
    // A contract stopped at the cap is NOT a resolved controller.
    expect(res.paths[0]!.effectiveController).toBeNull();
  });

  it("a contract with no identifiable authority terminates as no_authority_found, not clean", async () => {
    const A = addr(0x2a);
    const chain = fakeChain({ [A.toLowerCase()]: {} }); // has code, answers nothing
    const { resolution: res } = await resolveAuthorityGraph(chain, [{ address: A, relation: "proxyAdmin" }]);
    expect(res.roots[0]!.terminationReason).toBe("no_authority_found");
    expect(res.paths[0]!.effectiveController).toBeNull();
  });
});

describe("timelock detection", () => {
  const noRoles: RoleEntry[] = [];

  it("classifies an OZ TimelockController by getMinDelay()", async () => {
    const T = addr(0x7);
    const chain = fakeChain({ [T.toLowerCase()]: { minDelay: 172800n } });
    const tl = await detectTimelock(chain, T, noRoles);
    expect(tl).not.toBeNull();
    expect(tl!.kind).toBe("openzeppelin");
    expect(tl!.delaySeconds).toBe("172800");
  });

  it("returns null for a contract that is not timelock-shaped", async () => {
    const X = addr(0x8);
    const chain = fakeChain({ [X.toLowerCase()]: { owner: addr(0x9) } });
    expect(await detectTimelock(chain, X, noRoles)).toBeNull();
  });

  it("falls back to delay-undetermined when only timelock roles are present", async () => {
    const T = addr(0xab);
    const chain = fakeChain({ [T.toLowerCase()]: {} });
    const roles: RoleEntry[] = [
      { role: ("0x" + "11".repeat(32)) as Hex, name: "PROPOSER_ROLE", members: [], adminRole: null, evidence: [] },
    ];
    const tl = await detectTimelock(chain, T, roles);
    expect(tl).not.toBeNull();
    expect(tl!.kind).toBe("unknown");
    expect(tl!.delaySeconds).toBeNull();
  });
});

describe("confidence degrades with depth", () => {
  it("is high at depth 1, medium at 2, low at 3+", () => {
    expect(confidenceForDepth(1)).toBe("high");
    expect(confidenceForDepth(2)).toBe("medium");
    expect(confidenceForDepth(3)).toBe("low");
    expect(confidenceForDepth(4)).toBe("low");
  });
});

/**
 * THE AUTHORITY-NODE CEILING.
 *
 * The depth cap bounds how FAR a branch travels; nothing bounded how MANY
 * branches exist. A contract with fifty role members, each of which is a
 * contract with fifty of its own, is three perfectly legal hops and thousands of
 * classifications — so the cost of a report was decided by the shape of the
 * target rather than by Ripcord.
 *
 * The whole risk of adding this ceiling is that an unvisited node looks exactly
 * like a resolved one. So: its own termination reason (never folded into
 * `no_authority_found`, which means "we searched and found nothing"), a
 * `contract` type so the exit window routes it to the unresolved branch, an
 * explicit unknowns entry, and a recorded exhaustion that withholds the
 * enumeration witness.
 */
describe("the authority recursion is bounded by node count, and says where it stopped", () => {
  /** A chain of owners N hops long: 1 -> 2 -> 3 -> ... */
  function ownerChain(length: number): Record<string, FakeContract> {
    const contracts: Record<string, FakeContract> = {};
    for (let i = 1; i <= length; i++) contracts[addr(i).toLowerCase()] = { owner: addr(i + 1) };
    return contracts;
  }

  it("resolves normally when the budget is not the binding constraint", async () => {
    const budget = new AnalysisBudget({ ...DEFAULT_BUDGET_LIMITS, authorityNodes: 50 });
    const chain = new BudgetedChainReader(fakeChain(ownerChain(3)), budget);
    const { resolution } = await resolveAuthorityGraph(chain, [{ address: addr(1), relation: "owner" }]);
    expect(budget.exhausted).toHaveLength(0);
    expect(resolution.paths[0]!.terminationReason).not.toBe("budget_exhausted");
  });

  it("stops at the ceiling with its own termination reason, not with 'no authority found'", async () => {
    const budget = new AnalysisBudget({ ...DEFAULT_BUDGET_LIMITS, authorityNodes: 2 });
    const chain = new BudgetedChainReader(fakeChain(ownerChain(4)), budget);
    const { resolution, unknowns } = await resolveAuthorityGraph(chain, [{ address: addr(1), relation: "owner" }]);

    const stopped = (function find(n: (typeof resolution.roots)[number]): typeof n | null {
      if (n.terminationReason === "budget_exhausted") return n;
      for (const c of n.children) { const hit = find(c); if (hit) return hit; }
      return null;
    })(resolution.roots[0]!);

    expect(stopped, "expected a node terminated by the budget").not.toBeNull();
    // A `contract` type is what routes it to the exit window's
    // `unresolved_authority` branch — an eoa/safe/timelock type there would
    // have it contribute a notice figure it never earned.
    expect(stopped!.type).toBe("contract");
    expect(stopped!.children).toEqual([]);
    // "We stopped" must be visible as itself, not inferred from empty children.
    expect(unknowns.some((u) => /authority-node budget/.test(u.reason) && /UNRESOLVED, not clean/.test(u.reason))).toBe(true);
    expect(budget.exhausted.some((e) => e.dimension === "authorityNodes")).toBe(true);
  });

  it("charges each visited node exactly once, whatever its type", async () => {
    const budget = new AnalysisBudget({ ...DEFAULT_BUDGET_LIMITS, authorityNodes: 50 });
    const chain = new BudgetedChainReader(fakeChain(ownerChain(3)), budget);
    await resolveAuthorityGraph(chain, [{ address: addr(1), relation: "owner" }]);
    // Three visits, because MAX_AUTHORITY_DEPTH stops at addr(3) — the node
    // budget counts what the recursion ENTERED, so it never charges for a hop
    // the depth cap already refused.
    expect(budget.consumed("authorityNodes")).toBe(3);
  });

  it("resolves a shared contract ONCE even when two roots point at it", async () => {
    // Two seeds converging on one address: the memoized fact layer means the
    // second arrival reuses the first's proxy/ownership/role analysis instead of
    // re-running an event scan. The RESULT must be unchanged — both roots still
    // resolve, and the shared node still appears on both branches.
    const contracts: Record<string, FakeContract> = {
      [addr(1).toLowerCase()]: { owner: addr(9) },
      [addr(2).toLowerCase()]: { owner: addr(9) },
      [addr(9).toLowerCase()]: { owner: addr(10) },
    };
    const budget = new AnalysisBudget();
    const chain = new BudgetedChainReader(fakeChain(contracts), budget);
    const { resolution } = await resolveAuthorityGraph(chain, [
      { address: addr(1), relation: "owner" },
      { address: addr(2), relation: "proxyAdmin" },
    ]);
    expect(resolution.roots).toHaveLength(2);
    for (const root of resolution.roots) {
      expect(root.children[0]!.address.toLowerCase()).toBe(addr(9).toLowerCase());
      expect(root.children[0]!.children[0]!.address.toLowerCase()).toBe(addr(10).toLowerCase());
    }
    // Both branches genuinely walked the shared node, so it is charged on both —
    // the budget counts VISITS, which is what bounds a wide graph.
    expect(budget.consumed("authorityNodes")).toBe(6);
  });
});
