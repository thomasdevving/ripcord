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

/**
 * The subset of PinnedChain's public surface detectors depend on. Extracted
 * so tests can pass a network-free fake in place of a real PinnedChain (a
 * plain object literal can't satisfy a class type with private fields, so
 * detectors are typed against this interface rather than the concrete
 * class). PinnedChain is the only production implementation.
 */
export interface ChainReader {
  readonly chainId: number;
  readonly blockNumber: bigint;
  getBlockHash(): Promise<Hex>;
  getCodeAtBlock(address: Hex, blockNumber: bigint): Promise<{ code: Hex | undefined }>;
  getCode(address: Hex): Promise<{ code: Hex | undefined; evidence: Evidence }>;
  getStorageAt(address: Hex, slot: Hex): Promise<{ value: Hex; evidence: Evidence }>;
  call(address: Hex, data: Hex): Promise<{ result: Hex | undefined; reverted: boolean; evidence: Evidence }>;
  /**
   * Same as `call`, but from an explicit sender and surfacing the raw
   * revert payload instead of discarding it — needed to parse an
   * AccessControl/Ownable auth-revert shape for guard probing. Kept
   * separate from `call` rather than adding an optional `from` there: every
   * existing caller of `call` wants ABI-decoded results and explicitly
   * doesn't care about revert bytes, and conflating the two would make it
   * easy to accidentally drop revert data that guard probing depends on.
   */
  probeCall(
    address: Hex,
    data: Hex,
    from: Hex,
  ): Promise<{ revertData: Hex | undefined; reverted: boolean; evidence: Evidence }>;
  getLogs(params: {
    address: Hex;
    event: string;
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<{ logs: unknown[]; evidence: Evidence }>;
}

/**
 * Bounded retry for TRANSIENT network failures (day 4, resolving KNOWN EDGE
 * #13's deferred work).
 *
 * The AccessControl role scan can fire ~1500 `eth_getLogs` requests against a
 * range-capped provider. On a rate-limited endpoint a single 429 among them
 * raised a ChainReadError that — correctly, per "fail loud" — aborted the whole
 * stage, so an ordinary scan needed several manual re-runs to complete. That is
 * honest but useless, and it was blocking real validation.
 *
 * The reason this was deferred was the worry that a transient 429 cannot be
 * told from a permanent failure reliably. That worry is answered by making the
 * classification ASYMMETRIC rather than accurate:
 *   - Something that looks transient is retried a bounded number of times.
 *     If it was actually permanent, we fail loud anyway, just later.
 *   - Anything else fails immediately, exactly as before.
 * So a misclassification in either direction costs time, never correctness, and
 * no result is ever softened into a default. Crucially this is NOT a catch that
 * swallows: after the last attempt the original error is rethrown unchanged.
 *
 * A provider's getLogs RANGE rejection must NOT be caught here — probeMaxLogRange
 * binary-searches on exactly that rejection, and retrying it would triple the
 * cost of every scan's preflight. Range errors do not match the patterns below.
 */
const TRANSIENT_PATTERNS = [
  /429/,
  /rate.?limit/i,
  /too many requests/i,
  /timeout/i,
  /timed out/i,
  /ETIMEDOUT/,
  /ECONNRESET/,
  /ECONNREFUSED/,
  /socket hang up/i,
  /service unavailable/i,
  /bad gateway/i,
  /\b50[0234]\b/,
];

function looksTransient(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 10; depth++) {
    const message = (cur as { message?: unknown }).message;
    if (typeof message === "string" && TRANSIENT_PATTERNS.some((p) => p.test(message))) return true;
    const status = (cur as { status?: unknown }).status;
    if (typeof status === "number" && (status === 429 || status >= 500)) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

const RETRY_ATTEMPTS = 4;
const RETRY_BASE_MS = 400;

/** Runs `fn`, retrying only transient-looking failures with exponential backoff. Rethrows the ORIGINAL error when attempts run out. */
async function withTransientRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!looksTransient(err) || attempt === RETRY_ATTEMPTS - 1) throw err;
      await new Promise((r) => setTimeout(r, RETRY_BASE_MS * 2 ** attempt));
    }
  }
  throw lastError;
}

