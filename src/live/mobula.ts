/**
 * Mobula REST client for Ripcord's LIVE layer.
 *
 * THE BOUNDARY THIS FILE SITS ON. Everything else in `src/` produces a report
 * pinned to a block and byte-identical on a cold re-run; this file is the
 * opposite by construction. Nothing in the pinned path imports it, and
 * scripts/verify-boundary.mjs fails the build if that stops being true.
 *
 * WHY NOT PinnedChain: DiskCache is keyed by (chainId, blockNumber, method,
 * params) and justified by "a historical block never changes". A live price has
 * no block and is stale the moment it lands, so caching it under that key would
 * make a warm run serve yesterday's market as today's. No cache, no pinning, and
 * a `fetchedAt` timestamp on every result.
 *
 * FAILURE DISCIPLINE. In the pinned path "fail loud" means throwing; here a
 * vendor outage is not a fact about the contract and must never take down a page
 * whose verdict does not depend on it. Every call returns a discriminated
 * `MobulaResult` carrying its reason, and the loudness moves to the page. What
 * is forbidden is the third option: a silent empty result that looks like "this
 * contract holds nothing".
 */

/** Success carries the payload; failure carries a reason meant to be READ, not swallowed. */
export type MobulaResult<T> = { ok: true; data: T } | { ok: false; reason: string };

/**
 * Hosts, established by probing rather than from the docs — the documentation
 * places the v2 endpoints on `api.mobula.io`, where they 404. Verified live
 * 2026-09-02: `api.mobula.io/api/2/wallet/holdings` returns
 * `{"statusCode":404}`, the same path on `genius-api.mobula.io` returns data.
 * The v1 metadata endpoint is the other way round and lives on `api.mobula.io`.
 */
const V2_HOST = "https://genius-api.mobula.io";
const V1_HOST = "https://api.mobula.io";

/** Both hosts answer keyless at a reduced rate limit, so the key is optional everywhere. */
function authHeaders(): Record<string, string> {
  const key = process.env.MOBULA_API_KEY?.trim();
  return key ? { Authorization: key } : {};
}

const DEFAULT_TIMEOUT_MS = 30_000;
/**
 * Holdings gets its own, much longer budget. A multi-chain sweep over a large
 * wallet is genuinely slow — WETH9's holdings (5,341 entries across 21 chains)
 * take just over 50 SECONDS. The 30s default silently turned that into "live
 * data unavailable" on exactly the biggest targets, and it looked like rate
 * limiting because it arrived alongside real 503s. Measured, not guessed: the
 * mainnet-only variant is slower still, so this is server-side work rather than
 * a transport problem a smaller query would avoid.
 */
const HOLDINGS_TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 4;
/**
 * Backoff base, overridable so the failure-path tests do not have to sit
 * through 14 seconds of real waiting to assert that a failure degrades
 * correctly. Production behaviour is the default; nothing else reads this.
 */
const retryBaseMs = () => Number(process.env.MOBULA_RETRY_BASE_MS ?? 2000);

/**
 * The pseudo-address every major indexer uses to mean "the chain's NATIVE asset"
 * (ETH on mainnet, BNB on BSC, and so on). It is not a contract.
 *
 * Load-bearing for two reasons, both found live. Native balances are the single
 * largest thing Ripcord's curated ERC20 list structurally cannot see — Lido's
 * withdrawal queue holds ~$63M of native ETH. And the sentinel is THE SAME on
 * every chain, so anything keyed on address alone silently merges ETH with BNB:
 * verified on cbETH, where a price map keyed by address quoted ETH at BNB's
 * price. Every lookup in this layer is therefore keyed by (chainId, address).
 */
export const NATIVE_ASSET_SENTINEL = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

export function isNativeAsset(address: string | null | undefined): boolean {
  return !!address && address.toLowerCase() === NATIVE_ASSET_SENTINEL;
}

/** Composite key. Never key a token map on address alone — see the sentinel note. */
export function tokenKey(chainId: string | null | undefined, address: string | null | undefined): string {
  return `${(chainId ?? "?").toLowerCase()}|${(address ?? "?").toLowerCase()}`;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });

