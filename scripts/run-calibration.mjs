#!/usr/bin/env node
/**
 * Regenerates the whole calibration set from calibration/run-manifest.json, so
 * "the 26 reports" is a command rather than a memory of what someone typed. It
 * runs the SAME CLI a user runs — no privileged internal path.
 *
 * Usage:
 *   node scripts/run-calibration.mjs [--out <dir>] [--cache-dir <dir>] [--only <label>]
 *
 * The cache is keyed by (chainId, block, method, params) and NOT by provider, so
 * a cold run and a warm one must be byte-identical apart from `generatedAt` —
 * check that with scripts/compare-reports.mjs.
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const outDir = opt("--out", "calibration/reports");
const cacheDir = opt("--cache-dir", ".cache");
const only = opt("--only", null);

const manifest = JSON.parse(readFileSync("calibration/run-manifest.json", "utf8"));
const targets = manifest.targets.filter((t) => !only || t.label === only);
mkdirSync(outDir, { recursive: true });

let ok = 0;
const failures = [];
const started = Date.now();

for (const [i, t] of targets.entries()) {
  const label = `[${i + 1}/${targets.length}] ${t.label}`;
  process.stderr.write(`${label} ${t.mode} ${t.address} ... `);
  const t0 = Date.now();

  // Retry a failed TARGET after a pause — orchestration only, deliberately not a
  // change to the tool's own retry semantics. A non-Enumerable AccessControl
  // contract with deep history fires ~1500 eth_getLogs requests, which exhausts a
  // free tier's throughput allowance and makes the next several targets fail
  // instantly on their first read. Ripcord fails LOUD there rather than producing
  // a clean-looking report from a dead endpoint, but its in-process retry is
  // budgeted for a transient blip, not for a quota window. Resuming is cheap: the
  // cache is never invalidated, so a retry picks up where the last attempt
  // stopped rather than starting over.
  const attemptsPerTarget = 3;
  const cooldownMs = 90_000;
  let res;
  for (let attempt = 1; attempt <= attemptsPerTarget; attempt++) {
    res = spawnSync(
      "npx",
      ["tsx", "src/cli.ts", t.mode, t.address, "--block", manifest.block, "--chain", String(manifest.chainId), "--cache-dir", cacheDir],
      { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
    );
    if (res.status === 0 && res.stdout) break;
    if (attempt < attemptsPerTarget) {
      process.stderr.write(`retrying in ${cooldownMs / 1000}s (attempt ${attempt} failed) ... `);
      // Synchronous sleep: this script is a sequential driver, and blocking is
      // simpler here than making the whole loop async for one pause.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, cooldownMs);
    }
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (res.status !== 0 || !res.stdout) {
    failures.push({ label: t.label, status: res.status, stderr: (res.stderr || "").slice(-800) });
    process.stderr.write(`FAILED after ${attemptsPerTarget} attempts (exit ${res.status}, ${secs}s)\n`);
    continue;
  }
  let report;
  try {
    report = JSON.parse(res.stdout);
  } catch (err) {
    failures.push({ label: t.label, status: "unparseable stdout", stderr: String(err) });
    process.stderr.write(`FAILED (unparseable JSON, ${secs}s)\n`);
    continue;
  }
  writeFileSync(join(outDir, `${t.label}.json`), JSON.stringify(report, null, 2) + "\n");
  ok++;
  const v = report.verdict?.status ?? "?";
  const errs = report.errors?.length ?? 0;
  process.stderr.write(`${v}${errs ? ` (${errs} error(s))` : ""} ${secs}s\n`);
}

process.stderr.write(`\n${ok}/${targets.length} written to ${outDir} in ${((Date.now() - started) / 1000 / 60).toFixed(1)} min\n`);
if (failures.length) {
  process.stderr.write(`\n${failures.length} FAILURE(S):\n`);
  for (const f of failures) process.stderr.write(`  ${f.label}: ${f.status}\n${f.stderr}\n`);
  process.exitCode = 1;
}
