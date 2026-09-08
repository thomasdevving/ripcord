/**
 * Deterministic, network-free baseline for the committed report corpus.
 *
 * This measures two growth surfaces that correctness tests do not make visible:
 * selector-classification coverage and the amount of evidence serialized into
 * reports. Timing is deliberately kept out; hardware-dependent selector timing
 * lives in benchmark-selectors.ts instead.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
let directory = "calibration/reports";
let directorySet = false;
let checkPath = null;
let asJson = false;
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === "--json") {
    asJson = true;
  } else if (arg === "--check") {
    checkPath = args[++index] ?? null;
    if (!checkPath) {
      console.error("usage: report-baseline.mjs [report-directory] [--json] [--check snapshot.json]");
      process.exit(2);
    }
  } else if (arg?.startsWith("--") || directorySet) {
    console.error(`Unknown or duplicate argument: ${arg}`);
    process.exit(2);
  } else if (arg) {
    directory = arg;
    directorySet = true;
  }
}

const files = readdirSync(directory).filter((name) => name.endsWith(".json")).sort();
if (files.length === 0) {
  console.error(`No JSON reports found in ${directory}; an empty corpus is not a baseline.`);
  process.exit(1);
}

const versionCounts = new Map();
const rows = [];

for (const file of files) {
  const raw = readFileSync(join(directory, file), "utf8");
  const report = JSON.parse(raw);
  if (!report?.capabilities || !report?.disclosure || !report?.schemaVersion || !report?.rulesetVersion) {
    throw new Error(`${file} is not a complete Ripcord report`);
  }

  const capabilities = report.capabilities;
  const selectors = Number(capabilities.selectorsExtracted ?? 0);
  const classified = capabilities.findings?.length ?? 0;
  const manual = capabilities.needsManualVerification?.length ?? 0;
  const unmatched = capabilities.unmatchedSelectors?.length ?? 0;
  const accounted = classified + manual + unmatched;
  if (selectors !== accounted) {
    throw new Error(`${file} accounts for ${accounted}/${selectors} recovered selectors`);
  }

  const evidence = [];
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (value.kind && value.params && "rawValue" in value && "block" in value) {
      evidence.push(JSON.stringify(value));
      return;
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(report);

  const uniqueEvidence = new Set(evidence);
  const evidenceBytes = evidence.reduce((sum, entry) => sum + Buffer.byteLength(entry), 0);
  const uniqueEvidenceBytes = [...uniqueEvidence].reduce((sum, entry) => sum + Buffer.byteLength(entry), 0);
  const version = `${report.schemaVersion}/${report.rulesetVersion}`;
  versionCounts.set(version, (versionCounts.get(version) ?? 0) + 1);

  rows.push({
    file,
    bytes: Buffer.byteLength(raw),
    publishable: report.disclosure.publishable === true,
    dispatcherRecognized: capabilities.dispatcherRecognized === true,
    selectors,
    classified,
    manual,
    unmatched,
    evidenceEntries: evidence.length,
    uniqueEvidenceEntries: uniqueEvidence.size,
    evidenceBytes,
    uniqueEvidenceBytes,
  });
}

const sum = (key) => rows.reduce((total, row) => total + row[key], 0);
const byBytes = [...rows].sort((a, b) => b.bytes - a.bytes || a.file.localeCompare(b.file));
const byDuplicateEvidence = [...rows].sort((a, b) =>
  (b.evidenceBytes - b.uniqueEvidenceBytes) - (a.evidenceBytes - a.uniqueEvidenceBytes) || a.file.localeCompare(b.file));
const evidenceBytes = sum("evidenceBytes");
const uniqueEvidenceBytes = sum("uniqueEvidenceBytes");
const selectors = sum("selectors");
const classified = sum("classified");
const manual = sum("manual");
const unmatched = sum("unmatched");
const ratio = (numerator, denominator) => denominator === 0 ? 0 : Number((numerator / denominator).toFixed(6));

const baseline = {
  format: "ripcord-report-baseline/v1",
  reports: rows.length,
  publishableReports: rows.filter((row) => row.publishable).length,
  versions: Object.fromEntries([...versionCounts.entries()].sort(([a], [b]) => a.localeCompare(b))),
  reportBytes: sum("bytes"),
  largestReport: { file: byBytes[0].file, bytes: byBytes[0].bytes },
  selectors: {
    dispatcherRecognizedReports: rows.filter((row) => row.dispatcherRecognized).length,
    extracted: selectors,
    classified,
    manualVerification: manual,
    unmatched,
    classifiedRatio: ratio(classified, selectors),
    evaluatedRatio: ratio(classified + manual, selectors),
  },
  evidence: {
    entries: sum("evidenceEntries"),
    uniqueEntriesWithinReports: sum("uniqueEvidenceEntries"),
    serializedBytes: evidenceBytes,
    uniqueSerializedBytesWithinReports: uniqueEvidenceBytes,
    duplicateSerializedBytes: evidenceBytes - uniqueEvidenceBytes,
    duplicateRatio: ratio(evidenceBytes - uniqueEvidenceBytes, evidenceBytes),
    mostDuplicatedReport: {
      file: byDuplicateEvidence[0].file,
      duplicateSerializedBytes: byDuplicateEvidence[0].evidenceBytes - byDuplicateEvidence[0].uniqueEvidenceBytes,
    },
  },
};

if (checkPath) {
  const expected = JSON.parse(readFileSync(checkPath, "utf8"));
  if (JSON.stringify(expected) !== JSON.stringify(baseline)) {
    console.error(`Report baseline changed from ${checkPath}.`);
    console.error("Expected:");
    console.error(JSON.stringify(expected, null, 2));
    console.error("Actual:");
    console.error(JSON.stringify(baseline, null, 2));
    process.exit(1);
  }
  if (!asJson) console.log(`Report baseline matches ${checkPath}.`);
}

if (asJson) {
  console.log(JSON.stringify(baseline, null, 2));
} else if (!checkPath) {
  console.log(`${baseline.reports} reports (${baseline.publishableReports} publishable), ${baseline.reportBytes} bytes`);
  console.log(`selectors: ${classified}/${selectors} classified, ${manual} manual, ${unmatched} unmatched`);
  console.log(`evidence: ${baseline.evidence.serializedBytes} bytes, ${baseline.evidence.duplicateSerializedBytes} duplicate (${(baseline.evidence.duplicateRatio * 100).toFixed(1)}%)`);
  console.log(`largest: ${baseline.largestReport.file} (${baseline.largestReport.bytes} bytes)`);
}
