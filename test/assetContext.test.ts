import { describe, expect, it } from "vitest";
import { encodeFunctionResult, type Hex } from "viem";
import { erc20Abi } from "../src/chain/abi.js";
import { selectMobulaCandidates, verifyDisplayedCandidates } from "../server/asset-context.js";
import type { Evidence } from "../src/chain/client.js";
import type { LiveExposure, LiveHolding } from "../src/live/exposure.js";

const TARGET = "0xc3d688B66703497DAA19211EEdff47f25384cdc3" as Hex;
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

const evidence = (kind: Evidence["kind"], rawValue: unknown): Evidence => ({
  kind,
  params: {},
  rawValue,
  block: "25800000",
});

const holding = (address: string, over: Partial<LiveHolding> = {}): LiveHolding => ({
  chainId: "evm:1",
  address,
  isNative: false,
  unverifiedSymbol: null,
  unverifiedName: null,
  logo: null,
  amount: null,
  valuation: { basis: "unavailable", usd: null },
  holdingsQuoteUsd: null,
  priceQuoteUsd: null,
  liquidityUsd: null,
  chains: [],
  outsideCuratedList: true,
  ...over,
} as LiveHolding);

const exposure = (holdings: LiveHolding[]): LiveExposure => ({
  liveLayerVersion: "0.4.0",
  fetchedAt: "2026-09-04T10:00:00.000Z",
  target: TARGET,
  chainId: 1,
  status: "ok",
  reason: null,
  exposureUsd: null,
  countedHoldings: holdings.length,
  vendorReportedTotalUsd: null,
  holdingsCount: holdings.length,
  chainCount: 1,
  chains: ["evm:1"],
  holdings,
  withheld: [],
  concentration: null,
  floorUsd: 1,
  cap: 12,
  endpoints: { holdings: true, price: true, metadata: true },
  notes: [],
});

