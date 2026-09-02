/**
 * Calibration summariser: one line per report, plus the machine-readable roll-up
 * the write-up quotes. Reads ONLY what the report asserts — no derived judgement,
 * no rounding into a figure the JSON does not contain.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const asJson = process.argv.includes("--json");
const rows = [];
for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
  const r = JSON.parse(readFileSync(join(dir, f), "utf8"));
  const ew = r.exitWindow, tte = r.timeToExit, v = r.verdict;
  rows.push({
    label: f.replace(/\.json$/, ""),
    address: r.target.address,
    proxy: r.proxy.pattern,
    verdict: v?.status ?? "(none)",
    verdictConfidence: v?.confidence ?? null,
    window: ew?.assessment.status ?? "(none)",
    windowSeconds: ew?.assessment.status === "binding" ? ew.assessment.windowSeconds : null,
    nominalDelaySeconds: ew?.assessment.status === "not_proven_binding" ? ew.assessment.nominalDelaySeconds : null,
    routes: ew?.routes.length ?? 0,
    rolePrivilege: (ew?.routes ?? []).map((x) => `${x.label}=${x.rolePrivilege}`),
    unverifiedRoutes: (ew?.routes ?? []).filter((x) => x.rolePrivilege === "unverified").length,
    bypasses: (ew?.bypasses ?? []).map((b) => b.kind),
    tte: tte?.status ?? "(none)",
    tteSeconds: tte?.atLeastSeconds ?? null,
    tteTight: tte?.tight ?? null,
    blockable: tte?.blockable.status ?? null,
    selectors: r.capabilities.selectorsExtracted,
    findings: r.capabilities.findings.length,
    needsManual: r.capabilities.needsManualVerification.length,
    unmatched: r.capabilities.unmatchedSelectors.length,
    dispatcher: r.capabilities.dispatcherRecognized,
    publishable: r.disclosure.publishable,
    blockedBy: r.disclosure.blockedBy.map((b) => b.signature),
    unknowns: r.unknowns.length,
    errors: r.errors.length,
    powerHolders: r.powerHolders.length,
    paths: (r.authorityResolution?.paths ?? []).map((p) => `${p.label}→${p.effectiveControllerType ?? "?"}(${p.terminationReason},d${p.hops.length})`),
  });
}
if (asJson) { console.log(JSON.stringify(rows, null, 2)); process.exit(0); }
const pad = (s, n) => String(s).padEnd(n).slice(0, n);
console.log(pad("label", 28), pad("verdict", 27), pad("window", 24), pad("tte", 22), pad("sel/f/m/u", 16), "pub err unk");
console.log("-".repeat(140));
for (const r of rows) {
  console.log(
    pad(r.label, 28),
    pad(`${r.verdict} (${r.verdictConfidence})`, 27),
    pad(r.windowSeconds ? `${r.window} ${r.windowSeconds}s` : r.nominalDelaySeconds ? `${r.window} nom ${r.nominalDelaySeconds}s` : r.window, 24),
    pad(`${r.tte}${r.tteSeconds !== null ? " " + r.tteSeconds + "s" : ""}${r.tteTight ? " tight" : ""}`, 22),
    pad(`${r.selectors}/${r.findings}/${r.needsManual}/${r.unmatched}`, 16),
    `${r.publishable ? "Y" : "n"}   ${r.errors}   ${r.unknowns}`,
  );
}
console.log("-".repeat(140));
console.log(`${rows.length} reports · publishable ${rows.filter((r) => r.publishable).length} · with errors ${rows.filter((r) => r.errors > 0).length} · unverified role routes ${rows.reduce((a, r) => a + r.unverifiedRoutes, 0)}`);
