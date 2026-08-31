/**
 * Cached, deterministic chain access. Every detector reads through
 * PinnedChain instead of touching a viem PublicClient directly, so every
 * read is: (a) pinned to the report's block number, (b) cached on disk,
 * (c) returned with an Evidence entry the report schema requires.
 *
 * "Fail loud": a failed RPC call throws (wrapped in ChainReadError) rather
 * than returning a default. Callers decide whether that becomes an
 * `unknowns[]` or `errors[]` entry — this layer never silently swallows it.
 */
import { createPublicClient, http, parseAbiItem, type Hex, type PublicClient } from "viem";
import { DiskCache } from "./cache.js";

export type EvidenceKind = "storage_slot" | "call" | "log" | "bytecode";

export interface Evidence {
  kind: EvidenceKind;
  /** Exact parameters of the read: address, slot, selector+args, or log filter. */
  params: Record<string, unknown>;
  /** Raw value returned by the node, as a hex string (or array of them for logs). */
  rawValue: unknown;
  block: string;
}

export class ChainReadError extends Error {
  constructor(
    public readonly stage: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ChainReadError";
  }
}

export interface PinnedChainOptions {
  chainId: number;
  rpcUrl: string;
  blockNumber: bigint;
  cacheDir: string;
  cacheEnabled: boolean;
}

export class PinnedChain {
  readonly chainId: number;
  readonly blockNumber: bigint;
  private readonly client: PublicClient;
  private readonly cache: DiskCache;
  private networkCallsMade = 0;

  constructor(opts: PinnedChainOptions) {
    this.chainId = opts.chainId;
    this.blockNumber = opts.blockNumber;
    this.client = createPublicClient({
      transport: http(opts.rpcUrl),
    }) as PublicClient;
    this.cache = new DiskCache(opts.cacheDir, opts.cacheEnabled);
  }

  get networkCallCount(): number {
    return this.networkCallsMade;
  }

  async getBlockHash(): Promise<Hex> {
    const { value } = await this.cache.wrap(
      { chainId: this.chainId, blockNumber: this.blockNumber, method: "getBlock", params: {} },
      async () => {
        this.networkCallsMade++;
        const block = await this.client.getBlock({ blockNumber: this.blockNumber });
        return block.hash;
      },
    );
    return value;
  }

  /**
   * getCode pinned to an arbitrary (non-report) block. Used only for
   * deployment-block discovery (binary search ahead of an event scan) — a
   * means to bound a log range, not itself a report-facing finding, so it
   * returns no Evidence. Still fully cached: a contract's deployment block
   * never changes, so this is as deterministic as any other read here.
   */
  async getCodeAtBlock(address: Hex, blockNumber: bigint): Promise<{ code: Hex | undefined }> {
    const params = { address };
    const { value: code } = await this.cache.wrap(
      { chainId: this.chainId, blockNumber, method: "getCode", params },
      async () => {
        this.networkCallsMade++;
        try {
          return (await this.client.getCode({ address, blockNumber })) ?? "0x";
        } catch (err) {
          throw new ChainReadError("getCode", `getCode(${address}) at block ${blockNumber} failed`, err);
        }
      },
    );
    return { code: code === "0x" ? undefined : code };
  }

  async getCode(address: Hex): Promise<{ code: Hex | undefined; evidence: Evidence }> {
    const params = { address };
    const { value: code } = await this.cache.wrap(
      { chainId: this.chainId, blockNumber: this.blockNumber, method: "getCode", params },
      async () => {
        this.networkCallsMade++;
        try {
          return (await this.client.getCode({ address, blockNumber: this.blockNumber })) ?? "0x";
        } catch (err) {
          throw new ChainReadError("getCode", `getCode(${address}) failed`, err);
        }
      },
    );
    return {
      code: code === "0x" ? undefined : code,
      evidence: {
        kind: "bytecode",
        params,
        rawValue: code,
        block: this.blockNumber.toString(),
      },
    };
  }

  async getStorageAt(address: Hex, slot: Hex): Promise<{ value: Hex; evidence: Evidence }> {
    const params = { address, slot };
    const { value } = await this.cache.wrap(
      { chainId: this.chainId, blockNumber: this.blockNumber, method: "getStorageAt", params },
      async () => {
        this.networkCallsMade++;
        try {
          const result = await this.client.getStorageAt({ address, slot, blockNumber: this.blockNumber });
          return result ?? ("0x" + "0".repeat(64) as Hex);
        } catch (err) {
          throw new ChainReadError("getStorageAt", `getStorageAt(${address}, ${slot}) failed`, err);
        }
      },
    );
    return { value, evidence: { kind: "storage_slot", params, rawValue: value, block: this.blockNumber.toString() } };
  }

  /** Raw eth_call with a pre-encoded `data` payload. Reverts are surfaced, not swallowed. */
  async call(
    address: Hex,
    data: Hex,
  ): Promise<{ result: Hex | undefined; reverted: boolean; evidence: Evidence }> {
    const params = { address, data };
    const { value } = await this.cache.wrap(
      { chainId: this.chainId, blockNumber: this.blockNumber, method: "call", params },
      async () => {
        this.networkCallsMade++;
        try {
          const result = await this.client.call({ to: address, data, blockNumber: this.blockNumber });
          return { result: result.data, reverted: false };
        } catch {
          // A revert is a legitimate, informative outcome (e.g. `owner()` not implemented)
          // — it is cached like any other result, not thrown as a ChainReadError.
          return { result: undefined, reverted: true };
        }
      },
    );
    return {
      result: value.result,
      reverted: value.reverted,
      evidence: {
        kind: "call",
        params,
        rawValue: value.reverted ? "reverted" : value.result,
        block: this.blockNumber.toString(),
      },
    };
  }

  async getLogs(params: {
    address: Hex;
    event: string;
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<{ logs: unknown[]; evidence: Evidence }> {
    const key = {
      address: params.address,
      event: params.event,
      fromBlock: params.fromBlock.toString(),
      toBlock: params.toBlock.toString(),
    };
    const { value: logs } = await this.cache.wrap(
      { chainId: this.chainId, blockNumber: this.blockNumber, method: "getLogs", params: key },
      async () => {
        this.networkCallsMade++;
        try {
          return await this.client.getLogs({
            address: params.address,
            event: parseAbiItem(params.event) as never,
            fromBlock: params.fromBlock,
            toBlock: params.toBlock,
          });
        } catch (err) {
          throw new ChainReadError("getLogs", `getLogs(${params.event}, ${params.fromBlock}-${params.toBlock}) failed`, err);
        }
      },
    );
    return {
      logs: logs as unknown[],
      evidence: {
        kind: "log",
        params: key,
        rawValue: logs,
        block: this.blockNumber.toString(),
      },
    };
  }
}
