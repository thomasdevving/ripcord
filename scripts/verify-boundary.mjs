/**
 * THE MOBULA BOUNDARY, AS A TEST RATHER THAN A PROMISE. A report is pinned and
 * byte-identical cold or warm; the live layer is a third-party read of the
 * present. Mixing them destroys the first, and "we were careful" is not a
 * control. Four properties, checked in CI:
 *
 *  1. No import path from the pinned code (src/chain, src/detect, src/report,
 *     src/fork, src/cli.ts) into src/live — a real transitive walk, not a grep,
 *     because an indirect import is still an import.
 *  2. No Mobula hostname, env var or URL anywhere in the pinned path.
 *  3. No live data in a pinned report, which would make it non-deterministic
 *     even if nothing read it.
 *  4. No secret in a committed artifact.
 *
 * It also states in one place that the sidecars are DELIBERATELY not
 * deterministic, so nobody mistakes a changing sidecar for a regression.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve, extname } from "node:path";

let failures = 0;
const fail = (msg) => { console.log(`✗ ${msg}`); failures++; };
const pass = (msg) => console.log(`✓ ${msg}`);

const PINNED_ROOTS = ["src/cli.ts", "src/chain", "src/detect", "src/report", "src/fork"];
const LIVE_DIR = "src/live";

function walkFiles(p, acc = []) {
  if (!existsSync(p)) return acc;
  if (statSync(p).isFile()) { if (extname(p) === ".ts") acc.push(p); return acc; }
  for (const e of readdirSync(p)) walkFiles(join(p, e), acc);
  return acc;
}

// --- 1. transitive import walk ----------------------------------------------

/** Resolves a TS-style relative import ("./x.js") to the .ts file on disk. */
function resolveImport(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec).replace(/\.js$/, "");
  for (const cand of [`${base}.ts`, join(base, "index.ts")]) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

function importsOf(file) {
  const src = readFileSync(file, "utf8");
  const specs = [];
  const re = /(?:^|\n)\s*(?:import|export)[\s\S]{0,200}?from\s+["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(src)) !== null) specs.push(m[1]);
  const dyn = /import\(\s*["']([^"']+)["']\s*\)/g;
  while ((m = dyn.exec(src)) !== null) specs.push(m[1]);
  return specs.map((s) => resolveImport(file, s)).filter(Boolean);
}

const seeds = PINNED_ROOTS.flatMap((r) => walkFiles(r));
const seen = new Set();
const stack = [...seeds];
const parentOf = new Map();
let leak = null;

while (stack.length) {
  const f = stack.pop();
  const rel = f.replace(process.cwd() + "/", "");
  if (seen.has(rel)) continue;
  seen.add(rel);
  if (rel.startsWith(LIVE_DIR)) { leak = rel; break; }
  for (const dep of importsOf(f)) {
    const drel = dep.replace(process.cwd() + "/", "");
    if (!parentOf.has(drel)) parentOf.set(drel, rel);
    stack.push(dep);
  }
}

if (leak) {
  const chain = [];
  let cur = leak;
  while (cur) { chain.unshift(cur); cur = parentOf.get(cur); }
  fail(`the pinned path reaches the live layer: ${chain.join(" -> ")}`);
} else {
  pass(`no import path from the pinned code into ${LIVE_DIR}/ (${seen.size} modules walked transitively)`);
}

// --- 2. no Mobula reference in the pinned path ------------------------------

const FORBIDDEN = [/mobula/i, /MOBULA_API_KEY/];
let refs = 0;
for (const f of seeds) {
  const src = readFileSync(f, "utf8");
  for (const re of FORBIDDEN) {
    if (re.test(src)) { fail(`pinned-path file ${f} mentions ${re} — the live layer must not be reachable from here`); refs++; }
  }
}
if (refs === 0) pass(`no Mobula hostname, module or env var referenced in the pinned path (${seeds.length} files)`);

// --- 3. no live data inside a pinned report ---------------------------------

const REPORTS = process.argv[2] ?? "calibration/reports";
const LIVE_FIELDS = [
  "liveLayerVersion",
  "fetchedAt",
  "vendorReportedTotalUsd",
  "exposureUsd",
  "unverifiedSymbol",
  "assetContextVersion",
  "candidateVerification",
  "verified_nonzero",
  "verified_zero",
  "assetScenarioVersion",
  "candidate_withdrawal",
  "restrictorsConfirmed",
  "balance_returned_no_data",
  "role_unresolved",
  "assetContextVersion",
  "token_interface_rejected",
];
let dirty = 0;
const reportFiles = existsSync(REPORTS) ? readdirSync(REPORTS).filter((f) => f.endsWith(".json")) : [];
for (const f of reportFiles) {
  const raw = readFileSync(join(REPORTS, f), "utf8");
  if (/mobula/i.test(raw)) { fail(`report ${f} mentions Mobula — live data must never enter a pinned report`); dirty++; }
  for (const field of LIVE_FIELDS) {
    if (raw.includes(`"${field}"`)) { fail(`report ${f} carries live-layer field "${field}"`); dirty++; }
  }
}
if (dirty === 0) pass(`no live-layer field or vendor reference in any of the ${reportFiles.length} pinned reports`);

// --- 4. no secret in a committed artifact -----------------------------------

const COMMITTED = [process.argv[3] ?? "calibration/live", process.argv[4] ?? "site"];
let secrets = 0;
for (const dir of COMMITTED) {
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (!statSync(p).isFile()) continue;
    const raw = readFileSync(p, "utf8");
    // The env var name alone is fine (docs mention it); a name with a value is not.
    if (/MOBULA_API_KEY\s*[:=]\s*["']?[A-Za-z0-9_\-]{8,}/.test(raw)) { fail(`${p} appears to embed a Mobula API key`); secrets++; }
    if (/["']?[Aa]uthorization["']?\s*:\s*["'][A-Za-z0-9_\-]{8,}["']/.test(raw)) { fail(`${p} embeds an Authorization header value`); secrets++; }
  }
}
if (secrets === 0) pass("no API key or Authorization value in any committed sidecar or page");

// --- the note that stops a false alarm later --------------------------------

console.log(
  `\nNote: calibration/live/*.json are DELIBERATELY non-deterministic — each is a\n` +
    `timestamped snapshot of third-party market data and changes on every fetch.\n` +
    `The report-directory determinism comparison covers calibration/reports/ only.\n` +
    `A changed sidecar is expected behaviour, never a determinism regression.`,
);

console.log(`\n${failures} boundary failure(s).`);
process.exit(failures === 0 ? 0 : 1);
