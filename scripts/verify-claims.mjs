#!/usr/bin/env node
/**
 * Narrative-claim audit: check the SENTENCES against the REPORTS.
 *
 * `verify-pages.mjs` already re-derives every headline figure on every rendered
 * page from its source JSON. The prose in README.md, CLAUDE.md and
 * docs/*.md has no such protection — and on day 6 that gap produced a real
 * error: the PAID demo beat asserted that one contract both had `paused()` true
 * AND produced a $748.90 drain proof. Neither contract has both. The claim
 * survived three days and was caught only when the documented reproduce command
 * was actually run from a clean clone.
 *
 * One conflation found means the class is present, so this checks the rest
 * mechanically. It is deliberately NARROW: it verifies the claims that can be
 * resolved to a report field, and PRINTS the ones a human still has to read.
 * A checker that pretended to cover everything would be its own kind of
 * false-clean.
 *
 * Usage: node scripts/verify-claims.mjs [docsDir=.] [reportsDir=calibration/reports]
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const reportsDir = process.argv[3] ?? "calibration/reports";
// test/fixtures/targets.json is included deliberately: it is the manual
// verification LOG, i.e. prose asserting what was observed, and prose is exactly
// what drifts. Its claims are as checkable as the README's and no more trusted.
// docs/MOBULA.md is DELIBERATELY absent from this list. Every figure in it is a
// LIVE market observation stamped with the instant it was read, not a claim about
// a pinned report — Lido's native-ETH balance and cbETH's vendor total change
// whenever anyone fetches them. Checking them against calibration/reports/ would
// fail by construction, and checking them against the sidecars would fail on the
// next fetch. That document states its own observation instant instead, and says
// so where the figures appear. The exclusion is a decision, not an oversight.
const docs = ["README.md", "CLAUDE.md", "docs/TECHNICAL.md", "docs/CALIBRATION.md", "docs/QUESTIONNAIRES.md", "docs/WEBAPP.md", "docs/RAILWAY.md", "test/fixtures/targets.json"].filter(existsSync);

const reports = {};
for (const f of readdirSync(reportsDir).filter((f) => f.endsWith(".json"))) {
  reports[f.replace(/\.json$/, "")] = JSON.parse(readFileSync(join(reportsDir, f), "utf8"));
}
const byAddress = {};
for (const [label, r] of Object.entries(reports)) byAddress[r.target.address.toLowerCase()] = { label, r };

const failures = [];
const notes = [];
const checked = [];
const fail = (doc, msg) => failures.push(`${doc}: ${msg}`);
const ok = (doc, msg) => checked.push(`${doc}: ${msg}`);

// --- 1. Every 0x address mentioned in prose that we HAVE a report for: any
//        verdict/status word claimed near it must match that report. ---
const VERDICTS = [
  "no_notice",
  "can_exit_in_time",
  "trapped",
  "undetermined",
  "immutable_within_checks",
  "no_direct_restriction_found",
];

/**
 * Human names for reports, so a MARKDOWN TABLE ROW that names a protocol and a
 * verdict is checkable too. This is the class that slipped through on day 6:
 * CALIBRATION.md's per-protocol table listed "Ethena USDe | can_exit_in_time"
 * long after the enumeration fix had moved it to `undetermined`, contradicting
 * another section of the SAME document. Nothing caught it, because the row names
 * no address.
 *
 * Deliberately explicit rather than fuzzy-matched: a wrong alias would silently
 * check the wrong report, which is worse than checking nothing.
 */
const ALIASES = {
  "weth9": ["WETH9"],
  "wsteth": ["wstETH"],
  "compound-comet-cusdcv3": ["Compound Comet cUSDCv3", "Compound Comet", "Comet cUSDCv3"],
  "uniswap-v3-factory": ["Uniswap v3 Factory"],
  "ethena-usde": ["Ethena USDe"],
  "ethena-minting": ["Ethena Minting"],
  "ethena-susde": ["Ethena sUSDe"],
  "usdc": ["USDC"],
  "cbeth": ["cbETH"],
  "frax-share-fxs": ["FXS"],
  "morpho-blue": ["Morpho Blue"],
  "dai": ["DAI"],
  "mkr": ["MKR"],
  "balancer-vault": ["Balancer Vault"],
  "steth": ["stETH"],
  "reth": ["rETH"],
  "usdt": ["USDT"],
  "curve-3pool": ["Curve 3pool"],
  "compound-cdai": ["Compound cDAI"],
  "compound-unitroller": ["Compound Unitroller"],
  "aave-pool-addresses-provider": ["Aave PoolAddressesProvider"],
  "aave-v3-acl-manager": ["Aave v3 ACLManager", "Aave ACLManager"],
  "lido-withdrawal-queue": ["Lido Withdrawal Queue"],
  "wasabi-perp-manager": ["Wasabi"],
};

