/**
 * A ChainReader decorator that spends one report's read budget.
 *
 * WHY A DECORATOR RATHER THAN A FLAG ON PinnedChain. The budget is a property of
 * ONE ANALYSIS, not of a connection: `ripcord scan` and the webapp worker build a
 * PinnedChain once and could reuse it, while the fork engines deliberately read
 * outside the report's accounting. Wrapping at the top of `buildReport` scopes
 * the budget exactly to the report it bounds, needs no change to how a chain is
 * constructed anywhere, and leaves every detector's signature alone — they still
 * take a plain `ChainReader` and cannot tell the difference.
 *
 * It is a pass-through in every other respect. It changes no value, adds no
 * evidence and reorders nothing; the only thing it can do is refuse to issue a
 * read once the report-wide ceiling is reached, and that refusal is a loud throw
 * (see budget.ts) that lands in `errors[]`.
 *
 * `getLogs` spends TWO dimensions on purpose. Log requests are the one read that
 * scales with a contract's history rather than with its shape, so they are
 * bounded separately as well as counted toward the shared read total — which is
 * what lets `accessControl.ts` ask "how many chunks can this report still
 * afford?" and degrade to a labelled partial instead of aborting a stage.
 */
import type { Hex } from "viem";
import type { AnalysisBudget } from "./budget.js";
import type { ChainReader, Evidence } from "./client.js";

export class BudgetedChainReader implements ChainReader {
  constructor(
    private readonly inner: ChainReader,
    readonly budget: AnalysisBudget,
  ) {}

  get chainId(): number { return this.inner.chainId; }
  get blockNumber(): bigint { return this.inner.blockNumber; }

  private spendRead(where: string): void {
    this.budget.spendOrThrow("chainReads", 1, where);
  }

  // Every method is `async` so a refusal REJECTS rather than throwing
  // synchronously. Callers await these through `Promise.all` and inside
  // `runStage`'s try, and a method whose failure mode changes shape depending on
  // whether the budget was the thing that stopped it is a trap for exactly the
  // error handling this codebase depends on.
  async getBlockHash(): Promise<Hex> {
    this.spendRead("getBlockHash");
    return this.inner.getBlockHash();
  }

  async getCodeAtBlock(address: Hex, blockNumber: bigint): Promise<{ code: Hex | undefined }> {
    this.spendRead(`getCodeAtBlock:${address.toLowerCase()}`);
    return this.inner.getCodeAtBlock(address, blockNumber);
  }

  async getCode(address: Hex): Promise<{ code: Hex | undefined; evidence: Evidence }> {
    this.spendRead(`getCode:${address.toLowerCase()}`);
    return this.inner.getCode(address);
  }

  async getStorageAt(address: Hex, slot: Hex): Promise<{ value: Hex; evidence: Evidence }> {
    this.spendRead(`getStorageAt:${address.toLowerCase()}`);
    return this.inner.getStorageAt(address, slot);
  }

  async call(address: Hex, data: Hex): Promise<{ result: Hex | undefined; reverted: boolean; evidence: Evidence }> {
    this.spendRead(`call:${address.toLowerCase()}`);
    return this.inner.call(address, data);
  }

  async probeCall(
    address: Hex,
    data: Hex,
    from: Hex,
  ): Promise<{ revertData: Hex | undefined; reverted: boolean; evidence: Evidence }> {
    this.spendRead(`probeCall:${address.toLowerCase()}`);
    return this.inner.probeCall(address, data, from);
  }

  async getLogs(params: {
    address: Hex;
    event: string;
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<{ logs: unknown[]; evidence: Evidence }> {
    this.spendRead(`getLogs:${params.address.toLowerCase()}`);
    this.budget.spendOrThrow("logRequests", 1, `getLogs:${params.address.toLowerCase()}`);
    return this.inner.getLogs(params);
  }
}

/**
 * The budget bounding a reader's analysis, or null when the reader is not
 * budgeted.
 *
 * A null is NOT a permissive default dressed up as an answer: it means this
 * reader belongs to no report-wide analysis (a unit test's fake, a fork engine's
 * direct chain), so there is no budget to exhaust and no budget gap to record.
 * Every report goes through `buildReport`, which wraps its reader here, so the
 * bounded path is the one that produces reports.
 */
export function budgetOf(chain: ChainReader): AnalysisBudget | null {
  return chain instanceof BudgetedChainReader ? chain.budget : null;
}
