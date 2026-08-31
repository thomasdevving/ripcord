import { describe, expect, it } from "vitest";
import { cacheKeyFingerprint, type CacheKey } from "../src/chain/cache.js";
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
