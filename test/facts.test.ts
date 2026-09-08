/**
 * THE SHARED FACT LAYER.
 *
 * Memoization is a correctness risk before it is a performance win: a cache that
 * returns a right-looking answer computed for a slightly different question is
 * worse than the recomputation it saves. So the load-bearing case here is not
 * "it is faster" but "a memoized result is deep-equal to a freshly computed one"
 * — the property that lets every existing detector test keep meaning what it
 * meant.
 *
 * The second property is scoping. The store is keyed on the READER, and a reader
 * carries its own pinned block, so two readers at different blocks share
 * nothing. That is what makes the key correct by construction rather than by a
 * hand-written composite key someone could forget a component of.
 */
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, toFunctionSelector, type Hex } from "viem";
import { ContractFacts, factsFor } from "../src/detect/facts.js";
import { detectProxy } from "../src/detect/proxy.js";
import { detectOwnership } from "../src/detect/ownership.js";
import type { ChainReader, Evidence } from "../src/chain/client.js";

const ev = (): Evidence => ({ kind: "call", params: {}, rawValue: "0x", block: "1" });
const A = ("0x" + "aa".repeat(20)) as Hex;
const B = ("0x" + "bb".repeat(20)) as Hex;
const OWNER = ("0x" + "cc".repeat(20)) as Hex;
const OWNER_SEL = toFunctionSelector("owner()");

/** Minimal WETH-like runtime with a real dispatcher, so selector extraction has something to recover. */
const CODE = "0x6080604052348015600f57600080fd5b506004361060325760003560e01c80638da5cb5b146037578063f2fde38b146051575b600080fd5b603d6059565b005b605760645b005b565b565b" as Hex;

interface Counts { getCode: number; call: number; storage: number }

function countingChain(counts: Counts, blockNumber = 100n): ChainReader {
  return {
    chainId: 1,
    blockNumber,
    async getBlockHash() { return "0xhash" as Hex; },
    async getCodeAtBlock() { return { code: CODE }; },
    async getCode(address: Hex) {
      counts.getCode++;
      return { code: CODE, evidence: { kind: "bytecode", params: { address }, rawValue: CODE, block: String(blockNumber) } as Evidence };
    },
    async getStorageAt() {
      counts.storage++;
      return { value: ("0x" + "0".repeat(64)) as Hex, evidence: ev() };
    },
    async call(_address: Hex, data: Hex) {
      counts.call++;
      if (data.slice(0, 10).toLowerCase() === OWNER_SEL.toLowerCase()) {
        return { result: encodeAbiParameters([{ type: "address" }], [OWNER]), reverted: false, evidence: ev() };
      }
      return { result: undefined, reverted: true, evidence: ev() };
    },
    async probeCall() { return { revertData: undefined, reverted: true, evidence: ev() }; },
    async getLogs() { return { logs: [], evidence: ev() }; },
  };
}

describe("a memoized fact equals a freshly computed one", () => {
  it("proxy detection: same result whether or not it came from the store", async () => {
    const direct = await detectProxy(countingChain({ getCode: 0, call: 0, storage: 0 }), A);
    const facts = new ContractFacts(countingChain({ getCode: 0, call: 0, storage: 0 }));
    expect(await facts.proxy(A)).toEqual(direct);
    // And the SECOND read of the same address is the same value again, not a
    // partially-populated one — the promise is memoized, so there is no window
    // in which a caller can observe a half-built result.
    expect(await facts.proxy(A)).toEqual(direct);
  });

  it("ownership detection: same result", async () => {
    const direct = await detectOwnership(countingChain({ getCode: 0, call: 0, storage: 0 }), A);
    const facts = new ContractFacts(countingChain({ getCode: 0, call: 0, storage: 0 }));
    expect(await facts.ownership(A)).toEqual(direct);
    // Checksummed by viem's decoder, as everywhere else in the codebase.
    expect((await facts.ownership(A)).owner.address?.toLowerCase()).toBe(OWNER.toLowerCase());
  });
});

describe("a fact is computed once per address", () => {
  it("collapses repeated code reads for one address", async () => {
    const counts = { getCode: 0, call: 0, storage: 0 };
    const facts = new ContractFacts(countingChain(counts));
    await facts.code(A);
    await facts.code(A);
    await facts.code(A);
    expect(counts.getCode).toBe(1);
  });

  it("keeps different addresses apart", async () => {
    const counts = { getCode: 0, call: 0, storage: 0 };
    const facts = new ContractFacts(countingChain(counts));
    await facts.code(A);
    await facts.code(B);
    expect(counts.getCode).toBe(2);
    expect(facts.stats().code).toBe(2);
  });

  it("treats an address as one address whatever its casing", async () => {
    const counts = { getCode: 0, call: 0, storage: 0 };
    const facts = new ContractFacts(countingChain(counts));
    await facts.code(A);
    await facts.code(A.toUpperCase().replace("0X", "0x") as Hex);
    expect(counts.getCode).toBe(1);
  });

  it("shares ONE computation between concurrent callers, not two", async () => {
    // The promise is stored before the first await; storing the resolved value
    // instead would let two concurrent callers both start, and the cheapest
    // possible bug — a second identical scan — is also the hardest to notice.
    const counts = { getCode: 0, call: 0, storage: 0 };
    const facts = new ContractFacts(countingChain(counts));
    const [one, two] = await Promise.all([facts.selectors(A), facts.selectors(A)]);
    expect(counts.getCode).toBe(1);
    expect(one).toEqual(two);
  });

  it("derives selectors from the memoized code rather than re-fetching it", async () => {
    const counts = { getCode: 0, call: 0, storage: 0 };
    const facts = new ContractFacts(countingChain(counts));
    await facts.code(A);
    const dispatch = await facts.selectors(A);
    expect(counts.getCode).toBe(1);
    expect(dispatch.recognized).toBe(true);
  });

  it("reports no selectors as UNRECOGNIZED, never as an empty surface", async () => {
    const counts = { getCode: 0, call: 0, storage: 0 };
    const chain = { ...countingChain(counts), async getCode() { return { code: undefined, evidence: ev() }; } } as ChainReader;
    const dispatch = await new ContractFacts(chain).selectors(A);
    // "No bytecode" is not "nothing callable" — the fail-closed contract in
    // dispatcher.ts, preserved through the fact layer.
    expect(dispatch.recognized).toBe(false);
  });
});

describe("the store is scoped to a reader, so it is scoped to a pinned block", () => {
  it("gives one reader the same store every time", () => {
    const chain = countingChain({ getCode: 0, call: 0, storage: 0 });
    expect(factsFor(chain)).toBe(factsFor(chain));
  });

  it("never shares between two readers, which is what keeps blocks apart", async () => {
    const atBlock100 = countingChain({ getCode: 0, call: 0, storage: 0 }, 100n);
    const atBlock200 = countingChain({ getCode: 0, call: 0, storage: 0 }, 200n);
    expect(factsFor(atBlock100)).not.toBe(factsFor(atBlock200));

    const counts200 = { getCode: 0, call: 0, storage: 0 };
    await factsFor(atBlock100).code(A);
    await factsFor(countingChain(counts200, 200n)).code(A);
    expect(counts200.getCode).toBe(1); // the block-100 entry did not answer for block 200
  });
});
