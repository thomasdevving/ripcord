/**
 * The SEMANTIC cache audit, as tests.
 *
 * The determinism gate (cold report == warm report) catches the STRUCTURAL
 * failure mode: a cache miss and a hit differing in type or shape. It cannot
 * catch the semantic one. A read that FAILED, recorded consistently as an
 * "absent fact", is byte-identical cold and warm and still completely wrong —
 * and it is the more dangerous of the two, because roughly twenty detectors
 * downstream read a revert as a fact about the CONTRACT.
 *
 * So these tests assert one property, at every layer that can express it:
 *
 *   a read that could not be performed must reach the report as UNKNOWN or as
 *   an ERROR, and must never reach it as an ABSENCE.
 */
import { describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeAbiParameters, toFunctionSelector, type Hex } from "viem";
import { ChainReadError, PinnedChain, looksLikeContractRevert, type ChainReader, type Evidence } from "../src/chain/client.js";
import { detectOwnership } from "../src/detect/ownership.js";
import { detectAccessControl } from "../src/detect/accessControl.js";
import { resolveAuthorityGraph } from "../src/detect/authority.js";
import { detectDependencies } from "../src/detect/dependencies.js";
import { deriveEnumerationCompleteness, witnessOf } from "../src/report/enumeration.js";

const ev = (): Evidence => ({ kind: "call", params: {}, rawValue: "0x", block: "1" });
const ZERO32 = ("0x" + "00".repeat(32)) as Hex;

