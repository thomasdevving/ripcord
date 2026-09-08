/**
 * EVIDENCE, STORED ONCE AND REFERENCED.
 *
 * A pinned report is deliberately self-contained: every finding carries the
 * reads that produced it, so one JSON file is a complete argument an auditor can
 * check without fetching anything. That property is worth keeping, and it has a
 * cost — the same read is embedded wherever it is relevant, and the cost is not
 * small. Measured on the committed corpus: the sUSDe report serialises ~1.13MB
 * of evidence of which ~462KB is distinct, and the graph derived from the Aave
 * ACL Manager report adds another ~402KB on top of a 705KB report.
 *
 * This module is the transport-side answer. It does NOT change the pinned
 * artifact — the report on disk stays self-contained, because that is what makes
 * it evidence — it builds a deduplicated view of it for the layers that ship
 * evidence over a wire or attach it to a graph: each distinct entry once, under
 * a stable content-derived id, with the addresses it actually names.
 *
 * THE LINKAGE IS THE OTHER HALF, and it was the more serious problem.
 * `reportStructure` used to attach evidence to a graph node by serialising every
 * entry and asking whether the node's address appeared anywhere in the resulting
 * string. That is quadratic (nodes x entries x size) and it is not a statement
 * about relevance: an address can appear inside an unrelated calldata blob, and
 * a 32-byte storage word containing an address does not contain its 40-character
 * form at all — so the old rule both over-attached and under-attached, silently.
 *
 * Here an entry names an address only when that address appears as an ADDRESS:
 * an exact 20-byte hex value, or a 32-byte word whose leading 12 bytes are zero,
 * which is precisely how the ABI encodes one. Both forms are decoded, neither is
 * guessed at from a substring.
 */
import { createHash } from "node:crypto";
import type { Evidence } from "./schema.js";

/** Stable across processes and runs: a pure function of the entry's content. */
function evidenceId(evidence: Evidence): string {
  const canonical = stableStringify(evidence);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

const BARE_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const WORD = /^0x[0-9a-fA-F]{64}$/;

/**
 * Every address this value NAMES, in either encoding. An ABI-encoded address is
 * a 32-byte word with 12 zero bytes of padding; anything else in a word is not
 * an address and must not be read as one, which is why the padding is checked
 * rather than the tail simply being sliced off every word.
 */
export function addressesIn(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    if (BARE_ADDRESS.test(value)) out.add(value.toLowerCase());
    else if (WORD.test(value) && /^0{24}$/.test(value.slice(2, 26))) {
      const candidate = `0x${value.slice(26)}`.toLowerCase();
      // The zero address is in every empty storage slot; linking every node to
      // every empty read would make the graph's evidence meaningless.
      if (!/^0x0{40}$/.test(candidate)) out.add(candidate);
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) addressesIn(item, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) addressesIn(item, out);
  }
  return out;
}

export interface IndexedEvidence {
  id: string;
  evidence: Evidence;
}

export interface EvidenceIndex {
  /** Each distinct entry exactly once, in first-seen order so the output is deterministic. */
  entries: IndexedEvidence[];
  /** Lowercased address -> ids of the entries that name it. */
  byAddress: Map<string, string[]>;
  get(id: string): Evidence | undefined;
  /** Ids naming an address, in first-seen order. Empty array when none do. */
  idsFor(address: string): string[];
  stats: { total: number; distinct: number; duplicateRatio: number };
}

function looksLikeEvidence(value: unknown): value is Evidence {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return Boolean(v.kind) && Boolean(v.params) && "rawValue" in v && "block" in v;
}

/**
 * Walks any report-shaped object and collects its evidence entries once each.
 *
 * Deliberately structural rather than driven by a list of known field paths: new
 * evidence-bearing fields appear with every ruleset, and an index that silently
 * missed one would under-attach evidence to exactly the newest finding.
 */
export function buildEvidenceIndex(root: unknown): EvidenceIndex {
  const byId = new Map<string, Evidence>();
  const order: string[] = [];
  const byAddress = new Map<string, string[]>();
  let total = 0;

  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (looksLikeEvidence(value)) {
      total++;
      const id = evidenceId(value);
      if (!byId.has(id)) {
        byId.set(id, value);
        order.push(id);
        for (const address of addressesIn({ params: value.params, rawValue: value.rawValue })) {
          const list = byAddress.get(address);
          if (list) list.push(id);
          else byAddress.set(address, [id]);
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    for (const item of Object.values(value as Record<string, unknown>)) visit(item);
  };
  visit(root);

  const distinct = order.length;
  return {
    entries: order.map((id) => ({ id, evidence: byId.get(id)! })),
    byAddress,
    get: (id) => byId.get(id),
    idsFor: (address) => byAddress.get(address.toLowerCase()) ?? [],
    stats: { total, distinct, duplicateRatio: total === 0 ? 0 : (total - distinct) / total },
  };
}
