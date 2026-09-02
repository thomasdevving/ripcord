/**
 * Day-5 calibration: every needsManualVerification entry across a set of reports,
 * with its probe revert DECODED. The disclosure gate blocks publication on these,
 * so its false-alarm rate is exactly "how many of these are demonstrably guarded
 * after all" — which can only be answered by looking at what the contract said.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function decodeRevert(raw) {
  if (typeof raw !== "string" || !raw.startsWith("0x")) return { kind: "non-hex", text: JSON.stringify(raw) };
  // "0x" is NOT an empty revert — it is a SUCCESSFUL call that returned no data.
  //
  // client.ts's probeCall records `rawValue = revertData ?? "reverted"` when the
  // call reverted, and `result ?? "0x"` when it did not. So the literal "0x"
  // can only be produced by a call that RAN TO COMPLETION. Labelling it "(no
  // revert data returned)" was a real error in this script: it made the
  // strongest-looking observation in the whole set — a privileged-looking
  // function executing for a stranger — read as the weakest one, a provider
  // quirk (KNOWN EDGE #4). Found day 6 while auditing the four blocked reports
  // before publication.
  //
  // It is not a vulnerability on the one target where it occurs: PAID proxy 2's
  // mint(address,uint256) succeeds for ANY caller including the owner and
  // changes NO state — verified on a fork, tx status success, Δsupply 0,
  // Δbalance 0. A dead stub, not an open mint. But the distinction has to be
  // visible in the output, because "it ran" and "we could not read the revert"
  // are different facts and only one of them would matter if it were real.
  if (raw === "0x") return { kind: "EXECUTED", text: "(call SUCCEEDED — no revert at all)" };
  if (raw.startsWith("0x08c379a0")) {
    try {
      const b = Buffer.from(raw.slice(10), "hex");
      const off = Number(BigInt("0x" + b.subarray(0, 32).toString("hex")));
      const len = Number(BigInt("0x" + b.subarray(off, off + 32).toString("hex")));
      return { kind: "Error(string)", text: b.subarray(off + 32, off + 32 + len).toString("utf8") };
    } catch { return { kind: "Error(string)", text: "(undecodable)" }; }
  }
  return { kind: "custom-error", text: raw.slice(0, 10) + (raw.length > 10 ? ` +${(raw.length - 10) / 2}b args` : "") };
}

const dirs = process.argv.slice(2);
const all = [];
for (const dir of dirs) {
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const raw = readFileSync(join(dir, f), "utf8");
    if (raw.trim() === "") { console.log(`(skipping ${f}: still being written)`); continue; }
    const r = JSON.parse(raw);
    for (const e of r.capabilities.needsManualVerification) {
      const distinct = [...new Set(e.probes.map((p) => JSON.stringify(p.rawValue)))];
      const d = decodeRevert(e.probes[0].rawValue);
      all.push({ report: f.replace(/\.json$/, ""), signature: e.signature, category: e.category, kind: d.kind, revert: d.text, identicalAcrossProbes: distinct.length === 1 });
    }
  }
}
for (const a of all) console.log(`${a.report.padEnd(28)} ${a.signature.padEnd(38)} ${a.kind.padEnd(14)} ${a.identicalAcrossProbes ? "same×3" : "VARIES"}  ${JSON.stringify(a.revert)}`);
console.log(`\n${all.length} needsManualVerification entries across ${dirs.length} director(ies)`);
