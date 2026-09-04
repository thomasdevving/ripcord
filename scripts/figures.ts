/**
 * Figure provenance for the report renderer. Every displayed figure goes through
 * this class, which records the JSON path it came from alongside the string that
 * was rendered; scripts/verify-pages.mjs re-checks both against the source
 * report, so "the page matches the JSON" is a test rather than a promise.
 *
 * Formatting is expected ("172800" reads better as "2 days"), so both values are
 * kept. Arithmetic is not: there is no path here that combines two values into a
 * figure the report never asserted.
 */

export interface FigureEntry {
  /** Dotted path into the report JSON, resolvable by verify-pages.mjs. */
  jsonPath: string;
  /** The value at that path, exactly as the report holds it. */
  raw: unknown;
  /** The string placed on the page. */
  rendered: string;
  /** What this figure is, for the verifier's failure messages. */
  label: string;
}

export class FigureLog {
  readonly entries: FigureEntry[] = [];

  constructor(private readonly report: unknown) {}

  /** Resolves a dotted path (supporting `a.b[0].c`) or throws — a missing path is a renderer bug, not a blank. */
  private resolve(path: string): unknown {
    const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".");
    let cur: unknown = this.report;
    for (const part of parts) {
      if (cur === null || cur === undefined) return undefined;
      cur = (cur as Record<string, unknown>)[part];
    }
    return cur;
  }

  /**
   * Reads `path` out of the report, formats it, records the provenance, and
   * returns the rendered string. `format` may only transform the value it is
   * given — it never receives the report, so it cannot reach for anything else.
   */
  read(label: string, path: string, format: (raw: never) => string): string {
    const raw = this.resolve(path);
    const rendered = format(raw as never);
    this.entries.push({ jsonPath: path, raw, rendered, label });
    return rendered;
  }

  /** The manifest embedded in the page for the verifier to re-check. */
  toJSON(): FigureEntry[] {
    return this.entries;
  }
}

/**
 * Seconds → a human duration, and the ONLY place that conversion happens.
 *
 * Deliberately exact: 172800 renders as "2 days", never as "~2 days" or
 * "about 2d". A value that is not a whole number of its unit keeps the smaller
 * unit rather than rounding, because rounding a notice period is rounding the
 * thing the whole report is about.
 */
export function humanSeconds(raw: string | null): string {
  if (raw === null) return "not established";
  const s = BigInt(raw);
  if (s === 0n) return "0 — none at all";
  const units: [bigint, string, string][] = [
    [86400n, "day", "days"],
    [3600n, "hour", "hours"],
    [60n, "minute", "minutes"],
    [1n, "second", "seconds"],
  ];
  for (const [size, one, many] of units) {
    if (s % size === 0n && s >= size) {
      const n = s / size;
      return `${n} ${n === 1n ? one : many}`;
    }
  }
  // Not a whole number of any unit: show the exact seconds rather than a
  // rounded approximation of a period someone may have to act inside.
  return `${s} seconds`;
}

/** USD, with the report's own precision — never re-rounded. */
export function formatUsd(v: number | null): string {
  if (v === null) return "not priced";
  return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function shortAddress(a: string | null): string {
  if (!a) return "—";
  return `${a.slice(0, 10)}…${a.slice(-6)}`;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
