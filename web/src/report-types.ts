/**
 * The report's shape, for the browser.
 *
 * TYPE-ONLY imports from the engine's own zod schema. `import type` is erased
 * before bundling, so no engine code, no zod and no Node module reaches the
 * client — `scripts/verify-webapp.mjs` asserts that against the built bundle
 * rather than trusting this comment. Re-declaring the shape here was rejected:
 * it would be a second definition that drifts, and a drifted type is worse than
 * none because it type-checks while being wrong.
 *
 * Everything is nonetheless read DEFENSIVELY below. A stored report may have been
 * written by an older ruleset — calibration reports on disk are preserved at the
 * version that produced them — so a field this build expects may genuinely be
 * absent, and the page must render rather than throw.
 */
import type { Report } from "../../src/report/schema.js";

export type { Report };

/** Narrow an `unknown` API payload to a Report-shaped object without pretending to validate it. */
export function asReport(value: unknown): Report | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<Report>;
  // Two fields every schema version has had. Enough to tell a report from an
  // error body; deliberately not a validation — the server already validated
  // against the real schema, and re-implementing that here would be the second
  // definition this module exists to avoid.
  if (typeof candidate.schemaVersion !== "string" || typeof candidate.chainId !== "number") return null;
  return value as Report;
}

/** Seconds → a human duration. Returns null for null, so callers must handle "not established" explicitly rather than printing "0s". */
export function formatDuration(seconds: string | number | null | undefined): string | null {
  if (seconds === null || seconds === undefined) return null;
  const value = Number(seconds);
  if (!Number.isFinite(value)) return null;
  if (value === 0) return "0s";
  const days = Math.floor(value / 86400);
  const hours = Math.floor((value % 86400) / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = value % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (secs && parts.length < 2) parts.push(`${secs}s`);
  return parts.join(" ") || `${value}s`;
}

/**
 * The visual tone for a verdict.
 *
 * NOTE THE ASYMMETRY, which is intentional: `no_notice` and `trapped` get the
 * critical tone, everything else gets neutral. There is no branch returning the
 * healthy tone, because no verdict status is a clean bill of health — not even
 * the positive tiers, which are scoped claims about what was checked. Green in
 * this app means a process step finished; it never means a contract is safe.
 */
export function verdictTone(status: string | null | undefined): "critical" | "unknown" {
  if (status === "no_notice" || status === "trapped") return "critical";
  return "unknown";
}

/** Plain-language gloss for each verdict status. The report's own `statement` carries the specifics; this frames it. */
export const VERDICT_GLOSS: Record<string, string> = {
  no_notice:
    "There is a route by which the rules governing your position can change with no notice at all. The comparison between leaving and changing collapses: there is no window to measure.",
  trapped:
    "Leaving takes at least as long as the notice before the rules can change. Finishing an exit at the instant a change lands is not leaving before it.",
  can_exit_in_time: "Within what was checked, the measured exit is shorter than the notice on every route that was found.",
  no_direct_restriction_found:
    "The registered restriction candidates were evaluated and none closed the exit. This is a scoped result about what was tested — not a guarantee that no restriction exists.",
  immutable_within_checks:
    "Within the checks listed, no route to change the rules was found. This is a claim about the search, bounded by the caveats beside it.",
  undetermined:
    "The analysis completed but could not settle the question. What is missing is listed below — an undetermined result is an outcome, not a failure to run.",
};

/**
 * Short qualifiers for the two figures the report head shows side by side.
 *
 * BOTH ARE LOOKUPS ON A STATUS THE SERVER ALREADY DECIDED. Nothing here takes a
 * minimum, compares the two clocks, or decides whether a delay binds.
 *
 * The wording is load-bearing in one direction: a figure the report carries but
 * did not establish must never read as a measurement, so `not_proven_binding`
 * says so out loud and `no_mechanism_detected` refuses the reassuring reading of
 * a zero rather than presenting it as an instant exit.
 */
export const EXIT_WINDOW_QUALIFIER: Record<string, string> = {
  binding: "proven binding",
  no_notice: "at least one route needs no waiting at all",
  not_proven_binding: "carried by the report, NOT proven binding",
  immutable_within_checks: "no route to change the rules was found, within the checks listed",
  undetermined: "no window could be established",
};

export const TIME_TO_EXIT_QUALIFIER: Record<string, string> = {
  measured: "every detected leg measured",
  lower_bound: "a floor — the unmeasured legs are named below",
  no_mechanism_detected: "no waiting period was detected, which is not proof leaving is instant",
  blocked: "the exit is blocked at this block",
  undetermined: "no exit duration could be established",
};

/** Thousands separators for a block height read by a person. The provenance table keeps the raw value to copy. */
export function groupDigits(value: string | number | null | undefined): string {
  const raw = String(value ?? "");
  return /^\d+$/.test(raw) ? raw.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : raw;
}

/** Lossless base units → tokens, including values above Number.MAX_SAFE_INTEGER. */
export function formatTokenUnits(raw: string, decimals: number | null | undefined): string {
  if (!/^-?\d+$/.test(raw) || !Number.isInteger(decimals) || decimals == null || decimals < 0 || decimals > 255) return `${raw} raw units`;
  const negative = raw.startsWith("-");
  const digits = (negative ? raw.slice(1) : raw).replace(/^0+(?=\d)/, "").padStart(decimals + 1, "0");
  const integer = decimals ? digits.slice(0, -decimals) : digits;
  const fraction = decimals ? digits.slice(-decimals).replace(/0+$/, "") : "";
  return `${negative ? "-" : ""}${integer}${fraction ? `.${fraction}` : ""}`;
}
