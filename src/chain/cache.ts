/**
 * On-disk cache for RPC reads, keyed by (chainId, blockNumber, method, params).
 * Every read Ripcord performs is pinned to a historical block, so a cached
 * result is permanently valid — there is no invalidation logic here on
 * purpose. This is what makes `pnpm ripcord scan` reproducible: a warm cache
 * makes zero network calls, and — because a miss is normalized to the shape a
 * hit returns (see `wrap`) — a COLD run and a warm run are byte-identical.
 * Verified day 4 by wiping the cache and re-running all eight fixtures.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface CacheKey {
  chainId: number;
  /** "latest" reads are never cached — only reads pinned to a specific block are. */
  blockNumber: bigint;
  method: string;
  params: unknown;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/**
 * The stable identity of a cache entry. DELIBERATELY a pure function of
 * (chainId, blockNumber, method, params) and NOTHING about the RPC provider —
 * this is what makes cached output provider-independent: the same pinned read
 * against Alchemy, Infura, or a public node resolves to the identical key, so a
 * warm cache built with one provider is a valid, byte-identical hit for
 * another. If a provider ever needs to be part of a key, it must be added here
 * consciously (and would break that guarantee); test/cache.test.ts pins this.
 */
export function cacheKeyFingerprint(key: CacheKey): string {
  const raw = stableStringify({
    chainId: key.chainId,
    blockNumber: key.blockNumber.toString(),
    method: key.method,
    params: key.params,
  });
  return createHash("sha256").update(raw).digest("hex");
}

function keyToPath(cacheDir: string, key: CacheKey): string {
  const hash = cacheKeyFingerprint(key);
  return join(
    cacheDir,
    String(key.chainId),
    key.blockNumber.toString(),
    key.method,
    `${hash}.json`,
  );
}

/**
 * Round-trips a freshly-fetched value through the same serialization `set` uses,
 * so a cache miss and a cache hit are indistinguishable to every caller: bigints
 * become strings and `undefined` object properties are dropped, exactly as
 * reading the entry back off disk would produce.
 *
 * A top-level `undefined` passes through untouched — `JSON.stringify` returns
 * `undefined` for it, which `JSON.parse` cannot consume.
 */
export function normalizeToCachedShape<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(
    JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
  ) as T;
}

export class DiskCache {
  hits = 0;
  constructor(
    private readonly cacheDir: string,
    private readonly enabled: boolean,
  ) {}

  async get<T>(key: CacheKey): Promise<{ hit: true; value: T } | { hit: false }> {
    if (!this.enabled) return { hit: false };
    const path = keyToPath(this.cacheDir, key);
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as { value: T };
      return { hit: true, value: parsed.value };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { hit: false };
      throw err;
    }
  }

  async set<T>(key: CacheKey, value: T): Promise<void> {
    if (!this.enabled) return;
    const path = keyToPath(this.cacheDir, key);
    await mkdir(dirname(path), { recursive: true });
    const entry = {
      key: {
        chainId: key.chainId,
        blockNumber: key.blockNumber.toString(),
        method: key.method,
        params: key.params,
      },
      value,
      cachedAt: new Date().toISOString(),
    };
    const serialized = JSON.stringify(
      entry,
      (_k, v) => (typeof v === "bigint" ? v.toString() : v),
      2,
    );
    const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, serialized, "utf8");
    await rename(temporary, path);
  }

  /**
   * Wraps a fetch function with get/set — the single place cache semantics live.
   *
   * THE INVARIANT: a cache MISS must return exactly what a later cache HIT
   * would. Without normalization it did not, and the difference was a TYPE
   * change: `set` serializes bigints to strings, so a HIT yielded
   * `blockNumber: "12345"` while a MISS yielded viem's raw `12345n` — decided
   * purely by whether someone had run the scan before. It surfaced as a cold
   * scan dying on "Do not know how to serialize a BigInt", but the same defect
   * silently made a COLD report differ from a WARM one in those fields.
   *
   * Round-tripping a freshly-fetched value through the identical serialization
   * makes cold and warm byte-identical by construction, and it applies even when
   * caching is DISABLED so `--no-cache` cannot take a different code path.
   */
  async wrap<T>(key: CacheKey, fetchFn: () => Promise<T>): Promise<{ value: T; fromCache: boolean }> {
    const cached = await this.get<T>(key);
    if (cached.hit) { this.hits++; return { value: cached.value, fromCache: true }; }
    const value = await fetchFn();
    await this.set(key, value);
    return { value: normalizeToCachedShape(value), fromCache: false };
  }
}
