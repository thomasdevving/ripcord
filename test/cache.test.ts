import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiskCache, cacheKeyFingerprint, normalizeToCachedShape, type CacheKey } from "../src/chain/cache.js";
import { describeProvider } from "../src/chain/rpcPreflight.js";

describe("cache key is provider-independent", () => {
  // This is the guarantee that makes a warm cache built with one provider a
  // valid, identical hit for another: the fingerprint is a pure function of
  // (chainId, block, method, params) and contains NOTHING about the provider.
  const key: CacheKey = {
    chainId: 1,
    blockNumber: 25800000n,
    method: "getStorageAt",
    params: { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", slot: "0x0" },
  };

  it("is stable across repeated computation", () => {
    expect(cacheKeyFingerprint(key)).toBe(cacheKeyFingerprint({ ...key }));
  });

  it("does not change when an unrelated provider-ish field is present on the object", () => {
    // Even if a caller accidentally threads an rpcUrl onto the params object,
    // the fingerprint must ignore anything outside the four canonical fields.
    const withProvider = { ...key, rpcUrl: "https://eth-mainnet.g.alchemy.com/v2/SECRET" } as CacheKey & {
      rpcUrl: string;
    };
    expect(cacheKeyFingerprint(withProvider)).toBe(cacheKeyFingerprint(key));
  });

  it("DOES change when any canonical field changes (sanity: it's not a constant)", () => {
    expect(cacheKeyFingerprint({ ...key, blockNumber: 25800001n })).not.toBe(cacheKeyFingerprint(key));
    expect(cacheKeyFingerprint({ ...key, method: "call" })).not.toBe(cacheKeyFingerprint(key));
    expect(cacheKeyFingerprint({ ...key, chainId: 10 })).not.toBe(cacheKeyFingerprint(key));
  });
});

describe("provider description never leaks the key", () => {
  it("names known providers from the host only", () => {
    expect(describeProvider("https://eth-mainnet.g.alchemy.com/v2/SECRETKEY").name).toBe("Alchemy");
    expect(describeProvider("https://mainnet.infura.io/v3/SECRETKEY").name).toBe("Infura");
    expect(describeProvider("https://eth-mainnet.public.blastapi.io").name).toMatch(/BlastAPI/);
  });

  it("never includes the path (where the API key lives) in name or host", () => {
    const info = describeProvider("https://eth-mainnet.g.alchemy.com/v2/SUPERSECRET");
    expect(info.name).not.toContain("SUPERSECRET");
    expect(info.host).not.toContain("SUPERSECRET");
    expect(info.host).toBe("eth-mainnet.g.alchemy.com");
  });

  it("labels an unknown host as custom, still host-only", () => {
    const info = describeProvider("https://my-node.internal.example:8545/rpc/KEY123");
    expect(info.name).toBe("custom (my-node.internal.example:8545)");
    expect(info.name).not.toContain("KEY123");
  });
});

/**
 * A cache MISS must return exactly what a later HIT returns. This was not true
 * until day 4: `set` serializes bigints to strings because JSON has no bigint,
 * but `wrap` used to hand back the raw fetched value on a miss — so the same
 * pinned read produced `12345n` cold and `"12345"` warm. It surfaced as a hard
 * crash ("Do not know how to serialize a BigInt") on a cold scan of a target
 * whose getLogs evidence contained real log objects, and it silently made cold
 * and warm reports differ everywhere else. These tests pin the invariant.
 */
describe("cache miss/hit shape equivalence", () => {
  it("returns the same value shape on a miss as on a subsequent hit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ripcord-cache-shape-"));
    const cache = new DiskCache(dir, true);
    const key = { chainId: 1, blockNumber: 100n, method: "getLogs", params: { a: 1 } };
    // A viem-shaped log: blockNumber is a bigint, which JSON cannot represent.
    const fetched = [{ address: "0xabc", blockNumber: 12345n, logIndex: 2, args: { role: "0x00" } }];

    const miss = await cache.wrap(key, async () => fetched);
    expect(miss.fromCache).toBe(false);
    const hit = await cache.wrap(key, async () => {
      throw new Error("must not refetch");
    });
    expect(hit.fromCache).toBe(true);
    expect(miss.value).toEqual(hit.value);
    // Specifically: the bigint is a string on BOTH paths, never a bigint on one.
    expect((miss.value as typeof fetched)[0]!.blockNumber).toBe("12345");
  });

  it("normalizes even when caching is disabled, so --no-cache is not a different code path", async () => {
    const cache = new DiskCache("/nonexistent", false);
    const { value } = await cache.wrap(
      { chainId: 1, blockNumber: 1n, method: "m", params: {} },
      async () => ({ n: 7n, nested: [{ deep: 9n }] }),
    );
    expect(value).toEqual({ n: "7", nested: [{ deep: "9" }] });
  });

  it("a value carrying a bigint survives JSON.stringify after normalization", () => {
    const normalized = normalizeToCachedShape({ blockNumber: 1n });
    expect(() => JSON.stringify(normalized)).not.toThrow();
  });

  it("passes a top-level undefined through rather than crashing on it", () => {
    expect(normalizeToCachedShape(undefined)).toBeUndefined();
  });

  it("drops undefined object properties, exactly as a disk round-trip does", () => {
    expect(normalizeToCachedShape({ a: 1, b: undefined })).toEqual({ a: 1 });
  });
});
