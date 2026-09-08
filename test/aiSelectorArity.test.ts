import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import {
  ARITY_PROBE_SENDER,
  arityCompatibility,
  deriveArity,
  probeCalldataArity,
  staticWordCount,
} from "../server/ai-selector/arity.js";
import { ChainReadError, type ChainReader, type Evidence } from "../src/chain/client.js";
import type { AiArityOutcome } from "../server/shared/ai-selector.js";

const SELECTOR: Hex = "0x44c35d07";
const TARGET: Hex = ("0x" + "aa".repeat(20)) as Hex;

const obs = (outcomes: AiArityOutcome[]) => outcomes.map((outcome, words) => ({ words, outcome }));

/** Replies keyed by the number of zero argument words in the calldata. */
function fakeChain(byWords: Map<number, { reverted: boolean; revertData?: Hex } | "throw">): ChainReader {
  return {
    chainId: 1,
    blockNumber: 100n,
    async getBlockHash() { return "0x0" as Hex; },
    async getCodeAtBlock() { return { code: undefined }; },
    async getCode() { return { code: undefined, evidence: {} as Evidence }; },
    async getStorageAt() { return { value: "0x0" as Hex, evidence: {} as Evidence }; },
    async call() { return { result: undefined, reverted: false, evidence: {} as Evidence }; },
    async probeCall(address: Hex, data: Hex, from: Hex) {
      const words = (data.length - 10) / 64;
      const reply = byWords.get(words);
      if (reply === "throw") throw new ChainReadError("probeCall", "infrastructure failure");
      const resolved = reply ?? { reverted: true, revertData: undefined };
      return {
        revertData: resolved.revertData,
        reverted: resolved.reverted,
        evidence: { kind: "call", params: { address, data, from, words }, rawValue: resolved.revertData ?? "reverted", block: "100" } as Evidence,
      };
    },
    async getLogs() { return { logs: [], evidence: {} as Evidence }; },
  };
}

describe("deriveArity — a boundary is a positive claim", () => {
  it("reads an empty-revert prefix followed by a revert with data as a minimum word count", () => {
    const arity = deriveArity(obs(["empty_revert", "empty_revert", "empty_revert", "empty_revert", "empty_revert", "revert_with_data", "revert_with_data"]));
    expect(arity.status).toBe("minimum_words_observed");
    expect(arity.minimumWords).toBe(5);
  });

  it("accepts an execution, not only a revert, as the end of the prefix", () => {
    const arity = deriveArity(obs(["empty_revert", "executed"]));
    expect(arity).toMatchObject({ status: "minimum_words_observed", minimumWords: 1 });
  });

  it("establishes nothing when every length reverts without data", () => {
    const arity = deriveArity(obs(["empty_revert", "empty_revert", "empty_revert"]));
    expect(arity.status).toBe("undetermined");
    expect(arity.minimumWords).toBeNull();
  });

  it("establishes nothing when data comes back at zero arguments, because no boundary was crossed", () => {
    const arity = deriveArity(obs(["revert_with_data", "revert_with_data"]));
    expect(arity).toMatchObject({ status: "undetermined", minimumWords: null });
  });

  it("refuses a non-monotonic sequence rather than picking the first transition", () => {
    // A plain calldata-size check cannot start failing again once satisfied, so
    // this shape is not a decoder boundary and must not be read as one.
    const arity = deriveArity(obs(["empty_revert", "revert_with_data", "empty_revert", "revert_with_data"]));
    expect(arity).toMatchObject({ status: "undetermined", minimumWords: null });
  });

  it("collapses to undetermined when any single length failed as infrastructure", () => {
    const arity = deriveArity(obs(["empty_revert", "read_failed", "revert_with_data"]));
    expect(arity).toMatchObject({ status: "undetermined", minimumWords: null });
    expect(arity.note).toContain("infrastructure");
  });

  it("records every probed length even when it concludes nothing", () => {
    const arity = deriveArity(obs(["empty_revert", "empty_revert"]));
    expect(arity.observations).toHaveLength(2);
  });

  it("reports not_probed rather than a conclusion when nothing ran", () => {
    expect(deriveArity([])).toMatchObject({ status: "not_probed", minimumWords: null });
  });
});

describe("probeCalldataArity", () => {
  it("sends 0..maxWords zero words from the fixed sender and derives the boundary", async () => {
    const chain = fakeChain(new Map<number, { reverted: boolean; revertData?: Hex }>([
      [0, { reverted: true }], [1, { reverted: true }], [2, { reverted: true }],
      [3, { reverted: true }], [4, { reverted: true }],
      [5, { reverted: true, revertData: "0x82b42900" }],
    ]));
    const { arity, evidence } = await probeCalldataArity(chain, TARGET, SELECTOR, { maxWords: 5 });

    expect(arity).toMatchObject({ status: "minimum_words_observed", minimumWords: 5 });
    expect(evidence).toHaveLength(6);
    expect(evidence[5]!.params).toMatchObject({ from: ARITY_PROBE_SENDER, words: 5 });
    // 4 selector bytes + 5 * 32 argument bytes.
    expect(String((evidence[5]!.params as Record<string, unknown>).data)).toHaveLength(2 + 8 + 5 * 64);
  });

  it("records an infrastructure failure as read_failed instead of as a contract answer", async () => {
    const chain = fakeChain(new Map<number, { reverted: boolean; revertData?: Hex } | "throw">([
      [0, { reverted: true }],
      [1, "throw"],
      [2, { reverted: true, revertData: "0xdeadbeef" }],
    ]));
    const { arity } = await probeCalldataArity(chain, TARGET, SELECTOR, { maxWords: 2 });
    expect(arity.observations.map((o) => o.outcome)).toEqual(["empty_revert", "read_failed", "revert_with_data"]);
    expect(arity.status).toBe("undetermined");
  });
});

describe("arityCompatibility — deprioritises, and only in the safe direction", () => {
  const observed = deriveArity(obs(["empty_revert", "empty_revert", "empty_revert", "empty_revert", "empty_revert", "revert_with_data"]));

  it("flags a proposal that needs fewer words than the decoder demands", () => {
    expect(arityCompatibility(1, observed)).toBe("mismatch_observed");
  });

  it("accepts an exact match", () => {
    expect(arityCompatibility(5, observed)).toBe("compatible_observed");
  });

  it("does NOT flag a longer proposal, because trailing calldata is ignored and the boundary is a lower bound", () => {
    expect(arityCompatibility(7, observed)).toBe("compatible_observed");
  });

  it("stays unknown when no boundary was observed", () => {
    expect(arityCompatibility(5, deriveArity(obs(["empty_revert", "empty_revert"])))).toBe("unknown");
    expect(arityCompatibility(5, null)).toBe("unknown");
  });

  it("stays unknown for a signature whose static width cannot be compared", () => {
    expect(arityCompatibility(null, observed)).toBe("unknown");
  });
});

describe("staticWordCount", () => {
  it("counts static types", () => {
    expect(staticWordCount(["bool", "bool", "bool", "bool", "bool"])).toBe(5);
    expect(staticWordCount(["address", "uint256"])).toBe(2);
    expect(staticWordCount([])).toBe(0);
  });

  it("refuses to answer for a dynamic type, where the head is an offset and carries no arity", () => {
    for (const types of [["bytes"], ["string"], ["uint256[]"], ["address", "tuple"]]) {
      expect(staticWordCount(types)).toBeNull();
    }
  });
});
