/**
 * THE WEBAPP BOUNDARY, AS A TEST RATHER THAN A PROMISE.
 *
 * Sibling of scripts/verify-boundary.mjs, which does the same job for the Mobula
 * live layer. Both exist because "we were careful" is not a control.
 *
 * Seven properties, each corresponding to a way this integration could quietly go
 * wrong:
 *
 *  1. THE SHARED DTO MODULE IMPORTS NO NODE BUILTIN. It is compiled into the
 *     browser bundle. A `node:fs` import there either breaks the build or, worse,
 *     drags server code into a public asset.
 *
 *  2. BROWSER CODE NEVER VALUE-IMPORTS THE ENGINE. `import type` is erased and is
 *     fine — it is how the report type stays single-sourced. A value import would
 *     ship detector code, zod, and potentially the taxonomy to every visitor, and
 *     would create a second place risk logic could be evaluated.
 *
 *  3. NO SECRET IN THE BUILT BUNDLE. Checked against the actual built output, not
 *     the sources: a `VITE_`-prefixed variable is inlined at BUILD time, which is
 *     how provider keys end up in a JS file. There are none, and this proves it.
 *
 *  4. NO NODE BUILTIN IN THE BUILT BUNDLE, for the same reason as (1) but
 *     measured on the artifact that actually ships.
 *
 *  5. THE SERVER NEVER IMPORTS THE CLI. `src/cli.ts` parses argv and calls
 *     process.exit; importing it as a library is the mistake this codebase would
 *     be most likely to make under time pressure.
 *
 *  6. THE PINNED PATH NEVER IMPORTS THE SERVER. The engine must stay usable, and
 *     deterministic, with no webapp present at all. A transitive import walk, the
 *     same technique verify-boundary.mjs uses.
 *
 *  7. THE PRODUCTION IMAGE CARRIES THE MOBULA SIDECARS. The report API reads
 *     committed snapshots at runtime. Excluding calibration/live from the build
 *     context or failing to copy it makes every deployed report silently look as
 *     if no snapshot was stored.
 *
 * Deliberately NARROW, and it says so: it checks these seven things and prints what
 * a human still has to look at. A checker that implied full coverage would be its
 * own false-clean.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, extname, dirname, resolve } from "node:path";

let failures = 0;
const fail = (msg) => {
  console.log(`✗ ${msg}`);
  failures++;
};
const pass = (msg) => console.log(`✓ ${msg}`);

function walk(dir, exts, acc = []) {
  if (!existsSync(dir)) return acc;
  if (statSync(dir).isFile()) {
    if (exts.includes(extname(dir))) acc.push(dir);
    return acc;
  }
  for (const entry of readdirSync(dir)) walk(join(dir, entry), exts, acc);
  return acc;
}

const TS = [".ts", ".tsx"];

// --- 1. the shared DTO module is Node-free -----------------------------------

const sharedFiles = walk("server/shared", TS);
let sharedBad = 0;
for (const file of sharedFiles) {
  const src = readFileSync(file, "utf8");
  if (/from\s+["']node:/.test(src) || /require\(\s*["']node:/.test(src)) {
    fail(`${file} imports a Node builtin, but it is compiled into the browser bundle`);
    sharedBad++;
  }
}
if (sharedBad === 0) pass(`no Node builtin imported by the shared DTO module (${sharedFiles.length} file(s))`);

// --- 2. browser code value-imports neither the engine nor the server ---------

const webFiles = walk("web/src", TS);
let webBad = 0;
for (const file of webFiles) {
  const src = readFileSync(file, "utf8");
  // Strip block and line comments so prose about imports is not matched.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const importRe = /(?:^|\n)\s*import\s+(type\s+)?([\s\S]*?)from\s+["']([^"']+)["']/g;
  let m;
  while ((m = importRe.exec(code)) !== null) {
    const [, typeKeyword, clause, spec] = m;
    const reachesEngine = spec.includes("src/report") || spec.includes("src/detect") || spec.includes("src/chain") || spec.includes("src/fork") || spec.includes("src/live");
    const reachesServer = /(^|\/)server\//.test(spec) && !spec.includes("server/shared") && !spec.includes("@shared");
    if (!reachesEngine && !reachesServer) continue;
    // `import type { … }` and inline `{ type X }` are erased before bundling.
    const isTypeOnly = Boolean(typeKeyword) || /^\s*\{\s*type\s/.test(clause);
    if (!isTypeOnly) {
      fail(`${file} value-imports "${spec}" — browser code must not ship engine or server modules (use \`import type\`)`);
      webBad++;
    }
  }
  if (/from\s+["']node:/.test(code)) {
    fail(`${file} imports a Node builtin`);
    webBad++;
  }
}
if (webBad === 0) pass(`no value import from the engine or server, and no Node builtin, in browser code (${webFiles.length} file(s))`);

// --- 3 & 4. the BUILT bundle: no secret, no Node builtin ---------------------

const distWeb = process.argv[2] ?? "dist-web";
if (!existsSync(distWeb)) {
  console.log(`… skipped the built-bundle checks: ${distWeb} does not exist (run \`pnpm build:web\` first)`);
} else {
  // Source maps are excluded: they legitimately contain the sources, and the
  // sources legitimately mention these names in comments and type imports.
  const assets = walk(distWeb, [".js", ".css", ".html"]);
  let bundleBad = 0;
  const SECRET_SHAPES = [
    { re: /\bRPC_URL_\d+\s*[:=]\s*["'][^"']{8,}/, what: "an RPC URL variable with a value" },
    { re: /https?:\/\/[a-z0-9.-]*(alchemy|infura|quicknode|blastapi|ankr)[a-z0-9.-]*\/[A-Za-z0-9_\-/]{12,}/i, what: "a provider endpoint with a path key" },
    { re: /\bMOBULA_API_KEY\s*[:=]\s*["'][A-Za-z0-9_-]{8,}/, what: "a Mobula API key" },
    { re: /["']?[Aa]uthorization["']?\s*:\s*["'][A-Za-z0-9_\-.]{16,}["']/, what: "an Authorization header value" },
  ];
  for (const asset of assets) {
    const src = readFileSync(asset, "utf8");
    for (const { re, what } of SECRET_SHAPES) {
      if (re.test(src)) {
        fail(`${asset} appears to embed ${what}`);
        bundleBad++;
      }
    }
    if (extname(asset) === ".js" && /require\(["']node:|from["']node:/.test(src.replace(/\s/g, ""))) {
      fail(`${asset} references a Node builtin`);
      bundleBad++;
    }
    // The engine's own module names should not appear as bundled code.
    for (const marker of ["buildReport", "runExitRestrictionEngine", "PinnedChain", "detectCapabilities"]) {
      if (new RegExp(`\\b${marker}\\s*\\(`).test(src)) {
        fail(`${asset} appears to CALL ${marker} — engine logic must not run in the browser`);
        bundleBad++;
      }
    }
  }
  if (bundleBad === 0) pass(`no secret, Node builtin or engine call in the built bundle (${assets.length} asset(s))`);
}

// --- 5. the server never imports the CLI -------------------------------------

const serverFiles = walk("server", TS);
let cliImports = 0;
for (const file of serverFiles) {
  const src = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  if (/from\s+["'][^"']*src\/cli(\.js)?["']/.test(src)) {
    fail(`${file} imports src/cli — that module parses argv and exits the process; import the engine functions instead`);
    cliImports++;
  }
}
if (cliImports === 0) pass(`no server module imports the CLI (${serverFiles.length} file(s))`);

// --- 6. the pinned path never imports the server -----------------------------

const PINNED_ROOTS = ["src/cli.ts", "src/chain", "src/detect", "src/report", "src/fork"];

function resolveImport(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec).replace(/\.js$/, "");
  for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function importsOf(file) {
  const src = readFileSync(file, "utf8");
  const specs = [];
  const re = /(?:^|\n)\s*(?:import|export)[\s\S]{0,200}?from\s+["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(src)) !== null) specs.push(m[1]);
  return specs.map((s) => resolveImport(file, s)).filter(Boolean);
}

const seeds = PINNED_ROOTS.flatMap((root) => walk(root, [".ts"]));
const seen = new Set();
const stack = [...seeds];
let leak = null;
while (stack.length) {
  const file = stack.pop();
  const rel = file.replace(process.cwd() + "/", "");
  if (seen.has(rel)) continue;
  seen.add(rel);
  if (rel.startsWith("server/") || rel.startsWith("web/")) {
    leak = rel;
    break;
  }
  for (const dep of importsOf(file)) stack.push(dep);
}
if (leak) fail(`the pinned engine path reaches the webapp: ${leak} — the engine must stay usable with no webapp present`);
else pass(`no import path from the pinned engine into server/ or web/ (${seen.size} modules walked transitively)`);

// --- 7. the production image carries committed Mobula sidecars --------------

const dockerfile = readFileSync("Dockerfile", "utf8");
const dockerignore = readFileSync(".dockerignore", "utf8");
const liveIgnored = /^\s*calibration\/live\/?\s*$/m.test(dockerignore);
const liveCopied = /^\s*COPY\s+calibration\/live\/?\s+\.\/calibration\/live\/?\s*$/m.test(dockerfile);
const liveConfigured = /RIPCORD_LIVE_SIDECAR_DIR=\/app\/calibration\/live\b/.test(dockerfile);

if (liveIgnored) fail(".dockerignore excludes calibration/live, so committed Mobula snapshots cannot enter the production image");
if (!liveCopied) fail("Dockerfile does not copy calibration/live into the production image");
if (!liveConfigured) fail("Dockerfile does not point RIPCORD_LIVE_SIDECAR_DIR at the copied snapshot directory");
if (!liveIgnored && liveCopied && liveConfigured) pass("production image includes and configures committed Mobula sidecars");

// --- what this does NOT check ------------------------------------------------

console.log(
  `\nScope: this checks seven structural properties. It does NOT verify UI copy, the\n` +
    `disclosure gate's runtime behaviour (test/webappJobs.test.ts covers that), or\n` +
    `that the rendered figures match a report (scripts/verify-pages.mjs does, for\n` +
    `the committed calibration pages). A green run here is not a review.`,
);

console.log(`\n${failures} webapp boundary failure(s).`);
process.exit(failures === 0 ? 0 : 1);