/**
 * One HTTP call with a hard timeout and bounded backoff.
 *
 * Retry policy is asymmetric on purpose, the same shape as `withTransientRetry`
 * in the pinned path but with far less at stake: a 429/5xx or a network error is
 * retried with backoff, a 4xx is returned immediately because retrying a bad
 * request just wastes the rate limit. The keyless tier returns HTTP 503 under a
 * burst, which is what a full 22-target run is. The worst case of a wrong call
 * here is a slower "live data unavailable", never a wrong fact.
 */
async function request<T>(
  url: string,
  init: RequestInit,
  what: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  callerSignal?: AbortSignal,
): Promise<MobulaResult<T>> {
  let lastReason = "";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // Checked before the backoff AND before the request, because four attempts
    // with exponential backoff is up to ~14 seconds during which the caller's
    // deadline can pass. A cancelled call must stop cancelled, not come back
    // later with a result nobody is waiting for any more.
    if (callerSignal?.aborted) return { ok: false, reason: `${what}: cancelled before completing` };
    if (attempt > 0) await sleep(retryBaseMs() * 2 ** (attempt - 1), callerSignal);
    if (callerSignal?.aborted) return { ok: false, reason: `${what}: cancelled before completing` };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // The per-attempt timeout and the caller's cancellation are both reasons to
    // stop; whichever fires first aborts the fetch.
    const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
    try {
      const res = await fetch(url, {
        ...init,
        signal,
        headers: { ...authHeaders(), ...(init.headers ?? {}) },
      });
      if (!res.ok) {
        lastReason = `${what}: HTTP ${res.status} ${res.statusText}`.trim();
        if (res.status === 429 || res.status >= 500) continue;
        return { ok: false, reason: lastReason };
      }
      const text = await res.text();
      try {
        return { ok: true, data: JSON.parse(text) as T };
      } catch {
        // A 200 carrying non-JSON is a real failure mode (proxies, captive
        // portals, HTML error pages) and must not be read as an empty result.
        return { ok: false, reason: `${what}: response was not JSON (${text.slice(0, 80)})` };
      }
    } catch (err) {
      if (callerSignal?.aborted) return { ok: false, reason: `${what}: cancelled before completing` };
      lastReason =
        err instanceof Error && err.name === "AbortError"
          ? `${what}: timed out after ${timeoutMs}ms`
          : `${what}: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, reason: lastReason || `${what}: failed after ${MAX_ATTEMPTS} attempts` };
}

// --- endpoint 1: wallet holdings --------------------------------------------

/** One chain's slice of a holding. `chainId` is Mobula's own form, e.g. "evm:1". */
export interface MobulaChainBalance {
  chainId?: string;
  address?: string;
  amount?: number;
  amountUSD?: number;
  priceUSD?: number;
  decimals?: number;
}

export interface MobulaHolding {
  token?: {
    address?: string;
    chainId?: string;
    symbol?: string;
    name?: string;
    decimals?: number;
    priceUSD?: number;
    liquidityUSD?: number;
    logo?: string;
  };
  amount?: number;
  amountUSD?: number;
  allocation?: number;
  chainBalances?: Record<string, MobulaChainBalance>;
}

export interface MobulaHoldingsResponse {
  data?: {
    totalWalletBalanceUSD?: number;
    wallets?: string[];
    holdings?: MobulaHolding[];
  };
}

/**
 * GET /api/2/wallet/holdings — what this address holds RIGHT NOW, across chains.
 *
 * `fetchAllChains` is what makes this multi-chain rather than a second opinion on
 * mainnet: without it Mobula answers over a premium subset. Verified live on
 * Lido's withdrawal queue, which spans 8 distinct `evm:*` chains.
 *
 * `filterSpam`/`minLiquidity` are passed because they help, but are NOT relied
 * on — airdropped phishing tokens survive both. The real filtering is a value
 * floor applied in exposure.ts, where it can be disclosed on the page instead of
 * happening invisibly here.
 */
export async function fetchHoldings(
  wallet: string,
  opts: { minLiquidityUSD?: number; signal?: AbortSignal } = {},
): Promise<MobulaResult<MobulaHoldingsResponse>> {
  const q = new URLSearchParams({
    wallet,
    fetchAllChains: "true",
    filterSpam: "true",
    minLiquidity: String(opts.minLiquidityUSD ?? 10_000),
  });
  return request<MobulaHoldingsResponse>(
    `${V2_HOST}/api/2/wallet/holdings?${q}`,
    { method: "GET" },
    "holdings",
    HOLDINGS_TIMEOUT_MS,
    opts.signal,
  );
}

// --- endpoint 2: batch token price ------------------------------------------

export interface MobulaPriceEntry {
  address?: string;
  chainId?: string;
  name?: string;
  symbol?: string;
  logo?: string;
  priceUSD?: number;
  liquidityUSD?: number;
  marketCapUSD?: number;
  /** Present INSTEAD of the market fields when Mobula could not price this one. */
  error?: string;
}

export interface MobulaPriceResponse {
  payload?: MobulaPriceEntry[];
}

/**
 * POST /api/2/token/price — live USD price for up to 500 (address, chain) pairs.
 *
 * A second, independent read of value rather than a decorative extra call: the
 * holdings endpoint already returns `amountUSD`, and this lets the panel show a
 * separately quoted per-token price plus `liquidityUSD` — live context beside
 * the pinned verdict, never a substitute for the liquidity modelling that is
 * deliberately not there.
 */
export async function fetchPrices(
  items: { address: string; blockchain: string }[],
  opts: { signal?: AbortSignal } = {},
): Promise<MobulaResult<MobulaPriceResponse>> {
  if (items.length === 0) return { ok: true, data: { payload: [] } };
  return request<MobulaPriceResponse>(
    `${V2_HOST}/api/2/token/price`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: items.slice(0, 500) }),
    },
    "price",
    DEFAULT_TIMEOUT_MS,
    opts.signal,
  );
}

// --- endpoint 3: batch metadata ---------------------------------------------

export interface MobulaMetadataEntry {
  data?: {
    id?: number | null;
    name?: string;
    symbol?: string;
    logo?: string | null;
    website?: string | null;
    decimals?: number[];
    contracts?: string[];
    blockchains?: string[];
  };
}

export interface MobulaMetadataResponse {
  data?: MobulaMetadataEntry[];
}

/**
 * GET /api/1/multi-metadata — names and logos for the tokens found above.
 *
 * The readability layer. A holdings row reading `0x2260fac5…` is useless to the
 * non-crypto-native reader this panel is partly for; "Wrapped Bitcoin" with a
 * logo is not. Note this is the v1 host — see the host comment at the top.
 */
export async function fetchMetadata(
  assets: { address: string; blockchain: string }[],
  opts: { signal?: AbortSignal } = {},
): Promise<MobulaResult<MobulaMetadataResponse>> {
  if (assets.length === 0) return { ok: true, data: { data: [] } };
  const q = new URLSearchParams({
    assets: assets.map((a) => a.address).join(","),
    blockchains: assets.map((a) => a.blockchain).join(","),
  });
  return request<MobulaMetadataResponse>(
    `${V1_HOST}/api/1/multi-metadata?${q}`,
    { method: "GET" },
    "metadata",
    DEFAULT_TIMEOUT_MS,
    opts.signal,
  );
}

/**
 * Mobula's `evm:1` → a human chain name for display.
 *
 * Unknown ids render as the raw id rather than as a guess or a blank: the panel
 * saying `evm:9745` is honest and checkable, whereas "Unknown chain" throws away
 * the one piece of information we actually have.
 */
const CHAIN_NAMES: Record<string, string> = {
  "evm:1": "Ethereum",
  "evm:10": "Optimism",
  "evm:56": "BNB Chain",
  "evm:100": "Gnosis",
  "evm:137": "Polygon",
  "evm:8453": "Base",
  "evm:42161": "Arbitrum",
  "evm:43114": "Avalanche",
  "evm:59144": "Linea",
  "evm:534352": "Scroll",
};

export function chainName(chainId: string): string {
  return CHAIN_NAMES[chainId] ?? chainId;
}