for (const doc of docs) {
  const text = readFileSync(doc, "utf8");

  // --- 2. Dollar figures must appear in some report's proof.totalUsd. ---
  // A trailing magnitude suffix ($540M, $1.2bn) is a deliberate rounding of a
  // figure stated exactly elsewhere, not a claim in its own right — matching it
  // against an exact total would produce noise, not safety.
  const dollars = [...text.matchAll(/\$([0-9][0-9,]*(?:\.[0-9]{1,2})?)(\s*(?:[KMB]|bn|m\b))?/gi)]
    .filter((m) => !m[2])
    .map((m) => m[1].replace(/,/g, ""));
  const knownTotals = new Set();
  for (const [, r] of Object.entries(reports)) {
    if (r.proof?.produced && typeof r.proof.totalUsd === "number") {
      knownTotals.add(r.proof.totalUsd.toFixed(2));
      for (const d of r.proof.deltas ?? []) if (typeof d.usd === "number") knownTotals.add(d.usd.toFixed(2));
    }
  }
  // An explicitly RETRACTED figure is allowed to appear: a correction has to be
  // able to name the number it is retracting, or it cannot be read. The marker
  // is required to sit in the same paragraph, so it cannot silently license a
  // figure elsewhere in the document.
  const retracted = new Set();
  for (const para of text.split(/\n\s*\n/)) {
    if (!/\[retracted-figure\]/.test(para)) continue;
    for (const m of para.matchAll(/\$([0-9][0-9,]*(?:\.[0-9]{1,2})?)/g)) retracted.add(m[1].replace(/,/g, ""));
  }

  for (const d of new Set(dollars)) {
    const n = Number(d);
    if (!Number.isFinite(n) || n < 100) continue; // small numbers are prose, not proof figures
    const norm = n.toFixed(2);
    if (retracted.has(d)) { ok(doc, `$${d} is explicitly marked [retracted-figure]`); continue; }
    if (knownTotals.has(norm)) ok(doc, `$${d} matches a proof figure in the committed reports`);
    else fail(doc, `$${d} appears in prose but matches NO proof.totalUsd or delta.usd in ${reportsDir}`);
  }

  // --- 3. A claim of the form "<address> ... <verdict>" within one paragraph. ---
  // Paragraph = a blank-line-delimited block in Markdown. A JSON verification
  // log has no blank lines, so splitting it that way would make the WHOLE file
  // one paragraph and pair every address with every verdict word — noise that
  // would train a reader to ignore this check. Split it per line instead, which
  // is one target-note per unit in practice.
  const units = doc.endsWith(".json") ? text.split(/\n/) : text.split(/\n\s*\n/);
  for (const para of units) {
    const addrs = [...para.matchAll(/0x[0-9a-fA-F]{40}/g)].map((m) => m[0].toLowerCase());
    for (const a of new Set(addrs)) {
      const hit = byAddress[a];
      if (!hit) continue;
      for (const v of VERDICTS) {
        // Only judge a verdict word written as a code span or bare token.
        const re = new RegExp(`\`?${v}\`?`);
        if (!re.test(para)) continue;
        const actual = hit.r.verdict.status;
        const windowStatus = hit.r.exitWindow?.assessment?.status;
        if (v === actual || v === windowStatus) ok(doc, `${hit.label} (${a.slice(0, 10)}…) "${v}" matches`);
        else notes.push(`${doc}: paragraph mentions ${hit.label} (${a.slice(0, 10)}…) and the word "${v}", but its verdict is "${actual}" / window "${windowStatus}" — READ THIS PARAGRAPH`);
      }
    }
  }

  // --- 3b. A MARKDOWN TABLE ROW naming a protocol and a verdict. ---
  for (const line of text.split(/\n/)) {
    if (!line.trimStart().startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim());
    for (const [label, names] of Object.entries(ALIASES)) {
      const r = reports[label];
      if (!r) continue;
      // The protocol name must be the row's FIRST cell, so a passing mention
      // elsewhere in a wide row is not read as a claim about that protocol.
      const first = cells[1] ?? "";
      if (!names.some((n) => first.replace(/[*`]/g, "").startsWith(n))) continue;
      const rest = cells.slice(2).join(" | ");
      // A row describing what a report USED to say is a historical statement,
      // not a claim about the current set — and a write-up that records its own
      // corrections needs to be able to make one. The marker is required in the
      // row itself, so it cannot license a stale claim anywhere else.
      const historical = /\[was\]|\bBefore \[?§|\bpreviously read\b/.test(rest);
      for (const v of VERDICTS) {
        if (!new RegExp("`" + v + "`").test(rest)) continue;
        if (historical) { ok(doc, `table row "${first}" mentions \`${v}\` as an explicitly HISTORICAL value`); continue; }
        const actual = r.verdict.status;
        const win = r.exitWindow?.assessment?.status;
        if (v === actual || v === win) ok(doc, `table row "${first}" → \`${v}\` matches`);
        else fail(doc, `table row "${first}" claims \`${v}\` but its verdict is "${actual}" (window "${win}")`);
      }
    }
  }

  // --- 4. Counts that must equal something derivable. ---
  const derived = {
    "26 reports": Object.keys(reports).length === 26,
    publishable: Object.values(reports).filter((r) => r.disclosure.publishable).length,
    pages: existsSync("site") ? readdirSync("site").filter((f) => f.endsWith(".html") && f !== "index.html").length : null,
  };
  for (const m of text.matchAll(/(\d+)\s+publishable/g)) {
    if (Number(m[1]) === derived.publishable) ok(doc, `"${m[1]} publishable" matches`);
    else fail(doc, `"${m[1]} publishable" but ${derived.publishable} reports have disclosure.publishable === true`);
  }
  for (const m of text.matchAll(/(\d+)\s+pages? in `?site/g)) {
    if (derived.pages !== null && Number(m[1]) !== derived.pages) fail(doc, `"${m[1]} pages in site/" but site/ holds ${derived.pages} report pages`);
    else ok(doc, `"${m[1]} pages in site/" matches`);
  }
  // "N of 26 ... undetermined", allowing the words that usually sit between
  // ("N of 26 calibration protocols come back `undetermined`"). Kept to a
  // bounded run of non-newline text so it cannot span unrelated sentences.
  const verdictCounts = {};
  for (const r of Object.values(reports)) verdictCounts[r.verdict.status] = (verdictCounts[r.verdict.status] ?? 0) + 1;

  // A compact distribution table usually says `| `status` | 7 | ...` rather
  // than "7 of 26 status". The latter was already checked below; missing the
  // former let CALIBRATION.md keep its pre-day-7 6/17 split while every report
  // and the prose immediately below it said 7/16.
  for (const line of text.split(/\n/)) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 4) continue;
    const statusMatch = (cells[1] ?? "").match(/^`([a-z_]+)`$/);
    const countMatch = (cells[2] ?? "").replace(/\*/g, "").match(/^(\d+)$/);
    if (!statusMatch || !countMatch || !VERDICTS.includes(statusMatch[1])) continue;
    const status = statusMatch[1];
    const claimed = Number(countMatch[1]);
    const actual = verdictCounts[status] ?? 0;
    if (claimed === actual) ok(doc, `verdict table count "${status} = ${claimed}" matches`);
    else fail(doc, `verdict table says "${status} = ${claimed}" but ${actual} reports have that verdict`);
  }

  for (const v of VERDICTS) {
    const re = new RegExp(`(\\d+)\\s+of\\s+26[^\\n]{0,60}?\`?${v}\`?`, "g");
    for (const m of text.matchAll(re)) {
      const actual = verdictCounts[v] ?? 0;
      if (Number(m[1]) === actual) ok(doc, `"${m[1]} of 26 ${v}" matches`);
      else fail(doc, `"${m[1]} of 26 ... ${v}" but ${actual} reports have verdict "${v}"`);
    }
  }

  // --- 5. Named page files must exist. ---
  for (const m of text.matchAll(/site\/([a-z0-9-]+)\.html/g)) {
    if (!existsSync(join("site", `${m[1]}.html`))) fail(doc, `references site/${m[1]}.html which does not exist`);
  }
}

// --- 6. Every report claimed unpublishable must actually have no page. ---
for (const [label, r] of Object.entries(reports)) {
  const page = join("site", `${label}.html`);
  if (!r.disclosure.publishable && existsSync(page)) fail("site", `${label} is disclosure.publishable=false but site/${label}.html EXISTS`);
  if (r.disclosure.publishable && !existsSync(page)) notes.push(`site: ${label} is publishable but has no page (rerun \`pnpm render\`)`);
}

// --- 7. The hero's example card is a QUOTATION, so it must still be true. ---
//
// The card on the product's first screen carries a verdict, an address, a block
// and four figures. Nothing else checks them: verify-pages covers site/, and
// this script's other checks read markdown. A TSX literal is exactly the place
// KNOWN EDGE #34 happened — the tool stayed right while the story about it went
// wrong — so the quotation is re-derived from its source here.
//
// It also enforces the rule the quotation depends on: the source report must be
// PUBLISHABLE. Quoting a blocked report on a public page publishes what the
// disclosure gate withholds.
{
  const heroPath = "web/src/components/Hero.tsx";
  const doc = "hero";
  if (!existsSync(heroPath)) {
    fail(doc, `${heroPath} is missing — the example-card quotation cannot be verified`);
  } else {
    const src = readFileSync(heroPath, "utf8");
    const block = src.match(/const EXAMPLE = \{([\s\S]*?)\} as const;/);
    if (!block) {
      fail(doc, "no `const EXAMPLE = { … } as const;` literal found — the quotation check cannot run");
    } else {
      const quoted = {};
      for (const m of block[1].matchAll(/^\s*([A-Za-z]+):\s*"([^"]*)",/gm)) quoted[m[1]] = m[2];

      const addr = (quoted.address ?? "").toLowerCase();
      const src_report = byAddress[addr];
      if (!src_report) {
        fail(doc, `quotes address ${quoted.address ?? "(none)"} but no committed report has that target`);
      } else {
        const { label, r } = src_report;

        if (!r.disclosure.publishable) {
          fail(doc, `quotes ${label}, whose report is disclosure.publishable=false — the gate withholds it, so the first screen must not carry its figures`);
        } else {
          ok(doc, `quotes ${label}, which is publishable`);
        }

        const expect = (field, actual, want) => {
          if (quoted[field] === undefined) return fail(doc, `EXAMPLE.${field} is missing`);
          if (String(want) !== String(quoted[field])) {
            fail(doc, `EXAMPLE.${field} says "${quoted[field]}" but ${label} ${actual} is "${want}"`);
          } else {
            ok(doc, `EXAMPLE.${field} = ${want} matches ${label}`);
          }
        };

        const routes = r.exitWindow?.routes ?? [];
        const maxNotice = routes.reduce((a, x) => Math.max(a, Number(x.noticeSeconds ?? 0)), 0);
        const minNotice = routes.length ? routes.reduce((a, x) => Math.min(a, Number(x.noticeSeconds ?? 0)), Infinity) : 0;

        expect("block", "block.number", Number(r.block.number).toLocaleString("en-US"));
        expect("routes", "exitWindow.routes.length", routes.length);
        expect("notice", "the longest route notice", `${maxNotice / 86400}D`);
        expect("exitCloses", "the shortest route notice", `${minNotice}s`);
        expect("timeToExit", "timeToExit.atLeastSeconds", `${Number(r.timeToExit?.atLeastSeconds ?? -1)}s`);

        // Elsewhere in this script an abbreviated figure is skipped, because a
        // "$540M" in prose is a rounding of an exact total stated nearby. On the
        // card the abbreviation is ALL the reader gets, so it is a claim in its
        // own right and is checked here. Floor and round are both accepted — the
        // repo writes $540M for $540,604,938.71 and that is not an error — which
        // still catches the drift that matters: a figure off by a million or by
        // an order of magnitude, or one quoting a report with no proof at all.
        const usd = Number(r.proof?.totalUsd ?? NaN);
        if (!Number.isFinite(usd)) {
          fail(doc, `EXAMPLE.proofUsd says "${quoted.proofUsd}" but ${label} produced no priced proof`);
        } else {
          const allowed = [Math.floor(usd / 1e6), Math.round(usd / 1e6)].map((n) => `$${n}M`);
          if (allowed.includes(quoted.proofUsd)) ok(doc, `EXAMPLE.proofUsd = ${quoted.proofUsd} matches ${label} proof.totalUsd`);
          else fail(doc, `EXAMPLE.proofUsd says "${quoted.proofUsd}" but ${label} proof.totalUsd is ${usd.toFixed(2)} (expected one of ${allowed.join(" or ")})`);
        }

        const status = String(r.verdict?.status ?? "");
        expect("verdict", "verdict.status", status.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()));

        // A card claiming a fork confirmed something must be quoting a report in
        // which a fork actually did.
        if (/fork-confirmed/.test(src) && r.exitRestriction?.confirmationMethod !== "fork_confirmed") {
          fail(doc, `says "fork-confirmed" but ${label} exitRestriction.confirmationMethod is ${r.exitRestriction?.confirmationMethod ?? "null"}`);
        } else if (/fork-confirmed/.test(src)) {
          ok(doc, `"fork-confirmed" matches ${label} exitRestriction.confirmationMethod`);
        }
      }
    }
  }
}

console.log(`--- narrative claim audit over ${docs.length} document(s) against ${Object.keys(reports).length} reports ---\n`);
console.log(`${checked.length} claim(s) mechanically verified`);
if (notes.length) {
  console.log(`\n${notes.length} paragraph(s) a human must read:`);
  for (const n of notes) console.log(`  ? ${n}`);
}
if (failures.length) {
  console.log(`\n${failures.length} FAILURE(S):`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exitCode = 1;
} else {
  console.log(`\n0 failures.`);
}
