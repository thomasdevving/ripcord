/**
 * Determinism gate: two directories of Ripcord reports must be byte-identical
 * once `generatedAt` (the only intentionally non-deterministic field) is
 * normalised. Anything else that differs is a determinism defect — the cache
 * boundary is where a value from the network and a value from disk must be
 * indistinguishable, and this is the cheap check that proves they are.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const [a, b] = process.argv.slice(2);
if (!a || !b) { console.error("usage: compare-reports.mjs <dirA> <dirB>"); process.exit(2); }

const norm = (p) => {
  const raw = readFileSync(p, "utf8");
  const json = JSON.parse(raw);
  json.generatedAt = "<normalised>";
  return JSON.stringify(json, null, 2) + "\n";
};

const filesA = readdirSync(a).filter((f) => f.endsWith(".json"));
const filesB = readdirSync(b).filter((f) => f.endsWith(".json"));
const files = [...new Set([...filesA, ...filesB])].sort();
if (files.length === 0) {
  console.error("No reports to compare; an empty run cannot establish determinism.");
  process.exit(1);
}
let bad = 0;
for (const f of files) {
  let A, B;
  try { A = norm(join(a, f)); } catch (e) { console.log(`✗ ${f}: unreadable in A (${e.message})`); bad++; continue; }
  try { B = norm(join(b, f)); } catch (e) { console.log(`✗ ${f}: unreadable in B (${e.message})`); bad++; continue; }
  const ha = createHash("sha256").update(A).digest("hex").slice(0, 16);
  const hb = createHash("sha256").update(B).digest("hex").slice(0, 16);
  if (A === B) { console.log(`✓ ${f}  sha256:${ha}  ${A.length}b`); }
  else {
    bad++;
    console.log(`✗ ${f}  A:${ha} B:${hb}  (${A.length}b vs ${B.length}b)`);
    // Show the first structural divergence so the defect is locatable, not just flagged.
    const la = A.split("\n"), lb = B.split("\n");
    for (let i = 0; i < Math.max(la.length, lb.length); i++) {
      if (la[i] !== lb[i]) {
        console.log(`    first divergence at line ${i + 1}:`);
        console.log(`      A: ${(la[i] ?? "<eof>").slice(0, 200)}`);
        console.log(`      B: ${(lb[i] ?? "<eof>").slice(0, 200)}`);
        break;
      }
    }
  }
}
console.log(`\n${files.length - bad}/${files.length} byte-identical (generatedAt normalised)`);
process.exit(bad === 0 ? 0 : 1);
