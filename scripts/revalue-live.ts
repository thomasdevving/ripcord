/**
 * Recomputes the valuation of every live sidecar from the quotes it already
 * holds. No network, no API quota, no re-stamping of `fetchedAt`.
 *
 * The valuation rules are the part of the live layer most likely to need
 * correcting — the liquidity threshold was corrected once already, after the
 * first version discarded $93M of entirely real USDT on Curve 3pool. Re-fetching
 * every target through a rate-limited public tier to test a threshold change
 * would be slow and would burn someone's quota for no new information, since
 * both quotes and the liquidity figure are stored per holding.
 *
 * Run: pnpm live:revalue
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { revalueExposure } from "../src/live/exposure.js";
import type { LiveExposure } from "../src/live/exposure.js";

const dir = process.argv[2] ?? "calibration/live";
if (!existsSync(dir)) {
  console.error(`no such directory: ${dir}`);
  process.exit(1);
}

let changed = 0;
let same = 0;
for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
  const path = join(dir, file);
  const before = readFileSync(path, "utf8");
  const after = JSON.stringify(revalueExposure(JSON.parse(before) as LiveExposure), null, 2) + "\n";
  if (before === after) {
    same++;
    continue;
  }
  writeFileSync(path, after);
  changed++;
  const e = JSON.parse(after) as LiveExposure;
  console.log(
    `✓ ${file.replace(/\.json$/, "")}  →  $${(e.exposureUsd ?? 0).toLocaleString("en-US", { maximumFractionDigits: 2 })} ` +
      `across ${e.countedHoldings} counted holding(s)`,
  );
}
console.log(`\n${changed} sidecar(s) revalued, ${same} unchanged.`);
