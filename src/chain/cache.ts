/**
 * On-disk cache for RPC reads, keyed by (chainId, blockNumber, method, params).
 * Every read Ripcord performs is pinned to a historical block, so a cached
 * result is permanently valid — there is no invalidation logic here on
 * purpose. This is what makes `pnpm ripcord scan` reproducible: a warm cache
 * makes zero network calls and returns byte-identical results.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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

function keyToPath(cacheDir: string, key: CacheKey): string {
  const raw = stableStringify({
    chainId: key.chainId,
    blockNumber: key.blockNumber.toString(),
    method: key.method,
    params: key.params,
  });
  const hash = createHash("sha256").update(raw).digest("hex");
  return join(
    cacheDir,
    String(key.chainId),
    key.blockNumber.toString(),
    key.method,
    `${hash}.json`,
  );
}

export class DiskCache {
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
    await writeFile(path, serialized, "utf8");
  }

  /** Wraps a fetch function with get/set. The wrapped function is the single place cache semantics live. */
  async wrap<T>(key: CacheKey, fetchFn: () => Promise<T>): Promise<{ value: T; fromCache: boolean }> {
    const cached = await this.get<T>(key);
    if (cached.hit) return { value: cached.value, fromCache: true };
    const value = await fetchFn();
    await this.set(key, value);
    return { value, fromCache: false };
  }
}
