/**
 * EVIDENCE NORMALIZATION, and the linkage rule it replaced.
 *
 * The old graph attached evidence to a node by serialising every entry and
 * asking whether the node's address appeared anywhere in the string. That is
 * quadratic, and — the part that matters more — it is not a claim about
 * relevance. Two failure directions, both silent:
 *
 *   OVER-attaching: an address inside unrelated calldata, or inside a longer hex
 *   blob, made an entry "about" a node it has nothing to do with.
 *
 *   UNDER-attaching: an ABI-encoded address lives in a 32-byte word and does not
 *   contain its own 40-character form, so a proxy-admin storage read did not
 *   match the admin it names.
 *
 * The cases below pin both directions, plus the stability of the ids the graph
 * and the on-demand endpoint both reference.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { addressesIn, buildEvidenceIndex } from "../src/report/evidenceIndex.js";
import type { Evidence } from "../src/report/schema.js";

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ev = (params: Record<string, unknown>, rawValue: unknown = "0x"): Evidence =>
  ({ kind: "call", params, rawValue, block: "25800000" });

describe("an entry NAMES an address, rather than containing its characters", () => {
  it("finds a bare 20-byte address", () => {
    expect([...addressesIn({ address: A })]).toEqual([A]);
  });

  it("decodes an address from an ABI-encoded 32-byte word", () => {
    // The under-attaching case: this is what a proxy-admin storage slot read
    // returns, and the 40-character form appears nowhere in it.
    const word = `0x${"0".repeat(24)}${A.slice(2)}`;
    expect([...addressesIn(word)]).toEqual([A]);
  });

  it("does not invent an address from a word that is not one", () => {
    // A 32-byte value whose leading bytes are non-zero is a number, a hash or a
    // role id — slicing its tail would manufacture an address nobody read.
    const hash = `0x${"12".repeat(32)}`;
    expect([...addressesIn(hash)]).toEqual([]);
  });

  it("ignores the zero address", () => {
    // Present in every empty storage slot. Linking it would make a node named
    // "0x000…0" adjacent to almost every read in the report.
    expect([...addressesIn(`0x${"0".repeat(64)}`)]).toEqual([]);
  });

  it("does not match an address that is merely a substring of a longer blob", () => {
    // The over-attaching case: calldata that happens to embed the characters.
    const calldata = `0xdeadbeef${A.slice(2)}${"11".repeat(20)}`;
    expect([...addressesIn(calldata)]).toEqual([]);
  });

  it("walks nested params and arrays", () => {
    expect([...addressesIn({ a: { b: [{ c: A }] }, d: B })].sort()).toEqual([A, B].sort());
  });
});

describe("the index stores each distinct entry once", () => {
  it("deduplicates identical entries wherever they appear", () => {
    const shared = ev({ address: A, read: "owner()" });
    const report = {
      authority: { accessControl: { roles: [{ evidence: [shared] }, { evidence: [shared] }, { evidence: [shared] }] } },
      capabilities: { evidence: [shared] },
    };
    const index = buildEvidenceIndex(report);
    expect(index.stats.total).toBe(4);
    expect(index.stats.distinct).toBe(1);
    expect(index.entries).toHaveLength(1);
  });

  it("gives the same content the same id, and different content different ids", () => {
    const one = buildEvidenceIndex({ e: [ev({ address: A })] }).entries[0]!.id;
    const again = buildEvidenceIndex({ different: { nesting: [ev({ address: A })] } }).entries[0]!.id;
    expect(again).toBe(one); // a pure function of content, not of where it was found
    expect(buildEvidenceIndex({ e: [ev({ address: B })] }).entries[0]!.id).not.toBe(one);
  });

  it("keeps first-seen order so the output is deterministic", () => {
    const report = { a: [ev({ address: A }), ev({ address: B })] };
    const first = buildEvidenceIndex(report).entries.map((e) => e.id);
    expect(buildEvidenceIndex(report).entries.map((e) => e.id)).toEqual(first);
  });

  it("links an address to every entry naming it, and to none that do not", () => {
    const index = buildEvidenceIndex({
      a: [ev({ address: A }), ev({ address: B }), ev({ slot: "0x0" }, `0x${"0".repeat(24)}${A.slice(2)}`)],
    });
    expect(index.idsFor(A)).toHaveLength(2); // the direct read and the storage word
    expect(index.idsFor(B)).toHaveLength(1);
    expect(index.idsFor("0xcccccccccccccccccccccccccccccccccccccccc")).toEqual([]);
  });

  it("is case-insensitive about addresses, because checksummed and raw forms both occur", () => {
    const index = buildEvidenceIndex({ a: [ev({ address: A.toUpperCase().replace("0X", "0x") })] });
    expect(index.idsFor(A)).toHaveLength(1);
  });

  it("resolves every id it hands out", () => {
    const index = buildEvidenceIndex({ a: [ev({ address: A }), ev({ address: B })] });
    for (const { id } of index.entries) expect(index.get(id)).toBeDefined();
    expect(index.get("not-an-id")).toBeUndefined();
  });
});

describe("against the committed corpus", () => {
  it("finds real duplication in the report the audit measured", () => {
    // sUSDe is the worst case in the corpus and the reason this module exists.
    // The assertion is deliberately loose — the exact ratio moves with the
    // ruleset — but duplication must be real and substantial, or the dedup is
    // solving a problem that is not there.
    const report = JSON.parse(readFileSync("calibration/reports/ethena-susde.json", "utf8"));
    const index = buildEvidenceIndex(report);
    expect(index.stats.total).toBeGreaterThan(1000);
    expect(index.stats.distinct).toBeLessThan(index.stats.total);
    expect(index.stats.duplicateRatio).toBeGreaterThan(0.1);
  });

  it("attaches nothing to an address the report never names", () => {
    const report = JSON.parse(readFileSync("calibration/reports/weth9.json", "utf8"));
    expect(buildEvidenceIndex(report).idsFor("0x1111111111111111111111111111111111111111")).toEqual([]);
  });
});