describe("post-analysis Mobula candidate verification", () => {
  it("records explicit non-zero and zero balances at the pinned block", async () => {
    const values = new Map([
      [USDC.toLowerCase(), 42n],
      [WETH.toLowerCase(), 0n],
    ]);
    const chain = {
      getCode: async () => ({ code: "0x6000" as Hex, evidence: evidence("bytecode", "0x6000") }),
      call: async (address: Hex) => ({
        result: encodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", result: values.get(address.toLowerCase()) ?? 0n }),
        reverted: false,
        evidence: evidence("call", values.get(address.toLowerCase())?.toString() ?? "0"),
      }),
    };

    const result = await verifyDisplayedCandidates(chain, TARGET, exposure([holding(USDC), holding(WETH)]), 1, "25800000");

    expect(result.map((candidate) => candidate.state)).toEqual(["verified_nonzero", "verified_zero"]);
    expect(result.map((candidate) => candidate.balanceRaw)).toEqual(["42", "0"]);
    expect(result.every((candidate) => candidate.block === "25800000")).toBe(true);
    expect(result.every((candidate) => candidate.evidence.length === 2)).toBe(true);
  });

  it("skips native, other-chain and malformed candidates instead of guessing identity", async () => {
    let reads = 0;
    const chain = {
      getCode: async () => { reads++; return { code: "0x6000" as Hex, evidence: evidence("bytecode", "0x6000") }; },
      call: async () => { reads++; return { result: "0x" as Hex, reverted: false, evidence: evidence("call", "0x") }; },
    };
    const result = await verifyDisplayedCandidates(chain, TARGET, exposure([
      holding("0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", { isNative: true }),
      holding(USDC, { chainId: "evm:8453" }),
      holding("not-an-address"),
    ]), 1, "25800000");
    expect(result).toEqual([]);
    expect(reads).toBe(0);
  });

  it("discovers an unpriced candidate outside the UI display subset and normalises its chain id", async () => {
    const snapshot = exposure([holding(USDC)]);
    snapshot.candidateHoldings = [{
      chainId: "1",
      address: WETH,
      isNative: false,
      unverifiedSymbol: "WETH",
      unverifiedName: "Wrapped Ether",
      holdingsQuoteUsd: null,
    }];
    const chain = {
      getCode: async () => ({ code: "0x6000" as Hex, evidence: evidence("bytecode", "0x6000") }),
      call: async () => ({
        result: encodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", result: 1n }),
        reverted: false,
        evidence: evidence("call", "1"),
      }),
    };

    const result = await verifyDisplayedCandidates(chain, TARGET, snapshot, 1, "25800000");
    expect(result).toHaveLength(1);
    expect(result[0]?.address).toBe(WETH.toLowerCase());
    expect(result[0]?.state).toBe("verified_nonzero");
  });

  it("recognises the native sentinel even when the vendor flag is false", async () => {
    let reads = 0;
    const snapshot = exposure([]);
    snapshot.candidateHoldings = [{
      chainId: "evm:1",
      address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      isNative: false,
      unverifiedSymbol: "ETH",
      unverifiedName: "Ether",
      holdingsQuoteUsd: 1,
    }];
    const chain = {
      getCode: async () => { reads++; return { code: "0x6000" as Hex, evidence: evidence("bytecode", "0x6000") }; },
      call: async () => { reads++; return { result: "0x" as Hex, reverted: false, evidence: evidence("call", "0x") }; },
    };

    expect(await verifyDisplayedCandidates(chain, TARGET, snapshot, 1, "25800000")).toEqual([]);
    expect(reads).toBe(0);
  });

  it("itemises every discovery exclusion and applies one shared independent cap", () => {
    const snapshot = exposure([]);
    const valid = Array.from({ length: 65 }, (_, index) => ({
      chainId: "evm:1",
      address: `0x${(index + 1).toString(16).padStart(40, "0")}`,
      isNative: false,
      unverifiedSymbol: "",
      unverifiedName: "",
      holdingsQuoteUsd: null,
    }));
    snapshot.candidateHoldings = [
      ...valid,
      { ...valid[0]! },
      { ...valid[0]!, chainId: "evm:8453" },
      { ...valid[0]!, address: "bad" },
      { ...valid[0]!, address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", isNative: false },
    ];

    const selection = selectMobulaCandidates(snapshot, 1);
    expect(selection.selected).toHaveLength(64);
    expect(selection.proposed).toBe(69);
    expect(Object.fromEntries(selection.withheld.map((item) => [item.reason, item.count]))).toEqual({
      native: 1,
      other_or_unclear_chain: 1,
      malformed_address: 1,
      duplicate: 1,
      beyond_cap: 1,
    });
  });

  it("keeps a reverted balance call unknown and preserves its evidence", async () => {
    const chain = {
      getCode: async () => ({ code: "0x6000" as Hex, evidence: evidence("bytecode", "0x6000") }),
      call: async () => ({ result: undefined, reverted: true, evidence: evidence("call", "0xdead") }),
    };
    const [candidate] = await verifyDisplayedCandidates(chain, TARGET, exposure([holding(USDC)]), 1, "25800000");
    expect(candidate?.state).toBe("balance_call_reverted");
    expect(candidate?.balanceRaw).toBeNull();
    expect(candidate?.reason).toMatch(/unknown, not zero/i);
    expect(candidate?.evidence).toHaveLength(2);
  });

  it("distinguishes an executed empty return from a revert", async () => {
    // `PinnedChain.call` records a completed-but-empty call as result "0x".
    // Filing that as a revert is KNOWN EDGE #35's conflation: a call that RAN
    // is the stronger observation, and it must not be described as unreadable.
    const chain = {
      getCode: async () => ({ code: "0x6000" as Hex, evidence: evidence("bytecode", "0x6000") }),
      call: async () => ({ result: "0x" as Hex, reverted: false, evidence: evidence("call", "0x") }),
    };
    const [candidate] = await verifyDisplayedCandidates(chain, TARGET, exposure([holding(USDC)]), 1, "25800000");
    expect(candidate?.state).toBe("balance_returned_no_data");
    expect(candidate?.balanceRaw).toBeNull();
    expect(candidate?.reason).toMatch(/executed and returned no data/i);
    expect(candidate?.reason).toMatch(/not a failed read and not a zero balance/i);
  });

  it("records an absent contract as an observation, not a failed read", async () => {
    const chain = {
      getCode: async () => ({ code: undefined, evidence: evidence("bytecode", "0x") }),
      call: async () => { throw new Error("must not be called when there is no code"); },
    };
    const [candidate] = await verifyDisplayedCandidates(chain, TARGET, exposure([holding(USDC)]), 1, "25800000");
    expect(candidate?.state).toBe("not_contract_at_block");
    expect(candidate?.codeBytes).toBe(0);
    expect(candidate?.evidence).toHaveLength(1);
  });

  it("keeps an undecodable balance unknown rather than zero", async () => {
    const chain = {
      getCode: async () => ({ code: "0x6000" as Hex, evidence: evidence("bytecode", "0x6000") }),
      // 8 bytes where a uint256 word belongs.
      call: async () => ({ result: "0xdeadbeefdeadbeef" as Hex, reverted: false, evidence: evidence("call", "0xdeadbeefdeadbeef") }),
    };
    const [candidate] = await verifyDisplayedCandidates(chain, TARGET, exposure([holding(USDC)]), 1, "25800000");
    expect(candidate?.state).toBe("balance_decode_failed");
    expect(candidate?.balanceRaw).toBeNull();
    expect(candidate?.reason).toMatch(/unknown, not zero/i);
  });

  it("reports an infrastructure failure as read_failed and keeps every other candidate", async () => {
    // One candidate failing must never erase or upgrade another's evidence.
    const chain = {
      getCode: async ({ } = {}) => ({ code: "0x6000" as Hex, evidence: evidence("bytecode", "0x6000") }),
      call: async (address: Hex) => {
        if (address.toLowerCase() === USDC.toLowerCase()) throw new Error("fetch failed");
        return {
          result: encodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", result: 7n }),
          reverted: false,
          evidence: evidence("call", "7"),
        };
      },
    };
    const result = await verifyDisplayedCandidates(chain, TARGET, exposure([holding(USDC), holding(WETH)]), 1, "25800000");
    expect(result.map((c) => c.state)).toEqual(["read_failed", "verified_nonzero"]);
    expect(result[0]?.reason).toMatch(/RPC read did not complete/i);
    expect(result[1]?.balanceRaw).toBe("7");
  });

  /**
   * THE CAP MUST NOT BE DECIDED BY THE VENDOR'S ORDERING.
   *
   * Discovery already sees every proposed identity. But these lists are full of
   * airdropped tokens — verified live on Lido's queue, phishing lures included —
   * so if the cap simply took the first N in vendor order, spam that happens to
   * sort early would displace a real collateral asset.
   */
  it("keeps curated major tokens when the cap has to drop something", () => {
    const snapshot = exposure([]);
    // WETH is on the curated list; put it LAST in vendor order, behind enough
    // junk to overflow the cap on its own.
    const junk = Array.from({ length: 70 }, (_, index) => ({
      chainId: "evm:1",
      address: `0xff${(index + 1).toString(16).padStart(38, "0")}`,
      isNative: false,
      unverifiedSymbol: "AIRDROP",
      unverifiedName: "claim rewards",
      holdingsQuoteUsd: null,
    }));
    snapshot.candidateHoldings = [...junk, {
      chainId: "evm:1", address: WETH, isNative: false,
      unverifiedSymbol: "WETH", unverifiedName: "Wrapped Ether", holdingsQuoteUsd: null,
    }];

    const selection = selectMobulaCandidates(snapshot, 1);
    const selected = selection.selected.map((item) => item.address!.toLowerCase());
    expect(selected).toContain(WETH.toLowerCase());
    // And it is FIRST: curated identity outranks vendor position.
    expect(selected[0]).toBe(WETH.toLowerCase());
    expect(Object.fromEntries(selection.withheld.map((i) => [i.reason, i.count])).beyond_cap).toBe(7);
  });

  it("selects the same set twice regardless of the order the vendor returns", () => {
    const build = (addresses: string[]) => {
      const snapshot = exposure([]);
      snapshot.candidateHoldings = addresses.map((address) => ({
        chainId: "evm:1", address, isNative: false,
        unverifiedSymbol: "", unverifiedName: "", holdingsQuoteUsd: null,
      }));
      return selectMobulaCandidates(snapshot, 1).selected.map((item) => item.address!.toLowerCase());
    };
    const addresses = Array.from({ length: 70 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`);
    const forwards = build(addresses);
    const backwards = build([...addresses].reverse());
    // A vendor that reorders its response between two fetches must not change
    // which assets Ripcord verifies.
    expect(backwards).toEqual(forwards);
    expect(forwards).toHaveLength(64);
  });

  it("does not let a vendor price decide which candidates survive the cap", () => {
    const snapshot = exposure([]);
    // Same addresses, opposite valuations. Value must not reorder anything.
    const addresses = Array.from({ length: 70 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`);
    const priced = addresses.map((address, i) => ({
      chainId: "evm:1", address, isNative: false,
      unverifiedSymbol: "", unverifiedName: "", holdingsQuoteUsd: i,
    }));
    snapshot.candidateHoldings = priced;
    const withPrices = selectMobulaCandidates(snapshot, 1).selected.map((i) => i.address!.toLowerCase());

    snapshot.candidateHoldings = priced.map((h) => ({ ...h, holdingsQuoteUsd: null }));
    const withoutPrices = selectMobulaCandidates(snapshot, 1).selected.map((i) => i.address!.toLowerCase());

    expect(withPrices).toEqual(withoutPrices);
  });
});
