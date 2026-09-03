import { describe, expect, it } from "vitest";
import { priceDelta } from "../src/fork/proofEngine.js";
import type { Evidence } from "../src/chain/client.js";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const;
describe("proof balance and historical price evidence", () => {
  async function value(answer = 100_000_000n, updatedAt = 999_000n) {
    const evidence: Evidence[] = [];
    const fork = { client: {
      readContract: async ({ functionName, blockNumber }) => {
        expect(blockNumber).toBe(100n);
        return functionName === "decimals" ? 8 : [1n, answer, updatedAt, updatedAt, 1n];
      },
      getBlock: async ({ blockNumber }) => { expect(blockNumber).toBe(100n); return { timestamp: 1_000_000n }; },
    } } as any;
    return { delta: await priceDelta(fork, 1, USDC, "USDC", 100_000_000n, 40_000_000n, 6, 100n, evidence), evidence };
  }
  it("preserves observed 100 → 40 balances for a 60-token partial transfer", async () => {
    const { delta, evidence } = await value();
    expect(delta).toMatchObject({ balanceBefore: "100000000", balanceAfter: "40000000", delta: "60000000", usd: 60 });
    expect(evidence[0]?.rawValue).toEqual(["1", "100000000", "999000", "999000", "1"]);
  });
  it.each([0n, -1n])("does not price a non-positive oracle answer (%s)", async (answer) => {
    expect((await value(answer)).delta.usd).toBeNull();
  });
  it.each([0n, 1n, 1_000_001n])("rejects an absent, stale or future timestamp (%s)", async (updatedAt) => {
    expect((await value(100_000_000n, updatedAt)).delta.usd).toBeNull();
  });
});