// ---------------------------------------------------------------------------
// 1. The classifier, pinned to error objects observed LIVE against a real
//    provider during the audit. These are not invented shapes: each was
//    reproduced and its cause chain printed before this test was written.
// ---------------------------------------------------------------------------
describe("looksLikeContractRevert — positive identification of a contract revert", () => {
  // viem nests: CallExecutionError -> ExecutionRevertedError -> RpcRequestError -> raw
  const revertWithErrorString = {
    name: "CallExecutionError",
    details: "execution reverted: ERC20: transfer amount exceeds allowance",
    cause: {
      name: "ExecutionRevertedError",
      details: "execution reverted: ERC20: transfer amount exceeds allowance",
      cause: { name: "RpcRequestError", code: 3, data: "0x08c379a0", details: "execution reverted: ERC20: transfer amount exceeds allowance" },
    },
  };
  // KNOWN EDGE #4's real case: USDT.pause() — a revert carrying NO data at all.
  const revertNoData = {
    name: "CallExecutionError",
    details: "execution reverted",
    cause: { name: "ExecutionRevertedError", details: "execution reverted", cause: { name: "RpcRequestError", code: 3, details: "execution reverted" } },
  };
  // sUSDe.renounceRole() — a custom-error revert (OperationNotAllowed()).
  const revertCustomError = {
    name: "CallExecutionError",
    details: "execution reverted",
    cause: { name: "ExecutionRevertedError", details: "execution reverted", cause: { name: "RpcRequestError", code: 3, data: "0xf50a3b52", details: "execution reverted" } },
  };

  it.each([
    ["Error(string) revert", revertWithErrorString],
    ["revert with NO data (KNOWN EDGE #4)", revertNoData],
    ["custom-error revert", revertCustomError],
  ])("recognises a genuine revert: %s", (_label, err) => {
    expect(looksLikeContractRevert(err)).toBe(true);
  });

  // The three infrastructure failures reproduced live. Every one of them
  // matched NO transient pattern, which is why the old fail-open classifier
  // cached all three as "this function reverted".
  const badApiKey = {
    name: "CallExecutionError",
    details: "Must be authenticated!",
    cause: { name: "InvalidRequestRpcError", code: -32600, details: "Must be authenticated!", cause: { code: -32600, message: "Must be authenticated!" } },
  };
  const unreachableHost = {
    name: "CallExecutionError",
    details: "fetch failed",
    cause: { name: "HttpRequestError", details: "fetch failed", cause: { name: "TypeError", message: "fetch failed", cause: { message: "bad port" } } },
  };
  const blockNotFound = {
    name: "CallExecutionError",
    details: "block not found: 0x174876e7ff",
    cause: { name: "ResourceNotFoundRpcError", code: -32001, details: "block not found: 0x174876e7ff", cause: { code: -32001, message: "block not found: 0x174876e7ff" } },
  };

  it.each([
    ["a bad/expired API key", badApiKey],
    ["an unreachable endpoint", unreachableHost],
    ["a block the node does not have (a NON-ARCHIVE provider, every read here is historical)", blockNotFound],
  ])("refuses to call an infrastructure failure a revert: %s", (_label, err) => {
    expect(looksLikeContractRevert(err)).toBe(false);
  });

  it("does not treat a gas-configuration failure as a contract decision", () => {
    // viem's own nodeMessage regex also matches "gas required exceeds
    // allowance". That is a gas problem, not the contract rejecting the call,
    // and reading it as a revert would rebuild the bug in miniature.
    expect(looksLikeContractRevert({ name: "CallExecutionError", details: "gas required exceeds allowance (0)" })).toBe(false);
  });

  it("is fail-closed on a completely unrecognised failure", () => {
    // The whole point of the inversion: the residual set is unbounded, so an
    // unknown failure must be an error, not an absence.
    expect(looksLikeContractRevert({ name: "SomethingNobodyHasMetYet", message: "???" })).toBe(false);
    expect(looksLikeContractRevert(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. The WIRING, end to end through PinnedChain and the disk cache. The bug was
//    never in a predicate — it was in which way the predicate was pointed — so
//    the predicate test above is not sufficient on its own.
// ---------------------------------------------------------------------------
describe("PinnedChain.call — a failed read is never cached as a revert", () => {
  async function withStubRpc<T>(rpcError: unknown, fn: (chain: PinnedChain, cacheDir: string) => Promise<T>): Promise<T> {
    const server: Server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const { id } = JSON.parse(body);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id, error: rpcError }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const cacheDir = await mkdtemp(join(tmpdir(), "ripcord-audit-"));
    try {
      const chain = new PinnedChain({
        chainId: 1,
        rpcUrl: `http://127.0.0.1:${port}`,
        blockNumber: 25800000n,
        cacheDir,
        cacheEnabled: true,
      });
      return await fn(chain, cacheDir);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }

  const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as Hex;
  const OWNER_SEL = toFunctionSelector("owner()") as Hex;

  it("returns reverted:true for a genuine revert, and caches it as evidence", async () => {
    await withStubRpc({ code: 3, message: "execution reverted", data: "0xf50a3b52" }, async (chain, cacheDir) => {
      const r = await chain.call(WETH, OWNER_SEL);
      expect(r.reverted).toBe(true);
      // A revert IS a fact about the contract, so it is legitimately cached.
      const written = await readdir(join(cacheDir, "1", "25800000", "call")).catch(() => []);
      expect(written.length).toBe(1);
    });
  });

  it("recognises a revert carrying no data at all (KNOWN EDGE #4 stays intact)", async () => {
    await withStubRpc({ code: 3, message: "execution reverted" }, async (chain) => {
      const r = await chain.call(WETH, OWNER_SEL);
      expect(r.reverted).toBe(true);
    });
  });

  it.each([
    ["a bad API key", { code: -32600, message: "Must be authenticated!" }],
    ["a block the node does not have", { code: -32001, message: "block not found: 0x1868a0c0" }],
    ["an unrecognised provider failure", { code: -32099, message: "upstream shard unavailable" }],
  ])("THROWS ChainReadError instead of manufacturing an absence: %s", async (_label, rpcError) => {
    await withStubRpc(rpcError, async (chain, cacheDir) => {
      await expect(chain.call(WETH, OWNER_SEL)).rejects.toThrow(ChainReadError);
      // And — the part that made this class of bug permanent — nothing is
      // written to disk, so a failed read cannot poison every future run.
      const written = await readdir(join(cacheDir, "1", "25800000", "call")).catch(() => []);
      expect(written.length).toBe(0);
    });
  });

  it("applies the same rule to probeCall, where a wrong answer degrades a guard forever", async () => {
    await withStubRpc({ code: -32600, message: "Must be authenticated!" }, async (chain) => {
      await expect(chain.probeCall(WETH, OWNER_SEL, WETH)).rejects.toThrow(ChainReadError);
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Each detector path named in the audit, at the layer that decides.
// ---------------------------------------------------------------------------

/** A ChainReader whose every read fails the way a broken provider fails. */
function brokenChain(stage = "call"): ChainReader {
  const boom = () => {
    throw new ChainReadError(stage, "eth_call failed without any positive sign of a contract revert");
  };
  return {
    chainId: 1,
    blockNumber: 100n,
    async getBlockHash() { return "0x0" as Hex; },
    async getCodeAtBlock() { return boom(); },
    async getCode() { return boom(); },
    async getStorageAt() { return boom(); },
    async call() { return boom(); },
    async probeCall() { return boom(); },
    async getLogs() { return boom(); },
  };
}

describe("owner() — a failed read is not 'no owner exists'", () => {
  it("propagates a ChainReadError rather than reporting owner: null", async () => {
    // ownership.ts maps a REVERT to `address: null` ("does not implement it"),
    // which is correct and is the whole reason the client layer must never
    // hand it an infrastructure failure dressed as a revert. If it ever does,
    // this contract silently acquires "no owner" — the false-clean.
    await expect(detectOwnership(brokenChain(), "0x00000000000000000000000000000000000000ab")).rejects.toThrow(ChainReadError);
  });

  it("still reports a genuine revert as an explicit, evidence-carrying null", async () => {
    const chain: ChainReader = { ...brokenChain(), async call() { return { result: undefined, reverted: true, evidence: ev() }; } };
    const { owner } = await detectOwnership(chain, "0x00000000000000000000000000000000000000ab");
    expect(owner.address).toBeNull();
    expect(owner.source).toMatch(/reverted or returned no data/);
    expect(owner.evidence.length).toBe(1); // never a bare null
  });
});

describe("the role scan — a failed scan is not 'no roles'", () => {
  const AC = "0x00000000000000000000000000000000000000ac" as Hex;
  const DEFAULT_ADMIN_ROLE_SEL = toFunctionSelector("DEFAULT_ADMIN_ROLE()");

  /** AccessControl detection succeeds, but the getLogs replay behind it fails. */
  function chainWithFailingLogs(): ChainReader {
    return {
      chainId: 1,
      blockNumber: 1000n,
      async getBlockHash() { return "0x0" as Hex; },
      async getCodeAtBlock(_a: Hex, b: bigint) { return { code: b >= 10n ? ("0x6001" as Hex) : undefined }; },
      async getCode(address: Hex) { return { code: "0x6001" as Hex, evidence: { kind: "bytecode", params: { address }, rawValue: "0x", block: "1" } as Evidence }; },
      async getStorageAt() { return { value: ZERO32, evidence: ev() }; },
      async call(_addr: Hex, data: Hex) {
        if (data.startsWith(DEFAULT_ADMIN_ROLE_SEL)) return { result: ZERO32, reverted: false, evidence: ev() };
        return { result: undefined, reverted: true, evidence: ev() };
      },
      async probeCall() { return { revertData: undefined, reverted: true, evidence: ev() }; },
      async getLogs() { throw new ChainReadError("getLogs", "provider rejected the log query"); },
    };
  }

  it("at depth 0: throws so build.ts records it in errors[], rather than returning roles: []", async () => {
    await expect(detectAccessControl(chainWithFailingLogs(), AC)).rejects.toThrow(ChainReadError);
  });

  it("at depth >= 1 (RECURSION): still throws — the .catch(() => null) is gone and must stay gone", async () => {
    // This is the seam that produced the consolidation-pass bug: authority.ts
    // used to swallow this into `null`, turning a network outage into a silent
    // "no roles / no authority found" on every contract the recursion walked.
    // A failure one hop DOWN is exactly as dangerous as one at the target.
    await expect(
      resolveAuthorityGraph(chainWithFailingLogs(), [{ address: AC, relation: "owner" }]),
    ).rejects.toThrow(ChainReadError);
  });

  it("records an unknown when Enumerable membership cannot be read for a role", async () => {
    // Enumerability was already POSITIVELY established on DEFAULT_ADMIN_ROLE,
    // so a later revert is an anomaly, not the ordinary "not Enumerable" case.
    // members: [] would read as "nobody holds it" — a route that vanishes.
    const countSel = toFunctionSelector("getRoleMemberCount(bytes32)");
    let seenCount = 0;
    const chain: ChainReader = {
      chainId: 1,
      blockNumber: 20n,
      async getBlockHash() { return "0x0" as Hex; },
      async getCodeAtBlock(_a: Hex, b: bigint) { return { code: b >= 1n ? ("0x6001" as Hex) : undefined }; },
      async getCode(address: Hex) { return { code: "0x6001" as Hex, evidence: { kind: "bytecode", params: { address }, rawValue: "0x", block: "1" } as Evidence }; },
      async getStorageAt() { return { value: ZERO32, evidence: ev() }; },
      async call(_addr: Hex, data: Hex) {
        if (data.startsWith(DEFAULT_ADMIN_ROLE_SEL)) return { result: ZERO32, reverted: false, evidence: ev() };
        if (data.startsWith(countSel)) {
          seenCount++;
          // First call (the Enumerable probe) succeeds; the per-role read reverts.
          if (seenCount === 1) return { result: encodeAbiParameters([{ type: "uint256" }], [0n]), reverted: false, evidence: ev() };
          return { result: undefined, reverted: true, evidence: ev() };
        }
        return { result: undefined, reverted: true, evidence: ev() };
      },
      async probeCall() { return { revertData: undefined, reverted: true, evidence: ev() }; },
      async getLogs() { return { logs: [], evidence: { kind: "log", params: {}, rawValue: [], block: "1" } as Evidence }; },
    };
    const { unknowns } = await detectAccessControl(chain, AC);
    expect(unknowns.some((u) => /membership is UNKNOWN, not empty/.test(u.reason))).toBe(true);
  });
});

describe("the dependency graph — a failed balance read is not 'nothing held'", () => {
  it("records an unknown instead of silently skipping a curated major token", async () => {
    // Every MAJOR_TOKENS entry was verified live as a working ERC20, so a
    // revert on balanceOf is an anomaly. Skipping quietly would report the
    // target as holding nothing — which also removes that token's own
    // privileged capabilities from the report and can flip the disclosure gate.
    const chain: ChainReader = {
      chainId: 1,
      blockNumber: 100n,
      async getBlockHash() { return "0x0" as Hex; },
      async getCodeAtBlock() { return { code: "0x6001" as Hex }; },
      async getCode(address: Hex) { return { code: undefined, evidence: { kind: "bytecode", params: { address }, rawValue: "0x", block: "1" } as Evidence }; },
      async getStorageAt() { return { value: ZERO32, evidence: ev() }; },
      async call() { return { result: undefined, reverted: true, evidence: ev() }; },
      async probeCall() { return { revertData: undefined, reverted: true, evidence: ev() }; },
      async getLogs() { return { logs: [], evidence: { kind: "log", params: {}, rawValue: [], block: "1" } as Evidence }; },
    };
    const { unknowns } = await detectDependencies(chain, "0x00000000000000000000000000000000000000ab");
    const balanceUnknowns = unknowns.filter((u) => /the holding is UNKNOWN, not zero/.test(u.reason));
    expect(balanceUnknowns.length).toBeGreaterThan(0);
  });
});

/** A fully-evaluated privileged surface with nobody privileged over it — isolates these cases to the stage property they test. */
const cleanSurface = () => ({
  capabilities: {
    taxonomyVersion: "test",
    dispatcherRecognized: true,
    scannedAddress: "0x00000000000000000000000000000000000000aa" as Hex,
    probedAddress: "0x00000000000000000000000000000000000000aa" as Hex,
    selectorsExtracted: 0,
    unmatchedSelectors: [],
    findings: [],
    needsManualVerification: [],
    evidence: [],
  },
  owner: { address: null, source: "owner() reverted", evidence: [] },
  pendingOwner: { address: null, source: "pendingOwner() reverted", evidence: [] },
  proxy: { pattern: "not_a_proxy", isProxy: false, implementation: null, beacon: null, admin: null, evidence: [] },
  indirection: null,
}) as unknown as Pick<Parameters<typeof deriveEnumerationCompleteness>[0], "capabilities" | "owner" | "pendingOwner" | "proxy" | "indirection">;

describe("the enumeration witness — a failed stage can never support a reassuring claim", () => {
  it("turns a stage error into a gap, and the gap withholds the witness", () => {
    const e = deriveEnumerationCompleteness({
      accessControl: { detected: false, method: "not_applicable", roles: [], reconstruction: null },
      authorityResolution: { maxDepth: 3, roots: [], paths: [], cyclesDetected: [] },
      dependencies: { tokens: [], oracles: [] },
      errors: [{ stage: "accessControl", message: "eth_call failed without any positive sign of a contract revert" }],
      ...cleanSurface(),
    });
    expect(e.complete).toBe(false);
    expect(witnessOf(e)).toBeNull(); // `binding` / `immutable_within_checks` become unconstructable
    expect(e.gaps[0]!.site).toEqual({ kind: "stage", id: "accessControl" });
  });

  it("reads the failure from errors[], never from the fallback value that replaced it", () => {
    // The fallback for a thrown accessControl stage is `detected: false`, which
    // is shaped exactly like a real "not an AccessControl contract". Judging the
    // VALUE would call that complete; judging errors[] is what makes it a gap.
    const clean = deriveEnumerationCompleteness({
      accessControl: { detected: false, method: "not_applicable", roles: [], reconstruction: null },
      authorityResolution: { maxDepth: 3, roots: [], paths: [], cyclesDetected: [] },
      dependencies: { tokens: [], oracles: [] },
      errors: [],
      ...cleanSurface(),
    });
    expect(clean.complete).toBe(true);
  });
});
