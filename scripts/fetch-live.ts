/**
 * Pulls the Mobula LIVE layer for every pinned report and writes it to a
 * SIDECAR file — one per report, in a separate directory.
 *
 * The sidecar is the boundary made physical. `calibration/reports/*.json` are
 * the pinned, block-anchored, byte-identical-on-cold-rerun artifacts the whole
 * project rests on; this script never opens them for writing and never adds a
 * field to them. It reads a target address out of each and writes
 * `calibration/live/<label>.json` beside it. Delete that directory and every
 * report, every verdict and every figure is unchanged — which is the property
 * `pnpm determinism` and scripts/verify-boundary.mjs both check.
 *
 * Run:  pnpm live:fetch            (all publishable reports)
 *       pnpm live:fetch --all      (including disclosure-blocked ones)
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { buildLiveExposure } from "../src/live/exposure.js";
import { inlineLogo } from "../src/live/logos.js";
import type { Report } from "../src/report/schema.js";

async function main(): Promise<void> {
  const inDir = process.argv[2] ?? "calibration/reports";
  const outDir = process.argv[3] ?? "calibration/live";
  const includeAll = process.argv.includes("--all");
  // Resumable by default. The keyless tier rate-limits a full sweep into 503s,
  // and a target that failed for that reason is not a fact about the target —
  // so a re-run retries only what is still missing and the set converges.
  // `--refetch` forces every target to be pulled again.
  const refetch = process.argv.includes("--refetch");
  mkdirSync(outDir, { recursive: true });

  const files = readdirSync(inDir).filter((f) => f.endsWith(".json")).sort();
  let ok = 0;
  let failed = 0;
  let first = true;

  // The keyless tier rate-limits a burst into HTTP 503s. Targets are walked
  // sequentially with a pause between them rather than fanned out: this is a
  // build step nobody is waiting on, and a slow complete run beats a fast run
  // full of "unavailable" panels.
  const PAUSE_MS = Number(process.env.MOBULA_PAUSE_MS ?? 2000);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  for (const file of files) {
    const report = JSON.parse(readFileSync(join(inDir, file), "utf8")) as Report;
    const label = basename(file, ".json");
    if (!includeAll && !report.disclosure.publishable) {
      console.log(`· skipped ${label} — disclosure.publishable is false`);
      continue;
    }

    const dest = join(outDir, `${label}.json`);
    if (!refetch && existsSync(dest)) {
      try {
        if (JSON.parse(readFileSync(dest, "utf8")).status === "ok") {
          ok++;
          console.log(`· have  ${label} — already fetched (use --refetch to replace)`);
          continue;
        }
      } catch {
        // A corrupt sidecar is simply re-fetched; it holds no irreplaceable state.
      }
    }

    if (!first) await sleep(PAUSE_MS);
    first = false;

    const exposure = await buildLiveExposure(report.target.address, report.chainId);

    // Logos are inlined here rather than in exposure.ts so the composer stays a
    // pure data step and this stays the only place that writes bytes to disk.
    const withLogos = {
      ...exposure,
      holdings: await Promise.all(
        exposure.holdings.map(async (h) => ({ ...h, logoDataUri: await inlineLogo(h.logo) })),
      ),
    };

    writeFileSync(dest, JSON.stringify(withLogos, null, 2) + "\n");

    if (exposure.status === "ok") {
      ok++;
      console.log(
        `✓ ${label}  $${(exposure.exposureUsd ?? 0).toLocaleString("en-US", { maximumFractionDigits: 2 })} counted · ` +
          `${exposure.countedHoldings}/${exposure.holdingsCount} holdings · ${exposure.chainCount} chains` +
          (exposure.withheld.length ? `  (${exposure.withheld.length} withheld bucket(s))` : "") +
          (exposure.notes.length ? `  (${exposure.notes.length} note(s))` : ""),
      );
    } else {
      failed++;
      // Loud, but not fatal: an unavailable panel is a valid, renderable result.
      console.log(`! ${label}  live data unavailable — ${exposure.reason}`);
    }
  }

  console.log(`\n${ok} live sidecar(s) written, ${failed} unavailable → ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