/**
 * Positively identifies a CONTRACT REVERT — the day-6 semantic-audit fix, and
 * the most load-bearing few lines in this file.
 *
 * THE BUG THIS CLOSES. Until now `call`/`probeCall` asked the opposite
 * question: "does this failure look TRANSIENT?" If not, the failure was
 * recorded — and permanently CACHED — as `reverted: true`. That is fail-OPEN,
 * and it matters because roughly twenty call sites downstream read a revert as
 * a fact about the CONTRACT: `owner()` reverted therefore no owner,
 * `DEFAULT_ADMIN_ROLE()` reverted therefore not AccessControl, `balanceOf()`
 * reverted therefore nothing held. An infrastructure failure that slipped
 * through the transient patterns became, silently and permanently, an absence.
 *
 * This is not hypothetical. Three realistic failures were reproduced live
 * against a real provider during the day-6 audit, and NONE of them matched a
 * single transient pattern:
 *
 *   bad/expired API key   -32600  "Must be authenticated!"
 *   unreachable endpoint  (none)  "fetch failed" / "bad port"
 *   block not available   -32001  "block not found: 0x…"
 *
 * The third is the one to dwell on: every Ripcord read is pinned to a
 * HISTORICAL block, so a non-archive endpoint fails exactly this way — and
 * would have produced a complete, schema-valid, confidently clean report in
 * which every contract has no owner, no roles, and no capabilities. The
 * determinism gate cannot catch it either: such a report is byte-identical
 * cold and warm, because the failure is consistent. It is precisely the
 * false-clean result this project exists to make impossible, reached through
 * the cache rather than through a detector, and it is the FIFTH defect to
 * enter through this boundary.
 *
 * THE FIX IS THE INVERSION, not a longer pattern list. Adding "Must be
 * authenticated" and friends to TRANSIENT_PATTERNS would fix these three and
 * leave the class wide open, because the residual is unbounded: it is every
 * failure mode of every provider nobody has met yet. So the question is
 * inverted to the fail-CLOSED direction — a result is a revert only when
 * something positively says so; everything else is infrastructure and throws.
 * Same discipline as `report/enumeration.ts`'s `=== true`: completeness, and
 * now revert-ness, is a positive claim.
 *
 * WHAT COUNTS AS POSITIVE, all four derived from live observation rather than
 * memory (`scripts/audit-error-shapes.ts` reproduces the table):
 *   1. raw revert bytes anywhere in the cause chain — only the EVM makes those;
 *   2. viem's own `ExecutionRevertedError` in the chain;
 *   3. an RPC error carrying EIP-1474 code 3 ("execution error");
 *   4. the node's own message saying `execution reverted`.
 * Every genuine revert observed carries 2, 3 and 4 together — including the
 * ones with NO revert data at all (KNOWN EDGE #4's USDT case) and custom-error
 * reverts (sUSDe's `OperationNotAllowed()`), which is what makes the tight
 * classifier safe for the existing calibration set rather than merely
 * theoretically better.
 *
 * DELIBERATELY EXCLUDED: viem's `nodeMessage` regex also matches "gas required
 * exceeds allowance", which is a gas-configuration failure, not a contract
 * decision. Reading it as a revert would reintroduce the bug in miniature.
 *
 * THE COST IS THE RIGHT WAY ROUND. A genuine revert phrased in some way all
 * four tests miss now becomes a loud `errors[]` entry instead of a silent
 * absence: visible, arguable, and blocking a reassuring verdict through the
 * enumeration witness. Wrong in the safe direction, which is the whole trade
 * this project makes everywhere else.
 */
const REVERT_MESSAGE = /execution reverted/i;

