/**
 * Proves that every headline figure on a rendered page came out of the report
 * rather than out of the template.
 *
 * The renderer's honesty rule — "no presentation-layer value is computed or
 * rounded into something the report didn't assert" — is the kind of claim that
 * quietly stops being true the first time someone hard-codes a number into a
 * heading. So each page embeds a manifest of its figures (see scripts/figures.ts),
 * and this script re-derives every one of them independently:
 *
 *   1. the recorded jsonPath must resolve, in the SOURCE report, to exactly the
 *      recorded raw value — so a figure cannot drift from its origin;
 *   2. the rendered string must actually appear in the page body — so a figure
 *      cannot be logged as provenance and then displayed as something else.
 *
 * It also enforces the two properties that are easy to lose in a stylesheet:
 * that no page performs network access, and that an undetermined verdict is not
 * rendered with the healthy tone.
 *
 * Run: node scripts/verify-pages.mjs [siteDir] [reportsDir]
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const siteDir = process.argv[2] ?? "site";
const reportsDir = process.argv[3] ?? "calibration/reports";

function resolvePath(root, path) {
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".");
  let cur = root;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
}

/** Anything that would make a "static page" reach the network at view time. */
const NETWORK_PATTERNS = [
  /<script(?![^>]*type=["']application\/json["'])[^>]*\ssrc=/i,
  /<link[^>]+href=["']https?:/i,
  /\bfetch\s*\(/,
  /XMLHttpRequest/,
  /new\s+WebSocket/,
  /@import\s+url\(/i,
  /<iframe/i,
  /src=["']https?:\/\//i,
];

let failures = 0;
let figuresChecked = 0;
let livePanels = 0;
const fail = (msg) => {
  console.log(`  ✗ ${msg}`);
  failures++;
};

const pages = readdirSync(siteDir).filter((f) => f.endsWith(".html") && f !== "index.html");
if (pages.length === 0) {
  console.error(`no pages found in ${siteDir}`);
  process.exit(2);
}

for (const page of pages.sort()) {
  const label = page.replace(/\.html$/, "");
  const html = readFileSync(join(siteDir, page), "utf8");
  const reportPath = join(reportsDir, `${label}.json`);
  console.log(`${label}`);

  if (!existsSync(reportPath)) {
    fail(`no source report at ${reportPath}`);
    continue;
  }
  const report = JSON.parse(readFileSync(reportPath, "utf8"));

  // --- 1. figures ---
  const m = html.match(/<script type="application\/json" id="ripcord-figures">([\s\S]*?)<\/script>/);
  if (!m) {
    fail("no figure manifest embedded — provenance cannot be checked");
    continue;
  }
  const figures = JSON.parse(m[1]);
  if (figures.length === 0) fail("figure manifest is empty");

  const body = html.replace(/<script type="application\/json"[\s\S]*?<\/script>/, "");
  for (const fig of figures) {
    figuresChecked++;
    const actual = resolvePath(report, fig.jsonPath);
    if (JSON.stringify(actual) !== JSON.stringify(fig.raw)) {
      fail(`figure "${fig.label}": ${fig.jsonPath} is ${JSON.stringify(actual)} in the report but the page recorded ${JSON.stringify(fig.raw)}`);
    }
    if (!body.includes(fig.rendered)) {
      fail(`figure "${fig.label}": rendered as ${JSON.stringify(fig.rendered)} but that string is not on the page`);
    }
  }

  // --- 2. no network at view time ---
  for (const re of NETWORK_PATTERNS) {
    if (re.test(html)) fail(`page contains a network-capable construct matching ${re}`);
  }

  // --- 2b. the live layer, if present, is LABELLED and SEPARATE ---
  //
  // verify-boundary proves the pinned CODE cannot reach the live layer. This
  // proves the rendered PAGE keeps them apart, which is a different claim and
  // the one a reader actually experiences. Three properties:
  //
  //   (a) No figure in the provenance manifest may come from live data. Every
  //       entry must resolve against the pinned report — that is already checked
  //       above, so this asserts the complementary thing: no manifest path may
  //       name a live-layer field. Without it, a future refactor could log a
  //       market number as though the report had asserted it.
  //   (b) The panel must carry its boundary sentence and a machine-readable
  //       fetch timestamp. An unlabelled live figure beside a pinned verdict is
  //       indistinguishable from a pinned figure, which is the whole risk.
  //   (c) The panel must come AFTER the verdict hero in document order, so it
  //       reads as commentary beside the verdict and never as part of it.
  const LIVE_FIELDS = /^(liveLayerVersion|fetchedAt|exposureUsd|vendorReportedTotalUsd|holdings|concentration|withheld)\b/;
  for (const fig of figures) {
    if (LIVE_FIELDS.test(fig.jsonPath)) {
      fail(`figure "${fig.label}" reads ${fig.jsonPath}, which is a live-layer path — provenance must come from the pinned report`);
    }
  }
  const liveIdx = html.indexOf('<section class="lv">');
  if (liveIdx !== -1) {
    livePanels++;
    if (!html.includes("not part of the reproducible verdict")) {
      fail(`the live panel does not carry its boundary label`);
    }
    if (!/<time datetime="20\d\d-\d\d-\d\dT/.test(html) && !html.includes("Live data unavailable") && !html.includes("Live data not fetched")) {
      fail(`the live panel shows data but no machine-readable fetch timestamp`);
    }
    const heroIdx = html.indexOf('<section class="hero');
    if (heroIdx !== -1 && liveIdx < heroIdx) {
      fail(`the live panel is rendered before the verdict — live data must sit beside the verdict, never above it`);
    }
  }

  // --- 3. an unestablished verdict must not wear the healthy tone ---
  const status = report.verdict?.status ?? "undetermined";
  const heroTone = html.match(/<section class="hero (\w+)"/)?.[1];
  const expected =
    status === "can_exit_in_time" || status === "immutable_within_checks"
      ? "good"
      : status === "trapped" || status === "no_notice"
        ? "critical"
        : "unknown";
  if (heroTone !== expected) fail(`verdict "${status}" rendered with tone "${heroTone}", expected "${expected}"`);
  if (expected === "unknown" && heroTone === "good") fail(`an undetermined verdict is wearing the healthy tone`);

  // --- 4. an unproven delay must never be shown as a settled window ---
  const assessment = report.exitWindow?.assessment;
  if (assessment?.status === "not_proven_binding") {
    if (!body.includes("not proven binding")) fail(`nominal delay is present but the page never says "not proven binding"`);
  }

  // --- 5. a partial role reconstruction must render its label and its window ---
  const recon = report.authority?.accessControl?.reconstruction;
  if (recon && recon.complete === false) {
    if (!body.includes("PARTIAL role reconstruction")) fail(`partial reconstruction is not labelled as partial`);
    if (recon.scannedFromBlock && !body.includes(recon.scannedFromBlock)) {
      fail(`partial reconstruction does not show its covered window (from block ${recon.scannedFromBlock})`);
    }
  }

  // --- 6. "nothing to measure" must not render as "not established" ---
  // The day-5 assessment split separated those two claims in the data; a chart
  // that draws them identically puts the conflation straight back.
  if (assessment?.status === "immutable_within_checks") {
    if (!body.includes("no rule-change route found")) fail(`a positively-established no-route result is not labelled as one`);
    if (body.includes("NOT ESTABLISHED")) fail(`a positively-established no-route result is rendered as "NOT ESTABLISHED"`);
    if (!body.includes("Established positively by:")) fail(`the positive basis that earned this status is not shown`);
  }
  if (assessment?.status === "undetermined" && !body.includes("NOT ESTABLISHED")) {
    fail(`an undetermined window is not labelled "NOT ESTABLISHED" on the chart`);
  }

  // --- 7. a halted exit must never render as a duration ---
  if (report.timeToExit?.blockable?.status === "currently_blocked" && !body.includes("HALTED")) {
    fail(`the exit is halted at the pinned block but the page does not say so`);
  }

  // --- 8. only publishable reports may be rendered here ---
  if (report.disclosure?.publishable !== true) fail(`report is not publishable but a page was rendered for it`);
}

// ---------------------------------------------------------------------------
// REPORT-LEVEL INVARIANT: no reassuring verdict on an incomplete enumeration.
//
// This runs over EVERY report, not only the ones that got a page, because the
// invariant is a property of the tool rather than of the published subset.
//
// It is the report analogue of the byte-identity determinism gate: instead of
// pinning one instance of a bug, it makes the whole class impossible to
// reintroduce. The exit window is the MINIMUM notice across authority routes,
// so it is only sound over a route set that was fully seen — an un-enumerated
// role holding a zero-notice power makes the minimum a minimum of the wrong
// set. Two of the 26 calibration protocols were doing exactly that when this
// check was written (Ethena Minting on its own scan, Ethena USDe on its
// depth-1 timelock's), and both said `missing: []` while doing it.
//
// The check derives incompleteness INDEPENDENTLY of src/report/enumeration.ts —
// straight from the reconstruction blocks in the report — so a bug in the
// derivation cannot hide itself here.
// ---------------------------------------------------------------------------

// `no_direct_restriction_found` is a WEAK positive tier: it too is withheld on
// an incomplete privileged surface, so it counts as reassuring for the
// enumeration invariant. (It occurs nowhere in the set this pass — this keeps
// the guard tight if a future run produces one.)
const REASSURING_VERDICT = new Set(["can_exit_in_time", "immutable_within_checks", "no_direct_restriction_found"]);
const REASSURING_WINDOW = new Set(["binding", "immutable_within_checks"]);
const MUST_NOT_BE_REASSURING = new Set(["compound-comet-cusdcv3", "compound-cdai", "compound-unitroller"]);

// ---------------------------------------------------------------------------
// DAY-7 REGISTERED PREDICTIONS (the exit-restriction fork differential).
// Committed BEFORE the engine was written and enforced here, so the outcome
// could not be tuned toward afterwards. Two directions, asymmetric by risk:
//   - The flagship confirmation (Comet) MUST resolve to a decided restriction.
//   - The true negatives MUST survive; nothing may move toward reassurance.
// ---------------------------------------------------------------------------
// Comet: the anchor. The fork confirms the pause guardian can shut withdrawals
// with zero notice, so the verdict must be no_notice and the evaluation must
// carry a fork-confirmed restrictor. If Comet ever comes out reassuring, the
// evaluation is broken (task's own words).
const DAY7_FLAGSHIP = "compound-comet-cusdcv3";
// These were the only reassuring verdicts before day 7 and must be untouched by
// it — the fork engine has no reason to run on a contract with no privileged
// party, and must never demote them either.
const DAY7_TRUE_NEGATIVES = new Set(["weth9", "wsteth"]);

/** Independently collects every site whose role enumeration is not positively complete. */
function incompleteSites(report) {
  const out = [];
  const judge = (where, ac) => {
    if (!ac || !ac.detected) return; // positively not an AccessControl contract
    if (!ac.reconstruction) out.push(`${where} (AccessControl detected, no reconstruction produced)`);
    else if (ac.reconstruction.complete !== true) out.push(`${where} (reconstruction.complete !== true)`);
  };
  judge("target", report.authority?.accessControl);

  // The capability SURFACE, derived here independently of enumeration.ts for the
  // same reason the role check is: if this file imported the derivation it was
  // checking, a bug in that derivation would hide itself. Comet is why the
  // dimension exists — it passed every role check above and still had a guarded,
  // zero-notice `pause` sitting unevaluated among 67 unmatched selectors.
  const caps = report.capabilities;
  const fullyEvaluated = caps && caps.dispatcherRecognized === true && (caps.unmatchedSelectors ?? []).length === 0;
  if (!fullyEvaluated) {
    const parties =
      (report.authority?.owner?.address ? 1 : 0) +
      (report.authority?.pendingOwner?.address ? 1 : 0) +
      (report.proxy?.admin ? 1 : 0) +
      (report.authority?.accessControl?.roles ?? []).filter((r) => (r.members ?? []).length > 0).length +
      (report.authorityIndirection?.markers ?? []).length +
      ((report.authorityResolution?.roots ?? []).length > 0 ? 1 : 0);
    if (parties > 0) out.push(`capabilitySurface (${(caps?.unmatchedSelectors ?? []).length} unevaluated selector(s), ${parties} privileged party/parties)`);
  }

  const walk = (n) => {
    judge(`authority:${n.address}@depth${n.depth}`, {
      detected: n.accessControlDetected,
      reconstruction: n.roleEnumeration,
    });
    for (const c of n.children ?? []) walk(c);
  };
  for (const root of report.authorityResolution?.roots ?? []) walk(root);
  for (const t of report.dependencies?.tokens ?? []) judge(`dependency:${t.token}`, t.authority?.accessControl);
  for (const e of report.errors ?? []) {
    if (["accessControl", "authorityResolution", "dependencies"].includes(e.stage)) out.push(`stage:${e.stage} failed`);
  }
  return out;
}

console.log("\n--- report-level invariant: enumeration completeness reaches the verdict ---");
let reportsChecked = 0;
for (const file of readdirSync(reportsDir).filter((f) => f.endsWith(".json")).sort()) {
  const label = file.replace(/\.json$/, "");
  const report = JSON.parse(readFileSync(join(reportsDir, file), "utf8"));
  reportsChecked++;

  const sites = incompleteSites(report);
  const verdictStatus = report.verdict?.status;
  const windowStatus = report.exitWindow?.assessment?.status;

  if (sites.length > 0) {
    if (REASSURING_VERDICT.has(verdictStatus)) {
      console.log(`${label}`);
      fail(`REASSURING VERDICT "${verdictStatus}" on an incomplete enumeration — ${sites.join("; ")}`);
    }
    if (REASSURING_WINDOW.has(windowStatus)) {
      console.log(`${label}`);
      fail(`REASSURING WINDOW "${windowStatus}" on an incomplete enumeration — ${sites.join("; ")}`);
    }
    // A report must never contradict itself: incomplete below, nothing missing above.
    if ((report.verdict?.missing ?? []).length === 0) {
      console.log(`${label}`);
      fail(`verdict.missing is empty while ${sites.length} enumeration site(s) are incomplete — internally self-contradicting`);
    }
  }

  // REGISTERED PREDICTIONS, enforced. Before the capability-surface rule was
  // written, these three were predicted to come out NON-reassuring, and the
  // prediction was recorded so it could not be quietly tuned toward afterwards.
  // If one goes green again the guard has a hole and the build must fail.
  // Asserts the NEGATIVE rather than an exact status, so a later, better-
  // evidenced bad verdict does not trip it.
  if (MUST_NOT_BE_REASSURING.has(label) && REASSURING_VERDICT.has(verdictStatus)) {
    console.log(`${label}`);
    fail(`verdict "${verdictStatus}" contradicts a REGISTERED PREDICTION that this report must not be reassuring — a privileged party exists over an unevaluated selector surface (see docs/CALIBRATION.md)`);
  }

  // --- DAY-7 flagship prediction: Comet is a fork-confirmed decided restriction. ---
  if (label === DAY7_FLAGSHIP) {
    const er = report.exitRestriction;
    if (verdictStatus !== "no_notice") {
      console.log(`${label}`);
      fail(`DAY-7 PREDICTION: Comet verdict must be "no_notice" (fork-confirmed withdraw-pause guardian), got "${verdictStatus}"`);
    }
    if (!er || er.outcome !== "restrictor_found") {
      console.log(`${label}`);
      fail(`DAY-7 PREDICTION: Comet must carry exitRestriction.outcome="restrictor_found", got "${er?.outcome ?? "null"}"`);
    }
    if (er && er.confirmationMethod !== "fork_confirmed") {
      console.log(`${label}`);
      fail(`DAY-7 PREDICTION: Comet's restrictor must be fork_confirmed, got "${er.confirmationMethod}"`);
    }
    const forkRoute = (report.exitWindow?.routes ?? []).some((r) => r.confirmationMethod === "fork_confirmed");
    if (!forkRoute) {
      console.log(`${label}`);
      fail(`DAY-7 PREDICTION: Comet's exit window must carry a fork_confirmed route`);
    }
  }

  // --- DAY-7 caution-only: the true negatives must survive unchanged. ---
  if (DAY7_TRUE_NEGATIVES.has(label) && verdictStatus !== "immutable_within_checks") {
    console.log(`${label}`);
    fail(`DAY-7 PREDICTION: true negative "${label}" must remain immutable_within_checks, got "${verdictStatus}"`);
  }

  // --- DAY-7 structural invariants on any exit-restriction block. ---
  if (report.exitRestriction) {
    const er = report.exitRestriction;
    // restrictor_found ⟺ a restrictor is actually recorded, and it must be fork-confirmed.
    const hasRestrictor = (er.restrictors ?? []).length > 0;
    if ((er.outcome === "restrictor_found") !== hasRestrictor) {
      console.log(`${label}`);
      fail(`exitRestriction.outcome="${er.outcome}" disagrees with ${er.restrictors?.length ?? 0} restrictor(s) recorded`);
    }
    if (hasRestrictor && er.confirmationMethod !== "fork_confirmed") {
      console.log(`${label}`);
      fail(`a restrictor is recorded but confirmationMethod is "${er.confirmationMethod}", not fork_confirmed`);
    }
    // The weak positive tier is unreachable without a confidently identified
    // exit action AND an established baseline — the riskiest-false-clean gate.
    if (verdictStatus === "no_direct_restriction_found") {
      if (er.exitAction?.status !== "identified" || er.baseline?.status !== "established") {
        console.log(`${label}`);
        fail(`verdict "no_direct_restriction_found" without an identified exit action (${er.exitAction?.status}) and an established baseline (${er.baseline?.status})`);
      }
      if (er.coverage.evaluated !== er.coverage.guardedTotal) {
        console.log(`${label}`);
        fail(`verdict "no_direct_restriction_found" while ${er.coverage.guardedTotal - er.coverage.evaluated} guarded function(s) were left unevaluated`);
      }
    }
  }

  // The derived witness must agree with the independent derivation above.
  const claimed = report.enumeration?.complete;
  if (claimed === undefined) {
    console.log(`${label}`);
    fail(`report carries no enumeration witness at all`);
  } else if (claimed !== (sites.length === 0)) {
    console.log(`${label}`);
    fail(`enumeration.complete=${claimed} disagrees with an independent read of the report (${sites.length} incomplete site(s))`);
  }
}
console.log(`${reportsChecked} reports checked for the enumeration invariant`);

console.log(
  `\n${pages.length} pages · ${figuresChecked} figures checked against their source reports · ${livePanels} live panel(s) checked for separation · ${reportsChecked} reports checked for the enumeration invariant · ${failures} failure(s)`,
);
process.exit(failures === 0 ? 0 : 1);
