import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { runProofEngine, type ProofRequest } from "../src/fork/proofEngine.js";
import type { ProxyResult } from "../src/report/schema.js";

/**
 * These exercise the proof engine's HONESTY RAILS without any network or fork:
 * every branch below returns before an anvil process is ever spawned, because
 * the archetype gate and the authority-resolution gate come first. That
 * ordering is the point — the engine refuses loudly and cheaply rather than
 * spinning up a sandbox only to discover it has nothing valid to simulate.
 */
function baseRequest(proxy: Partial<ProxyResult>, authorityResolution: ProofRequest["authorityResolution"] = null): ProofRequest {
  return {
    chainId: 1,
    rpcUrl: "http://127.0.0.1:1", // never contacted in these tests
    blockNumber: 25800000n,
    target: "0x8c8687fc965593dfb2f0b4eaefd55e9d8df348df" as Hex,
    artifactDir: "/tmp/ripcord-test-artifacts",
    authorityResolution,
    proxy: {
      pattern: "not_a_proxy",
      isProxy: false,
      implementation: null,
      beacon: null,
      admin: null,
      slots: {},
      evidence: [],
      ...proxy,
    } as ProxyResult,
  };
}

describe("proof engine archetype gate (no fork spawned)", () => {
  it("refuses a non-transparent proxy with a stated reason, produced=false", async () => {
    const proof = await runProofEngine(baseRequest({ pattern: "eip1967_uups", isProxy: true }));
    expect(proof.attempted).toBe(true);
    expect(proof.produced).toBe(false);
    expect(proof.failureReason).toMatch(/not eip1967_transparent/);
    // Never claims intent.
    expect(proof.headline.toLowerCase()).not.toMatch(/will|malicious|rug/);
  });

  it("refuses a transparent proxy whose upgrade authority was never resolved", async () => {
    const proof = await runProofEngine(
      baseRequest(
        { pattern: "eip1967_transparent", isProxy: true, admin: ("0x" + "ab".repeat(20)) as Hex },
        null,
      ),
    );
    expect(proof.produced).toBe(false);
    expect(proof.failureReason).toMatch(/no resolved authority path/i);
  });

  it("refuses when the ProxyAdmin's controller did not resolve to an impersonable account", async () => {
    const admin = ("0x" + "cd".repeat(20)) as Hex;
    const proof = await runProofEngine(
      baseRequest(
        { pattern: "eip1967_transparent", isProxy: true, admin },
        {
          maxDepth: 3,
          roots: [],
          cyclesDetected: [],
          paths: [
            {
              label: "proxyAdmin",
              hops: [{ address: admin, relation: "proxyAdmin", type: "contract", depth: 1 }],
              effectiveController: null,
              effectiveControllerType: null,
              terminationReason: "no_authority_found",
              confidence: "high",
            },
          ],
        },
      ),
    );
    expect(proof.produced).toBe(false);
    expect(proof.failureReason).toMatch(/impersonable account/i);
    expect(proof.authorityPath).not.toBeNull();
  });

  it("never emits intent language in any not-produced headline/reason", async () => {
    const proof = await runProofEngine(baseRequest({ pattern: "legacy_zos_unstructured", isProxy: true }));
    const text = `${proof.headline} ${proof.failureReason}`.toLowerCase();
    expect(text).not.toMatch(/\bwill\b|malicious|\brug\b|scam/);
    expect(proof.sandboxNote).toMatch(/no mainnet transaction/i);
  });
});
