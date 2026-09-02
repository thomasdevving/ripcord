/**
 * The indirection detector's job is narrow, and these tests mostly pin the
 * narrowness: it must find a handle, refuse to follow it, and refuse to invent
 * one. A false marker costs a lost immutability claim (safe); a MISSED marker
 * costs a false clean bill (not safe), which is why the reads that count as
 * "no marker" are enumerated explicitly rather than left to a truthiness check.
 */
import { describe, expect, it } from "vitest";
import { toFunctionSelector, type Hex } from "viem";
import {
  INDIRECTION_GETTERS,
  authorityIndirectionVersion,
  detectAuthorityIndirection,
} from "../src/detect/authorityIndirection.js";
import type { ChainReader, Evidence } from "../src/chain/client.js";

const TARGET = ("0x" + "aa".repeat(20)) as Hex;
const AUTHORIZER = "0x6048a8c631fb7e77eca533cf9c29784e482391e7";

/** Answers only the selectors given; everything else reverts, as a real contract would. */
function fakeChain(answers: Record<string, Hex>): ChainReader {
  return {
    chainId: 1,
    blockNumber: 1n,
    async getBlockHash() {
      return "0x0" as Hex;
    },
    async getCodeAtBlock() {
      return { code: undefined };
    },
    async getCode() {
      return { code: undefined, evidence: {} as Evidence };
    },
    async getStorageAt() {
      return { value: "0x0" as Hex, evidence: {} as Evidence };
    },
    async call(address: Hex, data: Hex) {
      const hit = answers[data.toLowerCase()];
      return {
        result: hit,
        reverted: hit === undefined,
        evidence: { kind: "call", params: { address, data }, rawValue: hit ?? "reverted", block: "1" } as Evidence,
      };
    },
    async probeCall() {
      return { revertData: undefined, reverted: false, evidence: {} as Evidence };
    },
    async getLogs() {
      return { logs: [], evidence: {} as Evidence };
    },
  };
}

const word = (addr: string) => ("0x" + "0".repeat(24) + addr.slice(2)) as Hex;
const sel = (sig: string) => toFunctionSelector(`function ${sig}`).toLowerCase();

describe("authority indirection markers", () => {
  it("finds the live Balancer Vault shape: getAuthorizer() resolving to a non-zero address", async () => {
    const result = await detectAuthorityIndirection(fakeChain({ [sel("getAuthorizer()")]: word(AUTHORIZER) }), TARGET);
    expect(result.markers).toHaveLength(1);
    expect(result.markers[0]!.signature).toBe("getAuthorizer()");
    expect(result.markers[0]!.target.toLowerCase()).toBe(AUTHORIZER);
    expect(result.markers[0]!.evidence).toBeDefined();
  });

  it("does NOT follow the handle it finds — it records an address and stops", async () => {
    const result = await detectAuthorityIndirection(fakeChain({ [sel("authority()")]: word(AUTHORIZER) }), TARGET);
    // The marker's whole content is: this getter, that address. No resolution,
    // no permissions, no claim about who controls it.
    expect(Object.keys(result.markers[0]!).sort()).toEqual(["evidence", "selector", "signature", "target"]);
  });

  it("records what it probed, so an empty markers array means 'checked, none found'", async () => {
    const result = await detectAuthorityIndirection(fakeChain({}), TARGET);
    expect(result.markers).toEqual([]);
    expect(result.gettersProbed).toEqual([...INDIRECTION_GETTERS]);
    expect(result.gettersProbed.length).toBeGreaterThan(5);
    expect(result.version).toBe(authorityIndirectionVersion);
  });

  it("treats a zero address as no marker — an unset handle delegates nothing", async () => {
    const zero = word("0x0000000000000000000000000000000000000000");
    const result = await detectAuthorityIndirection(fakeChain({ [sel("governance()")]: zero }), TARGET);
    expect(result.markers).toEqual([]);
  });

  it("ignores a same-named getter whose return is not one address-shaped word", async () => {
    // `registry()` returning a struct, a bool, or empty data is not the
    // address-returning accessor being looked for. Reading it as one would
    // manufacture a marker out of an unrelated function.
    const result = await detectAuthorityIndirection(
      fakeChain({
        [sel("registry()")]: ("0x" + "11".repeat(64)) as Hex, // two words
        [sel("controller()")]: "0x" as Hex, // empty
      }),
      TARGET,
    );
    expect(result.markers).toEqual([]);
  });

  it("finds every marker present, not just the first", async () => {
    const result = await detectAuthorityIndirection(
      fakeChain({ [sel("acl()")]: word(AUTHORIZER), [sel("admin()")]: word("0x" + "22".repeat(20)) }),
      TARGET,
    );
    expect(result.markers.map((m) => m.signature).sort()).toEqual(["acl()", "admin()"]);
  });

  it("derives each selector from its signature rather than carrying a constant", async () => {
    for (const sig of INDIRECTION_GETTERS) {
      const result = await detectAuthorityIndirection(fakeChain({ [sel(sig)]: word(AUTHORIZER) }), TARGET);
      expect(result.markers.map((m) => m.signature)).toContain(sig);
      expect(result.markers.find((m) => m.signature === sig)!.selector.toLowerCase()).toBe(sel(sig));
    }
  });
});
