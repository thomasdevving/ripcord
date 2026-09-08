/**
 * Runs the LIVE Mobula token-security comparison against one or more existing
 * Ripcord reports. It never edits those reports and never feeds its output back
 * into the verdict.
 *
 * Usage:
 *   pnpm mobula:security-audit -- calibration/reports/usdc.json
 *   pnpm mobula:security-audit -- calibration/reports --limit 25 --out /tmp/mobula-audit.json
 *
 * Each selected report makes one /api/2/token/security request (currently ten
 * Mobula credits). Directory input is capped at ten reports unless --limit is
 * supplied, preventing an accidental whole-corpus spend.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { buildMobulaSecurityAudit } from "../src/live/securityAudit.js";
import { reportSchema, type Report } from "../src/report/schema.js";

// Match the main CLI/server: local secrets may live in .env, while deployments
// can inject them directly. Only a missing file is optional.
try {
  process.loadEnvFile(".env");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

function valueAfter(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  return index === -1 ? null : (args[index + 1] ?? null);
}

function parseLimit(raw: string | null): number {
  if (raw === null) return 10;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 10_000) {
    throw new Error("--limit must be an integer between 1 and 10000");
  }
  return value;
}

function inputPaths(path: string): string[] {
  if (!existsSync(path)) throw new Error(`input does not exist: ${path}`);
  if (statSync(path).isFile()) return [path];
  return readdirSync(path)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => join(path, name));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outPath = valueAfter(args, "--out");
  const limit = parseLimit(valueAfter(args, "--limit"));
  const flagValues = new Set([valueAfter(args, "--out"), valueAfter(args, "--limit")].filter(Boolean));
  const positional = args.filter((arg) => !arg.startsWith("--") && !flagValues.has(arg));
  if (positional.length !== 1) {
    throw new Error("usage: pnpm mobula:security-audit -- <report.json|report-directory> [--limit N] [--out file]");
  }

  const selected = inputPaths(positional[0]!).slice(0, limit);
  if (selected.length === 0) throw new Error("no JSON reports found in the selected input");

  const results = [];
  for (const path of selected) {
    const parsed = reportSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (!parsed.success) throw new Error(`${path} is not a current Ripcord report: ${parsed.error.message}`);
    const report: Report = parsed.data;
    const audit = await buildMobulaSecurityAudit(report);
    results.push({ reportFile: basename(path), audit });
    const detail = audit.status === "ok"
      ? `${audit.summary.disagreements} disagreement(s), ${audit.summary.notComparable} not comparable`
      : audit.reason;
    console.error(`${audit.status === "ok" ? "✓" : "!"} ${basename(path)} — ${detail}`);
  }

  const envelope = {
    format: "ripcord-mobula-security-corpus/v1",
    generatedAt: new Date().toISOString(),
    scope:
      "Live external comparison only. Disagreements are regression leads, not Ripcord findings and not verdict inputs.",
    requested: selected.length,
    results,
  };
  const json = JSON.stringify(envelope, null, 2) + "\n";
  if (outPath) writeFileSync(outPath, json);
  else process.stdout.write(json);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