/** Exported for direct unit testing against the exact error objects observed live. */
export function looksLikeContractRevert(err: unknown): boolean {
  if (extractRevertData(err) !== undefined) return true;
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 10; depth++) {
    const e = cur as { name?: unknown; code?: unknown; details?: unknown; message?: unknown };
    if (e.name === "ExecutionRevertedError") return true;
    if (e.code === 3) return true;
    if (typeof e.details === "string" && REVERT_MESSAGE.test(e.details)) return true;
    if (typeof e.message === "string" && REVERT_MESSAGE.test(e.message)) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/** Walks a thrown error's `.cause` chain looking for raw revert bytes (viem nests the RPC error several levels deep). */
function extractRevertData(err: unknown): Hex | undefined {
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 10; depth++) {
    const data = (cur as { data?: unknown }).data;
    if (typeof data === "string" && data.startsWith("0x")) return data as Hex;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

export class PinnedChain implements ChainReader {
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

  get cacheHitCount(): number { return this.cache.hits; }

  get networkCallCount(): number {
    return this.networkCallsMade;
  }

  async getBlockHash(): Promise<Hex> {
    const { value } = await this.cache.wrap(
      { chainId: this.chainId, blockNumber: this.blockNumber, method: "getBlock", params: {} },
      async () => {
        this.networkCallsMade++;
        try {
          const block = await this.client.getBlock({ blockNumber: this.blockNumber });
          return block.hash;
        } catch (err) { throw new ChainReadError("getBlock", `block header at ${this.blockNumber} could not be read`, err); }
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
          return await withTransientRetry(async () => (await this.client.getCode({ address, blockNumber })) ?? "0x");
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
          return await withTransientRetry(async () => (await this.client.getCode({ address, blockNumber: this.blockNumber })) ?? "0x");
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
          const result = await withTransientRetry(() =>
            this.client.getStorageAt({ address, slot, blockNumber: this.blockNumber }),
          );
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
          const result = await withTransientRetry(() =>
            this.client.call({ to: address, data, blockNumber: this.blockNumber }),
          );
          return { result: result.data, reverted: false };
        } catch (err) {
          // A revert is a legitimate, informative outcome (e.g. `owner()` not
          // implemented) — it is cached like any other result, not thrown as a
          // ChainReadError.
          //
          // But an INFRASTRUCTURE failure must never take that path, because
          // ~20 detectors downstream read a revert as a fact about the
          // CONTRACT. Day 4 narrowed this catch from unconditional to
          // "transient-looking failures throw" (KNOWN EDGE #14); day 6's
          // semantic audit INVERTED it, because the day-4 shape was still
          // fail-open — a bad API key, an unreachable host and a
          // block-not-found all matched no transient pattern and were being
          // cached as "this function reverted." Now the revert must be
          // positively identified; anything else is infrastructure and lands
          // in errors[] where it belongs. See looksLikeContractRevert.
          if (!looksLikeContractRevert(err)) {
            throw new ChainReadError(
              "call",
              `eth_call(${address}) failed without any positive sign of a contract revert — treated as an infrastructure failure, not as "this function reverted"`,
              err,
            );
          }
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
        // `?? "0x"` matters: a successful call that returns no data (common
        // for non-view functions probed via eth_call) has `result ===
        // undefined`, and JSON.stringify silently drops undefined-valued
        // keys — evidence with a missing rawValue reads as "something went
        // wrong" rather than "call succeeded, no return data."
        rawValue: value.reverted ? "reverted" : (value.result ?? "0x"),
        block: this.blockNumber.toString(),
      },
    };
  }

  /**
   * eth_call from an explicit (attacker-unrelated) sender, keeping the raw
   * revert payload instead of discarding it. This is a plain historical
   * read pinned to the report's block — not a fork simulation — so it goes
   * through the same disk cache as every other read here. Whether a node
   * returns revert data on eth_call failure is provider-dependent; when it
   * doesn't, `revertData` comes back undefined and callers must treat that
   * as inconclusive, not as "no revert occurred."
   */
  async probeCall(
    address: Hex,
    data: Hex,
    from: Hex,
  ): Promise<{ revertData: Hex | undefined; reverted: boolean; evidence: Evidence }> {
    const params = { address, data, from };
    const { value } = await this.cache.wrap(
      { chainId: this.chainId, blockNumber: this.blockNumber, method: "probeCall", params },
      async () => {
        this.networkCallsMade++;
        try {
          const result = await withTransientRetry(() =>
            this.client.call({ to: address, data, account: from, blockNumber: this.blockNumber }),
          );
          return { reverted: false, revertData: undefined as Hex | undefined, result: result.data };
        } catch (err) {
          // Same rule as `call` above, and it bites harder here. Caching an
          // infrastructure failure as `reverted: true, revertData: undefined`
          // is indistinguishable from "the provider returned no revert data"
          // (KNOWN EDGE #4) — so a guard probe would be permanently, silently
          // degraded to inconclusive, and a capability would be routed to
          // needsManualVerification for a reason that was never true. The
          // no-data revert IS still recognised: it was reproduced live on
          // USDT.pause() and carries code 3 + "execution reverted" even with
          // an empty payload, so edge #4's real case is unaffected.
          if (!looksLikeContractRevert(err)) {
            throw new ChainReadError(
              "probeCall",
              `eth_call(${address}) probe failed without any positive sign of a contract revert — treated as an infrastructure failure, not as "this function reverted"`,
              err,
            );
          }
          return { reverted: true, revertData: extractRevertData(err), result: undefined as Hex | undefined };
        }
      },
    );
    return {
      revertData: value.revertData,
      reverted: value.reverted,
      evidence: {
        kind: "call",
        params,
        rawValue: value.reverted ? (value.revertData ?? "reverted") : (value.result ?? "0x"),
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
          return await withTransientRetry(() =>
            this.client.getLogs({
              address: params.address,
              event: parseAbiItem(params.event) as never,
              fromBlock: params.fromBlock,
              toBlock: params.toBlock,
            }),
          );
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
