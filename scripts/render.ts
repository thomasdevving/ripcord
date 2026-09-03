/**
 * The Ripcord report renderer: one pinned JSON report in, one static HTML page
 * out. No backend, no live scanning, no network at render time and none at view
 * time — every page is a pure function of a report that was already generated
 * against a pinned block.
 *
 * THE RULE THIS FILE EXISTS TO OBEY. Every discipline the schema enforces has to
 * survive into the design, because a renderer that paints uncertainty green
 * undoes the entire project in one stylesheet. Concretely:
 *
 *   - `undetermined` is never a reassuring colour and never a blank. It gets
 *     amber, an explicit wordmark, and a HATCHED bar — because the honest visual
 *     for "this length is not known" is a bar you cannot read a length off.
 *   - A delay that exists but was not proven binding renders hatched at its
 *     NOMINAL length with "not proven binding" attached — never as a confident
 *     window. The reader sees the claimed size and the fact that it is unproven
 *     in the same glance.
 *   - A partial role reconstruction renders with its label and its exact covered
 *     block window, not silently as a complete one.
 *   - Every headline figure goes through FigureLog (scripts/figures.ts), which
 *     records the JSON path it came from. scripts/verify-pages.mjs re-checks
 *     each one against the source report, so "the page matches the JSON" is a
 *     test rather than a promise.
 *
 * Deliberately NOT an app. No routing, no framework, no client state beyond
 * native <details> for the collapsible evidence sections — there is no
 * JavaScript on the page at all.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { FigureLog, humanSeconds, formatUsd, shortAddress, escapeHtml } from "./figures.js";
import { renderLivePanel, LIVE_STYLE } from "./live-panel.js";
import type { Sidecar } from "./live-panel.js";
import type { Report } from "../src/report/schema.js";

// --- the two things the design turns on -------------------------------------

type Tone = "good" | "critical" | "unknown";

/**
 * Verdict → visual tone. `undetermined` is deliberately its OWN tone rather
 * than a washed-out "good": the whole point is that a missing determination
 * must read as caution, not as a pass.
 */
function toneOf(status: string): Tone {
  switch (status) {
    case "can_exit_in_time":
    case "immutable_within_checks":
      return "good";
    case "trapped":
    case "no_notice":
      return "critical";
    default:
      return "unknown";
  }
}

const VERDICT_LABEL: Record<string, string> = {
  can_exit_in_time: "You can exit in time",
  immutable_within_checks: "No rule-change route, within checks",
  trapped: "Trapped",
  no_notice: "No notice at all",
  undetermined: "Undetermined",
};

/** ✓ / ✕ / ? — identity never rests on colour alone (the status palette is sub-3:1 in places). */
const TONE_MARK: Record<Tone, string> = { good: "✓", critical: "✕", unknown: "?" };

// --- the hero chart ---------------------------------------------------------

/**
 * One bar of the two-bar comparison, in the four states it can honestly be in.
 *
 *   `known`    — a number the report asserts. Solid fill.
 *   `unproven` — a number the report carries but did NOT establish (a nominal
 *                delay; a non-tight lower bound). Hatched, dashed outline.
 *   `unknown`  — no number, because nothing could be established. Full-width
 *                hatch: there is deliberately no length to read off it.
 *   `none`     — no number, because there is nothing to measure (no route to
 *                change the rules was found to exist). A flat tint, NOT the
 *                hatch.
 *
 * `unknown` and `none` must not look the same. Rendering them identically would
 * put back, in the stylesheet, precisely the conflation between "we found
 * nothing" and "there is nothing" that the day-5 assessment split took out of
 * the data — and a reader would have no way to tell the two apart.
 */
interface BarSpec {
  label: string;
  sublabel: string;
  seconds: bigint | null;
  state: "known" | "unproven" | "unknown" | "none";
  valueText: string;
  series: 1 | 2;
}

/**
 * Renders the two bars on ONE shared axis (never two scales — the comparison is
 * the entire point and a second axis would invent it).
 *
 * Mark specs follow the house style: bars capped at 22px, 4px rounded data-end
 * square at the baseline, hairline solid axis, direct labels at the tips, and a
 * 2px surface gap doing the separating rather than a stroke.
 */
function renderChart(bars: BarSpec[]): string {
  const W = 720;
  const PAD_L = 4;
  const PAD_R = 210; // room for the direct label at the tip
  const ROW = 64;
  const BAR = 22;
  const H = bars.length * ROW + 34;
  const plotW = W - PAD_L - PAD_R;

  const known = bars.filter((b) => b.seconds !== null).map((b) => b.seconds!);
  const maxVal = known.length ? known.reduce((a, b) => (a > b ? a : b)) : 0n;
  // When every value is zero (a proven-zero window against an instant exit) there
  // is no scale to build. Fall back to a nominal axis so the zero markers still
  // have somewhere to sit, and let the labels carry the meaning.
  const axisMax = maxVal > 0n ? maxVal : 86400n;

  const x = (v: bigint) => PAD_L + Number((v * BigInt(Math.round(plotW * 1000))) / axisMax) / 1000;

  const rows = bars
    .map((b, i) => {
      const y = i * ROW + 8;
      const barY = y + 20;
      const series = `var(--series-${b.series})`;
      let mark: string;
      let tip: number;

      if (b.state === "unknown") {
        // No length to read. The bar spans the plot as texture, so the row is
        // visibly present and visibly unmeasured — never blank, never short.
        tip = PAD_L + plotW;
        mark = `<rect x="${PAD_L}" y="${barY}" width="${plotW}" height="${BAR}" rx="4"
             fill="url(#hatch-unknown)" stroke="var(--muted)" stroke-width="1" stroke-dasharray="4 3" />`;
      } else if (b.state === "none") {
        // Nothing to measure rather than nothing measured. A flat tint with a
        // solid edge, visibly not the hatch.
        tip = PAD_L + plotW;
        mark = `<rect x="${PAD_L}" y="${barY}" width="${plotW}" height="${BAR}" rx="4"
             fill="${series}" fill-opacity="0.12" stroke="${series}" stroke-width="1" />`;
      } else if (b.seconds === 0n) {
        // A proven zero. A zero-width rect draws nothing, so the mark is an
        // explicit stub at the baseline — "measured, and it is none".
        tip = PAD_L + 3;
        mark = `<rect x="${PAD_L}" y="${barY}" width="3" height="${BAR}" fill="${series}" />`;
      } else {
        const w = Math.max(3, x(b.seconds!) - PAD_L);
        tip = PAD_L + w;
        mark =
          b.state === "unproven"
            ? `<rect x="${PAD_L}" y="${barY}" width="${w}" height="${BAR}" rx="4"
                 fill="url(#hatch-series-${b.series})" stroke="${series}" stroke-width="1.5" stroke-dasharray="4 3" />`
            : `<rect x="${PAD_L}" y="${barY}" width="${w}" height="${BAR}" rx="4" fill="${series}" />`;
      }

      return `<g>
      <text x="${PAD_L}" y="${y + 12}" class="bar-label">${escapeHtml(b.label)}</text>
      <title>${escapeHtml(`${b.label}: ${b.valueText}`)}</title>
      ${mark}
      <text x="${tip + 10}" y="${barY + BAR / 2 + 4}" class="bar-value">${escapeHtml(b.valueText)}</text>
      <text x="${PAD_L}" y="${barY + BAR + 15}" class="bar-sub">${escapeHtml(b.sublabel)}</text>
    </g>`;
    })
    .join("\n");

  return `<figure class="chart">
  <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Notice before the rules can change, against the time needed to leave">
    <defs>
      <pattern id="hatch-unknown" width="7" height="7" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
        <rect width="7" height="7" fill="var(--surface-1)"/><line x1="0" y1="0" x2="0" y2="7" stroke="var(--muted)" stroke-width="2.5"/>
      </pattern>
      <pattern id="hatch-series-1" width="7" height="7" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
        <rect width="7" height="7" fill="var(--surface-1)"/><line x1="0" y1="0" x2="0" y2="7" stroke="var(--series-1)" stroke-width="2.5"/>
      </pattern>
      <pattern id="hatch-series-2" width="7" height="7" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
        <rect width="7" height="7" fill="var(--surface-1)"/><line x1="0" y1="0" x2="0" y2="7" stroke="var(--series-2)" stroke-width="2.5"/>
      </pattern>
    </defs>
    <line x1="${PAD_L}" y1="6" x2="${PAD_L}" y2="${H - 22}" stroke="var(--baseline)" stroke-width="1" />
    ${rows}
  </svg>
  <figcaption class="legend">
    <span><i class="sw sw1"></i>Notice before the rules can change</span>
    <span><i class="sw sw2"></i>Time needed to leave</span>
    <span><i class="sw swh"></i>Hatched = not established; deliberately no length to read off it</span>
    <span><i class="sw swn"></i>Flat tint = nothing to measure (no route was found to exist)</span>
  </figcaption>
</figure>`;
}

// --- small building blocks --------------------------------------------------

const kv = (k: string, v: string) => `<div class="kv"><dt>${escapeHtml(k)}</dt><dd>${v}</dd></div>`;
const addr = (a: string | null) =>
  a ? `<code class="addr" title="${escapeHtml(a)}">${escapeHtml(shortAddress(a))}</code>` : "<span class='muted'>—</span>";

function section(title: string, body: string, note?: string): string {
  return `<section><h2>${escapeHtml(title)}</h2>${note ? `<p class="note">${note}</p>` : ""}${body}</section>`;
}

function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return `<p class="muted">None.</p>`;
  return `<div class="scroll"><table>
    <thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody>
  </table></div>`;
}

/** A flag with an icon and a word — never colour alone. */
function chip(tone: Tone, text: string): string {
  return `<span class="chip ${tone}">${TONE_MARK[tone]} ${escapeHtml(text)}</span>`;
}

// --- the page ---------------------------------------------------------------

export interface RenderedPage {
  html: string;
  figures: ReturnType<FigureLog["toJSON"]>;
}

/**
 * `live` is an OPTIONAL, separately-sourced snapshot rendered beside the report.
 * It is a third argument rather than a field on Report on purpose: the report
 * type is the pinned contract, and nothing that changes between two runs of the
 * same pinned scan belongs inside it. Passing null renders the page exactly as
 * it rendered before this feature existed.
 */
export function renderReport(report: Report, label: string, live: Sidecar | null = null): RenderedPage {
  const f = new FigureLog(report);
  const verdict = report.verdict;
  const ew = report.exitWindow;
  const tte = report.timeToExit;
  const tone = toneOf(verdict?.status ?? "undetermined");

  // --- the two bars ---
  //
  // Each bar's displayed string IS its logged figure: the value is read from a
  // JSON path and formatted at the point of use, so the manifest can never
  // record one string while the page shows another. Where a bar has no number
  // at all, nothing is logged, because there is no figure to have provenance
  // for — and the bar says so rather than showing a length.
  const verdictStatus = f.read("verdict status", "verdict.status", (v: string | undefined) =>
    VERDICT_LABEL[v ?? "undetermined"] ?? (v ?? "undetermined"),
  );

  const assessment = ew?.assessment;
  const nominal = assessment?.status === "not_proven_binding" ? assessment.nominalDelaySeconds : null;
  const windowSeconds = verdict?.exitWindowSeconds ?? null;

  const windowSub =
    assessment?.status === "binding"
      ? "proven binding on every route found"
      : assessment?.status === "no_notice"
        ? "zero, and proven — at least one route needs no waiting at all"
        : assessment?.status === "not_proven_binding"
          ? "delay present, NOT proven binding — an authority may be able to shorten it"
          : assessment?.status === "immutable_within_checks"
            ? "no rule-change route found within the checks performed"
            : "not established — see what is missing below";

  let windowBar: BarSpec;
  if (windowSeconds !== null) {
    windowBar = {
      label: "Notice before the rules can change",
      sublabel: windowSub,
      seconds: BigInt(windowSeconds),
      state: "known",
      valueText: f.read("exit window", "verdict.exitWindowSeconds", (v: string) => humanSeconds(v)),
      series: 1,
    };
  } else if (nominal !== null) {
    windowBar = {
      label: "Notice before the rules can change",
      sublabel: windowSub,
      seconds: BigInt(nominal),
      state: "unproven",
      // The single most dangerous figure in the tool to render confidently, so
      // the qualifier travels with the number rather than sitting beside it.
      valueText: f.read(
        "nominal delay",
        "exitWindow.assessment.nominalDelaySeconds",
        (v: string) => `${humanSeconds(v)} nominal — not proven binding`,
      ),
      series: 1,
    };
  } else {
    windowBar = {
      label: "Notice before the rules can change",
      sublabel: windowSub,
      seconds: null,
      state: assessment?.status === "immutable_within_checks" ? "none" : "unknown",
      valueText: assessment?.status === "immutable_within_checks" ? "no rule-change route found" : "NOT ESTABLISHED",
      series: 1,
    };
  }

  const exitSeconds = verdict?.timeToExitSeconds ?? null;
  const halted = tte?.blockable.status === "currently_blocked";
  let exitBar: BarSpec;
  if (halted) {
    // A halted exit is NOT a duration, and drawing it as one — worse, as a
    // zero-length one — would render a closed door as an instant exit. It has
    // no length to show, so it gets the unknown treatment and says why.
    exitBar = {
      label: "Time needed to leave",
      sublabel: "the exit is HALTED at the pinned block — this is a closed door, not a duration",
      seconds: null,
      state: "unknown",
      valueText: f.read(
        "exit blockability",
        "timeToExit.blockable.status",
        () => "HALTED — unbounded until it reopens",
      ),
      series: 2,
    };
  } else if (exitSeconds !== null) {
    const tight = tte?.tight === true;
    exitBar = {
      label: "Time needed to leave",
      sublabel: tight
        ? `${tte?.status ?? "—"} — every detected leg measured, nothing currently blocking`
        : `${tte?.status ?? "—"} — a LOWER BOUND; unmeasured legs are never counted as zero`,
      seconds: BigInt(exitSeconds),
      state: tight ? "known" : "unproven",
      valueText: f.read("time to exit", "verdict.timeToExitSeconds", (v: string) =>
        tight ? humanSeconds(v) : `at least ${humanSeconds(v)}`,
      ),
      series: 2,
    };
  } else {
    exitBar = {
      label: "Time needed to leave",
      sublabel: "not established — an unmeasured exit is never treated as an instant one",
      seconds: null,
      state: "unknown",
      valueText: "NOT ESTABLISHED",
      series: 2,
    };
  }

  // --- proof ---
  const proof = report.proof;
  let proofHtml = "";
  if (proof?.produced) {
    const usd = f.read("proof total USD", "proof.totalUsd", (v: number | null) => formatUsd(v));
    const notice = f.read("proof notice seconds", "proof.noticeSeconds", (v: string | null) => humanSeconds(v));
    proofHtml = `<div class="proof">
      <div class="proof-head">
        <div>
          <div class="proof-label">Value this authority could move, demonstrated on a fork</div>
          <div class="proof-figure">${escapeHtml(usd)}</div>
        </div>
        <div class="proof-notice">
          <div class="proof-label">…after this much public notice</div>
          <div class="proof-notice-figure">${escapeHtml(notice)}</div>
          <div class="proof-note">${escapeHtml(proof.noticeNote)}</div>
        </div>
      </div>
      <p class="sandbox">${escapeHtml(proof.sandboxNote)}</p>
    </div>`;
  }

  // --- exit-window routes ---
  const routeRows = (ew?.routes ?? []).map((r) => [
    `<code>${escapeHtml(r.label)}</code>`,
    r.noticeStatus === "immediate"
      ? chip("critical", "no notice")
      : r.noticeStatus === "delayed"
        ? chip("good", humanSeconds(r.noticeSeconds))
        : r.noticeStatus === "delay_not_proven_binding"
          ? chip("unknown", `${humanSeconds(r.nominalDelaySeconds)} nominal, not proven binding`)
          : chip("unknown", "undetermined"),
    `${escapeHtml(r.effectiveControllerType ?? "unresolved")} ${addr(r.effectiveController)}`,
    escapeHtml(r.terminationReason),
    r.rolePrivilege === "not_a_role"
      ? "<span class='muted'>n/a</span>"
      : r.rolePrivilege === "verified"
        ? chip("good", "privilege verified")
        : chip("unknown", "privilege unverified"),
    r.categories.length ? r.categories.map((c) => `<code>${escapeHtml(c)}</code>`).join(" ") : "<span class='muted'>none attributed</span>",
    escapeHtml(r.confidence),
  ]);

  const checks = ew?.checksPerformed ?? [];
  const checkRows = checks.map((c) => [
    escapeHtml(c.check),
    c.performed ? chip("good", "performed") : chip("unknown", "NOT performed"),
    c.performed ? (c.found ? chip("critical", "found") : "none found") : "<span class='muted'>—</span>",
    escapeHtml(c.note),
  ]);

  // --- authority paths ---
  const paths = report.authorityResolution?.paths ?? [];
  const pathHtml = paths.length
    ? paths
        .map(
          (p) => `<div class="path">
      <div class="path-head"><code>${escapeHtml(p.label)}</code> ${chip(
        p.terminationReason === "no_authority_found" || p.terminationReason === "max_depth" ? "unknown" : "good",
        p.terminationReason,
      )} <span class="muted">confidence ${escapeHtml(p.confidence)}</span></div>
      <ol class="hops">
        <li><span class="hop-kind">target</span>${addr(report.target.address)}</li>
        ${p.hops
          .map(
            (h) =>
              `<li><span class="hop-kind">${escapeHtml(h.type ?? "?")} · depth ${h.depth}</span>${addr(h.address)}<span class="rel">via ${escapeHtml(h.relation)}</span></li>`,
          )
          .join("")}
      </ol>
    </div>`,
        )
        .join("")
    : `<p class="muted">No authority path resolved. That is an absence of evidence, not evidence of absence — see the exit-window section for exactly which positive check failed.</p>`;

  // --- role reconstruction label ---
  const recon = report.authority.accessControl?.reconstruction ?? null;
  const reconHtml = recon
    ? `<div class="banner ${recon.complete ? "ok" : "warn"}">
        <strong>${recon.complete ? "Role reconstruction complete" : "PARTIAL role reconstruction"}</strong>
        <span class="muted">confidence ${escapeHtml(recon.confidence)}</span>
        <p>${escapeHtml(recon.note)}</p>
        ${
          recon.scannedFromBlock
            ? `<p class="mono">covered blocks ${escapeHtml(recon.scannedFromBlock)}–${escapeHtml(recon.scannedToBlock ?? "")} · provider eth_getLogs range ${escapeHtml(recon.maxLogRange ?? "?")}</p>`
            : ""
        }
      </div>`
    : "";

  // --- capabilities ---
  const caps = report.capabilities;
  const capRows = caps.findings.map((x) => [
    `<code>${escapeHtml(x.signature)}</code>`,
    `<code>${escapeHtml(x.category)}</code>`,
    x.guard.status === "attributed"
      ? chip("critical", `attributed to ${x.guard.holders.length} holder(s)`)
      : x.guard.status === "guarded_unknown_holder"
        ? chip("good", "guarded, holder unknown")
        : chip("unknown", x.guard.status),
    x.nameMatchSpecificity === "generic"
      ? `<span class="muted" title="the selector match is exact; the NAME's real-world meaning varies by project">generic name</span>`
      : "standard",
    x.guard.status === "attributed" ? x.guard.holders.map(addr).join(" ") : "<span class='muted'>—</span>",
  ]);

  const mvRows = caps.needsManualVerification.map((x) => [
    `<code>${escapeHtml(x.signature)}</code>`,
    `<code>${escapeHtml(x.category)}</code>`,
    x.reason === "no_auth_revert_observed"
      ? chip("unknown", "no recognised auth revert — blocks publication")
      : chip("good", "probe rejected before any auth check — not a guard claim either way"),
    escapeHtml(x.note.slice(0, 220)) + (x.note.length > 220 ? "…" : ""),
  ]);

  // --- indirection ---
  const ind = report.authorityIndirection;
  const indHtml = !ind
    ? `<p class="muted">The authority-indirection check did not run.</p>`
    : ind.markers.length === 0
      ? `<p class="muted">Checked ${ind.gettersProbed.length} delegated-authority getters; none resolved to a non-zero address. (An empty result here means <em>checked and found none</em> — the list of what was probed is in the report.)</p>`
      : `<p>Ripcord found a handle to authority held <strong>elsewhere</strong>, and deliberately does not follow it. Its presence alone is why this report refuses to call the contract authority-free.</p>` +
        table(
          ["Getter", "Points at", "Followed?"],
          ind.markers.map((m) => [`<code>${escapeHtml(m.signature)}</code>`, addr(m.target), "<span class='muted'>no — see limitations</span>"]),
        );

  // --- meta / provenance ---
  const blockNumber = f.read("pinned block", "block.number", (v: string) => v);
  const metaHtml = `<dl class="meta">
    ${kv("Target", `<code>${escapeHtml(report.target.address)}</code>`)}
    ${kv("Chain", String(report.chainId))}
    ${kv("Pinned block", `<code>${escapeHtml(blockNumber)}</code>`)}
    ${kv("Block hash", `<code>${escapeHtml(report.block.hash)}</code>`)}
    ${kv("Schema version", escapeHtml(report.schemaVersion))}
    ${kv("Ruleset version", escapeHtml(report.rulesetVersion))}
    ${kv("Cleared-registry version", escapeHtml(report.disclosure.clearedRegistryVersion))}
    ${kv("Exit-window rules", escapeHtml(ew?.rulesVersion ?? "—"))}
    ${kv("Time-to-exit rules", escapeHtml(tte?.rulesVersion ?? "—"))}
    ${kv("Taxonomy version", escapeHtml(caps.taxonomyVersion))}
  </dl>`;

  const disclosureBanner = report.disclosure.publishable
    ? ""
    : `<div class="banner danger"><strong>DO NOT PUBLISH THIS REPORT</strong><p>${escapeHtml(report.disclosure.reason)}</p></div>`;

  const html = `<title>Ripcord — ${escapeHtml(label)}</title>
${STYLE}
${LIVE_STYLE}
<main class="page">
  <header class="masthead">
    <div class="brand">RIPCORD</div>
    <div class="target">
      <h1>${escapeHtml(label)}</h1>
      <code>${escapeHtml(report.target.address)}</code>
      <span class="muted">chain ${report.chainId} · block ${escapeHtml(blockNumber)}</span>
    </div>
  </header>

  ${disclosureBanner}

  <section class="hero ${tone}">
    <div class="verdict-badge">${TONE_MARK[tone]} ${escapeHtml(verdictStatus)}</div>
    <p class="verdict-statement">${escapeHtml(verdict?.statement ?? "No verdict was produced.")}</p>
    ${renderChart([windowBar, exitBar])}
    ${
      verdict?.marginSeconds
        ? `<p class="margin">Margin: <strong>${escapeHtml(f.read("margin seconds", "verdict.marginSeconds", (v: string | null) => humanSeconds(v)))}</strong> between finishing your exit and the change taking effect.</p>`
        : ""
    }
    ${proofHtml}
    ${
      (verdict?.missing.length ?? 0) > 0
        ? `<div class="missing"><strong>What is missing, and why this verdict is not crisper</strong><ul>${verdict!.missing
            .map((m) => `<li>${escapeHtml(m)}</li>`)
            .join("")}</ul></div>`
        : ""
    }
    <details class="tabletwin"><summary>The same two figures as a table</summary>
      ${table(
        ["Measure", "Value", "Established?"],
        [
          [
            "Notice before the rules can change",
            escapeHtml(windowBar.valueText),
            windowBar.state === "known"
              ? "yes"
              : windowBar.state === "unproven"
                ? "no — nominal only"
                : windowBar.state === "none"
                  ? "n/a — no route found to measure"
                  : "no",
          ],
          ["Time needed to leave", escapeHtml(exitBar.valueText), exitBar.state === "known" ? "yes" : exitBar.state === "unproven" ? "lower bound only" : "no"],
        ],
      )}
    </details>
  </section>

  ${section(
    "Exit window",
    `<p class="statement">${escapeHtml(assessment?.statement ?? "—")}</p>
     ${
       assessment?.status === "immutable_within_checks"
         ? `<div class="basis"><strong>Established positively by:</strong><ul>${assessment.basis.map((b) => `<li>${escapeHtml(b)}</li>`).join("")}</ul>
            <strong>Bounded by:</strong><ul>${assessment.caveats.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ul></div>`
         : ""
     }
     <h3>Routes to changing the rules</h3>
     ${table(["Route", "Notice", "Effective controller", "Terminated because", "Role privilege", "Reaches", "Confidence"], routeRows)}
     <h3>Ways the notice could be shorter than it looks</h3>
     ${
       (ew?.bypasses.length ?? 0) > 0
         ? table(["Kind", "Route", "Detail"], ew!.bypasses.map((b) => [`<code>${escapeHtml(b.kind)}</code>`, escapeHtml(b.route ?? "protocol-wide"), escapeHtml(b.detail)]))
         : `<p class="muted">None found — and the table below is what makes that mean something.</p>`
     }
     <details><summary>Which checks actually ran (${checks.filter((c) => c.performed).length} of ${checks.length})</summary>${table(
       ["Check", "Ran?", "Result", "Note"],
       checkRows,
     )}</details>`,
    "The exit window is the notice you get before a rule change takes effect, minus every way that notice can be cut. It is modelled per route and the protocol figure is the <strong>minimum</strong> across them: a timelock on one path is worth nothing beside an un-delayed one.",
  )}

  ${section(
    "Time to exit",
    `<p class="statement">${escapeHtml(tte?.statement ?? "—")}</p>
     ${table(
       ["Leg", "Kind", "Duration", "Measured?", "Note"],
       (tte?.legs ?? []).map((l) => [
         `<code>${escapeHtml(l.name)}</code>`,
         escapeHtml(l.kind),
         l.seconds === null ? chip("unknown", "unknown duration") : escapeHtml(humanSeconds(l.seconds)),
         l.measured ? "yes" : chip("unknown", "no"),
         escapeHtml(l.note.slice(0, 260)) + (l.note.length > 260 ? "…" : ""),
       ]),
     )}
     ${
       (tte?.unmeasuredLegs.length ?? 0) > 0
         ? `<h3>Legs known to exist but not measured</h3>${table(["Leg", "Why"], tte!.unmeasuredLegs.map((u) => [escapeHtml(u.name), escapeHtml(u.reason)]))}`
         : ""
     }
     <div class="banner warn"><strong>Liquidity depth is not modelled.</strong><p>${escapeHtml(tte?.liquidity.reason ?? "")}</p>
     <p>Consequence: for a position large relative to available liquidity the real time to exit is <strong>longer</strong> than shown here, never shorter.</p></div>`,
    "A <strong>lower bound</strong> on how long a holder actually needs to leave, with its gaps named. An unmeasured leg is never counted as zero.",
  )}

  ${section("Authority path", pathHtml, "Who ends up holding the power, and how many hops away. Confidence degrades with depth — a controller three hops out is never asserted with a direct owner's certainty.")}

  ${section("Authority held elsewhere", indHtml, "Handles to authorisation that Ripcord finds but does not follow.")}

  ${section(
    "Capabilities",
    `${reconHtml}
     <p class="counts">
       <strong>${caps.selectorsExtracted}</strong> selectors recovered ·
       <strong>${caps.findings.length}</strong> classified capabilities ·
       <strong>${caps.needsManualVerification.length}</strong> needing manual verification ·
       <strong>${caps.unmatchedSelectors.length}</strong> unmatched
     </p>
     <p class="note">Unmatched means <em>not in Ripcord's taxonomy table</em> — never <em>not privileged</em>. The count is published so "${caps.findings.length} capabilities" cannot quietly read as "there are only ${caps.findings.length}".</p>
     ${table(["Function", "Category", "Guard", "Name match", "Attributed to"], capRows)}
     ${mvRows.length ? `<h3>Needs manual verification</h3>${table(["Function", "Category", "Why", "Detail"], mvRows)}` : ""}
     <details><summary>Unmatched selectors (${caps.unmatchedSelectors.length})</summary><p class="mono wrap">${caps.unmatchedSelectors
       .map((s) => escapeHtml(s))
       .join(" ")}</p></details>`,
    "What a privileged address is technically able to do. Guards are established by <strong>probing</strong> — a real eth_call from unrelated addresses at the pinned block — never by reading source or guessing from a name.",
  )}

  ${
    proof
      ? section(
          "Proof",
          proof.produced
            ? `<p class="statement">${escapeHtml(proof.headline)}</p>
           <dl class="meta">
             ${kv("Archetype", escapeHtml(proof.archetype))}
             ${kv("Capability", escapeHtml(proof.capability ?? "—"))}
             ${kv("Impersonated", addr(proof.impersonated))}
             ${kv("Via", escapeHtml(proof.impersonatedVia ?? "—"))}
             ${kv("Fork block", `<code>${escapeHtml(proof.forkBlock)}</code>`)}
           </dl>
           ${table(
             ["Asset", "Amount moved", "USD", "Price source"],
             proof.deltas.map((d) => [escapeHtml(d.symbol), `<code>${escapeHtml(d.delta)}</code>`, escapeHtml(formatUsd(d.usd)), escapeHtml(d.priceSource)]),
           )}
           ${proof.reproduceCommand ? `<h3>Reproduce it</h3><pre class="repro">${escapeHtml(proof.reproduceCommand)}</pre>` : ""}`
            : `<div class="banner warn"><strong>No proof was produced — and that is honest, not a finding about the target.</strong><p>${escapeHtml(proof.failureReason ?? "")}</p></div>`,
          "A static claim, executed. The proof runs on an ephemeral anvil fork pinned to the report block; no mainnet transaction is ever sent.",
        )
      : ""
  }

  ${
    report.exitRestriction
      ? section(
          "Exit-restriction fork evaluation",
          (() => {
            const er = report.exitRestriction;
            const stateLabel =
              er.restrictionState === "restrictable"
                ? "OPEN now, but CLOSABLE — a party can shut the exit at any moment"
                : er.restrictionState === "already_shut"
                  ? "ALREADY shut at the pinned block — the baseline exit reverts now"
                  : er.restrictionState === "none_found"
                    ? "no direct restrictor found among the registered candidates evaluated"
                    : "not determined";
            const banner =
              er.outcome === "restrictor_found"
                ? `<div class="banner warn"><strong>A privileged party can close this exit — demonstrated on a fork.</strong><p>${escapeHtml(stateLabel)}. Capability, not intent: this is what the party CAN do, watched happening in simulation, not a claim that it will.</p></div>`
                : er.outcome === "no_direct_restriction_found"
                  ? `<div class="banner"><strong>No direct exit restriction found — scoped, NOT a safety guarantee.</strong><p>Evaluated ${er.coverage.evaluated} registered candidate(s) against a baseline exit; none closed it. Other privileged functions, argument space and indirect/economic restrictions were not exhausted.</p></div>`
                  : `<div class="banner"><strong>Exit restriction not evaluated to a conclusion (${escapeHtml(er.outcome)}).</strong><p>${escapeHtml(er.baseline.note)}</p></div>`;
            const candRows = er.candidates.map((c) => [
              `<code>${escapeHtml(c.signature ?? c.selector)}</code>`,
              escapeHtml(c.result),
              addr(c.guardingParty),
              escapeHtml(c.args),
              escapeHtml(c.detail),
            ]);
            const txRows = er.evidence
              .filter((e) => e.params.method === "eth_sendTransaction")
              .map((e) => {
                const raw = e.rawValue && typeof e.rawValue === "object" ? (e.rawValue as Record<string, unknown>) : {};
                const receipt = raw.receipt && typeof raw.receipt === "object" ? (raw.receipt as Record<string, unknown>) : {};
                return [
                  escapeHtml(String(e.params.action ?? "fork transaction")),
                  `<code>${escapeHtml(String(e.params.selector ?? "—"))}</code>`,
                  `<code>${escapeHtml(String(raw.transactionHash ?? "—"))}</code>`,
                  escapeHtml(String(receipt.status ?? "—")),
                  escapeHtml(String(receipt.blockNumber ?? "—")),
                  escapeHtml(String(receipt.gasUsed ?? "—")),
                ];
              });
            return `${banner}
             <dl class="meta">
               ${kv("Exit action", `${escapeHtml(er.exitAction.status)} — <code>${escapeHtml(er.exitAction.signature ?? "—")}</code> (${escapeHtml(er.exitAction.interfaceName)})`)}
               ${kv("Baseline", `${escapeHtml(er.baseline.status)} — ${escapeHtml(er.baseline.holderSource)}`)}
               ${kv("Outcome", `${escapeHtml(er.outcome)} · ${escapeHtml(er.confirmationMethod)}`)}
               ${kv("Coverage", `${er.coverage.evaluated} / ${er.coverage.guardedTotal} registered candidate(s) evaluated`)}
             </dl>
             ${candRows.length ? table(["Function", "Result", "Guarding party", "Argument", "Detail"], candRows) : ""}
             ${txRows.length ? `<h3>Fork transaction evidence</h3><p class="muted">These hashes exist only inside the ephemeral fork. Full sender, target, calldata, gas limit, receipt and revert payload are preserved in the JSON report.</p>${table(["Step", "Selector", "Fork tx hash", "Status", "Receipt block", "Gas used"], txRows)}` : ""}
             <h3>What this does NOT cover</h3>
             <ul class="ceiling">${er.ceiling.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ul>
             <p class="sandbox">${escapeHtml(er.sandboxNote)}</p>`;
          })(),
          "The differential: establish a baseline exit on a fork, then have the matched archetype's registered candidates try to close it. A restrictor is DEMONSTRATED, never inferred. A clean run is scoped to those candidates — it is never a proof of safe exit.",
        )
      : ""
  }

  ${
    report.unknowns.length || report.errors.length
      ? section(
          "Unknowns and errors",
          `${table(["Field", "Reason"], report.unknowns.map((u) => [`<code>${escapeHtml(u.field)}</code>`, escapeHtml(u.reason)]))}
           ${report.errors.length ? `<h3>Errors</h3>${table(["Stage", "Message"], report.errors.map((e) => [escapeHtml(e.stage), escapeHtml(e.message)]))}` : `<p class="muted">No infrastructure errors.</p>`}`,
          "Always present, never suppressed to look clean. An empty list here is a claim that nothing went wrong.",
        )
      : ""
  }

  ${section("Provenance", metaHtml, "Everything above is pinned to one block and reproducible from the JSON report this page was rendered from.")}

  ${renderLivePanel(live)}

  <footer>
    <p>Generated by Ripcord from a pinned JSON report. This page performs no network access, at render time or view time.
    Every headline figure on it is machine-checked against the source report by <code>scripts/verify-pages.mjs</code>.</p>
    <p class="muted">Capability, not intent: nothing here claims anyone will do anything. It reports what a privileged address is technically able to do, and how much notice you would get.</p>
  </footer>
</main>
<script type="application/json" id="ripcord-figures">${JSON.stringify(f.toJSON())}</script>`;

  return { html, figures: f.toJSON() };
}

// --- styles -----------------------------------------------------------------

const STYLE = `<style>
:root{
  color-scheme: light;
  --surface-1:#fcfcfb; --plane:#f9f9f7;
  --text-primary:#0b0b0b; --text-secondary:#52514e; --muted:#898781;
  --grid:#e1e0d9; --baseline:#c3c2b7; --border:rgba(11,11,11,.10);
  --series-1:#2a78d6; --series-2:#eb6834;
  --good:#0ca30c; --warning:#fab219; --critical:#d03b3b;
  --good-ink:#006300; --warn-ink:#7a5200; --crit-ink:#9c2020;
  --good-bg:#eef7ee; --warn-bg:#fdf5e3; --crit-bg:#fbeded;
}
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){
    color-scheme: dark;
    --surface-1:#1a1a19; --plane:#0d0d0d;
    --text-primary:#ffffff; --text-secondary:#c3c2b7; --muted:#898781;
    --grid:#2c2c2a; --baseline:#383835; --border:rgba(255,255,255,.10);
    --series-1:#3987e5; --series-2:#d95926;
    --good-ink:#0ca30c; --warn-ink:#fab219; --crit-ink:#e66767;
    --good-bg:#12210f; --warn-bg:#241d09; --crit-bg:#2a1414;
  }
}
:root[data-theme="dark"]{
  color-scheme: dark;
  --surface-1:#1a1a19; --plane:#0d0d0d;
  --text-primary:#ffffff; --text-secondary:#c3c2b7; --muted:#898781;
  --grid:#2c2c2a; --baseline:#383835; --border:rgba(255,255,255,.10);
  --series-1:#3987e5; --series-2:#d95926;
  --good-ink:#0ca30c; --warn-ink:#fab219; --crit-ink:#e66767;
  --good-bg:#12210f; --warn-bg:#241d09; --crit-bg:#2a1414;
}
body{background:var(--plane);color:var(--text-primary);font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;}
.page{max-width:960px;margin:0 auto;padding:32px 20px 64px;}
code,pre,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}
h1{font-size:24px;margin:0 0 4px;letter-spacing:-.01em;}
h2{font-size:17px;margin:0 0 6px;letter-spacing:-.01em;}
h3{font-size:14px;margin:22px 0 8px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.06em;}
p{margin:0 0 10px;}
.muted{color:var(--muted);}
.note{color:var(--text-secondary);font-size:13px;margin-bottom:14px;}
.statement{font-size:15px;color:var(--text-primary);}

.masthead{display:flex;gap:18px;align-items:baseline;border-bottom:1px solid var(--border);padding-bottom:18px;margin-bottom:22px;}
.brand{font-weight:700;letter-spacing:.16em;font-size:12px;color:var(--muted);}
.target code{font-size:12px;color:var(--text-secondary);display:block;margin-bottom:2px;word-break:break-all;}
.target .muted{font-size:12px;}

section{background:var(--surface-1);border:1px solid var(--border);border-radius:10px;padding:20px;margin-bottom:16px;}

/* The hero. Tone is carried by a left rule + an iconed badge, never by colour alone. */
.hero{border-left:4px solid var(--muted);}
.hero.good{border-left-color:var(--good);}
.hero.critical{border-left-color:var(--critical);}
.hero.unknown{border-left-color:var(--warning);}
.verdict-badge{display:inline-block;font-weight:650;font-size:13px;letter-spacing:.04em;text-transform:uppercase;
  padding:5px 11px;border-radius:999px;margin-bottom:10px;border:1px solid var(--border);}
.hero.good .verdict-badge{background:var(--good-bg);color:var(--good-ink);}
.hero.critical .verdict-badge{background:var(--crit-bg);color:var(--crit-ink);}
.hero.unknown .verdict-badge{background:var(--warn-bg);color:var(--warn-ink);}
.verdict-statement{font-size:16px;line-height:1.5;margin-bottom:18px;}
.margin{font-size:14px;color:var(--text-secondary);}

.chart{margin:6px 0 4px;}
.chart svg{width:100%;height:auto;display:block;}
.bar-label{font:600 12.5px system-ui,sans-serif;fill:var(--text-primary);}
.bar-value{font:600 13px system-ui,sans-serif;fill:var(--text-primary);}
.bar-sub{font:11.5px system-ui,sans-serif;fill:var(--muted);}
.legend{display:flex;gap:18px;flex-wrap:wrap;font-size:12px;color:var(--text-secondary);margin-top:6px;}
.legend .sw{display:inline-block;width:11px;height:11px;border-radius:2px;margin-right:6px;vertical-align:-1px;}
.sw1{background:var(--series-1);} .sw2{background:var(--series-2);}
.swh{background:repeating-linear-gradient(45deg,var(--muted) 0 2px,transparent 2px 5px);border:1px solid var(--baseline);}
.swn{background:color-mix(in srgb,var(--series-1) 12%,transparent);border:1px solid var(--series-1);}

.missing{background:var(--warn-bg);border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin:14px 0 4px;font-size:13px;}
.missing ul{margin:6px 0 0;padding-left:18px;} .missing li{margin-bottom:4px;}
.basis{background:var(--plane);border:1px solid var(--border);border-radius:8px;padding:12px 14px;font-size:13px;}
.basis ul{margin:4px 0 10px;padding-left:18px;}

.proof{margin-top:18px;border:1px solid var(--border);border-radius:8px;background:var(--plane);padding:16px;}
.proof-head{display:flex;gap:28px;flex-wrap:wrap;align-items:flex-start;}
.proof-label{font-size:11.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:2px;}
.proof-figure{font-size:34px;font-weight:650;letter-spacing:-.02em;line-height:1.1;}
.proof-notice-figure{font-size:20px;font-weight:600;}
.proof-note{font-size:12px;color:var(--text-secondary);max-width:40ch;margin-top:4px;}
.sandbox{font-size:12px;color:var(--text-secondary);margin:12px 0 0;}
.repro{background:var(--plane);border:1px solid var(--border);border-radius:6px;padding:12px;overflow-x:auto;font-size:12px;}

.banner{border-radius:8px;padding:12px 14px;margin:12px 0;border:1px solid var(--border);font-size:13px;}
.banner p{margin:4px 0 0;}
.banner.warn{background:var(--warn-bg);}
.banner.danger{background:var(--crit-bg);color:var(--crit-ink);}
.banner.ok{background:var(--good-bg);}

.chip{display:inline-block;font-size:12px;padding:2px 8px;border-radius:999px;border:1px solid var(--border);white-space:nowrap;}
.chip.good{background:var(--good-bg);color:var(--good-ink);}
.chip.critical{background:var(--crit-bg);color:var(--crit-ink);}
.chip.unknown{background:var(--warn-bg);color:var(--warn-ink);}

.scroll{overflow-x:auto;}
table{border-collapse:collapse;width:100%;font-size:13px;}
th{text-align:left;font-weight:600;color:var(--text-secondary);border-bottom:1px solid var(--baseline);padding:7px 10px 7px 0;font-size:12px;text-transform:uppercase;letter-spacing:.04em;}
td{border-bottom:1px solid var(--grid);padding:8px 10px 8px 0;vertical-align:top;}
td code{font-size:12px;}
.addr{background:var(--plane);border:1px solid var(--border);border-radius:4px;padding:1px 5px;}

.path{border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin-bottom:10px;background:var(--plane);}
.path-head{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:8px;font-size:13px;}
.hops{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:8px;align-items:center;}
.hops li{display:flex;flex-direction:column;gap:2px;border:1px solid var(--border);border-radius:6px;padding:6px 10px;background:var(--surface-1);}
.hops li+li::before{content:"→";position:absolute;margin-left:-19px;color:var(--muted);}
.hop-kind{font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);}
.rel{font-size:11px;color:var(--text-secondary);}

.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px 22px;margin:0;}
.kv dt{font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);}
.kv dd{margin:1px 0 0;font-size:13px;word-break:break-all;}
.counts{font-size:14px;}
.wrap{word-break:break-all;font-size:12px;color:var(--text-secondary);}
details{margin-top:12px;}
summary{cursor:pointer;font-size:13px;color:var(--text-secondary);padding:6px 0;}
.tabletwin{margin-top:16px;}
footer{margin-top:26px;font-size:12px;color:var(--text-secondary);}
</style>`;

// --- CLI --------------------------------------------------------------------

function main(): void {
  const inDir = process.argv[2] ?? "calibration/reports";
  const outDir = process.argv[3] ?? "site";
  const liveDir = process.env.RIPCORD_LIVE_DIR ?? "calibration/live";
  const onlyPublishable = !process.argv.includes("--all");
  mkdirSync(outDir, { recursive: true });

  const built: { label: string; report: Report; figures: unknown }[] = [];
  for (const file of readdirSync(inDir).filter((x) => x.endsWith(".json")).sort()) {
    const report = JSON.parse(readFileSync(join(inDir, file), "utf8")) as Report;
    const label = basename(file, ".json");
    if (onlyPublishable && !report.disclosure.publishable) {
      console.log(`· skipped ${label} — disclosure.publishable is false`);
      continue;
    }
    // The sidecar is looked up beside the reports, never inside them. A missing
    // one is a normal state that renders as "not fetched", not an error.
    const sidecarPath = join(liveDir, `${label}.json`);
    let live: Sidecar | null = null;
    if (existsSync(sidecarPath)) {
      live = JSON.parse(readFileSync(sidecarPath, "utf8")) as Sidecar;
    }
    const { html, figures } = renderReport(report, label, live);
    writeFileSync(join(outDir, `${label}.html`), html);
    built.push({ label, report, figures });
    console.log(`✓ ${label}.html  (${figures.length} checked figures)`);
  }

  writeFileSync(join(outDir, "index.html"), renderIndex(built));
  console.log(`✓ index.html  (${built.length} pages)`);
}

function renderIndex(pages: { label: string; report: Report }[]): string {
  const rows = pages
    .map(({ label, report }) => {
      const v = report.verdict;
      const tone = toneOf(v?.status ?? "undetermined");
      const ew = report.exitWindow?.assessment;
      const windowText =
        v?.exitWindowSeconds != null
          ? humanSeconds(v.exitWindowSeconds)
          : ew?.status === "not_proven_binding"
            ? `${humanSeconds(ew.nominalDelaySeconds)} nominal, unproven`
            : ew?.status === "immutable_within_checks"
              ? "no route found"
              : "not established";
      return `<a class="card ${tone}" href="./${encodeURIComponent(label)}.html">
        <span class="card-verdict">${TONE_MARK[tone]} ${escapeHtml(VERDICT_LABEL[v?.status ?? "undetermined"] ?? "")}</span>
        <span class="card-name">${escapeHtml(label)}</span>
        <span class="card-meta">notice: ${escapeHtml(windowText)} · leave: ${escapeHtml(
          // A halted exit is not a duration. Showing "0" here would read as
          // "instant" — the exact inversion of what a closed door means.
          report.timeToExit?.blockable.status === "currently_blocked"
            ? "HALTED at this block"
            : v?.timeToExitSeconds != null
              ? humanSeconds(v.timeToExitSeconds)
              : "not established",
        )}</span>
      </a>`;
    })
    .join("\n");

  return `<title>Ripcord — calibration set</title>
${STYLE}
<style>
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;}
.card{display:flex;flex-direction:column;gap:5px;padding:14px 16px;border:1px solid var(--border);border-left-width:4px;
  border-radius:9px;background:var(--surface-1);text-decoration:none;color:inherit;}
.card.good{border-left-color:var(--good);} .card.critical{border-left-color:var(--critical);} .card.unknown{border-left-color:var(--warning);}
.card-verdict{font-size:11.5px;font-weight:650;text-transform:uppercase;letter-spacing:.05em;}
.card.good .card-verdict{color:var(--good-ink);} .card.critical .card-verdict{color:var(--crit-ink);} .card.unknown .card-verdict{color:var(--warn-ink);}
.card-name{font-size:15px;font-weight:600;}
.card-meta{font-size:12px;color:var(--text-secondary);}
</style>
<main class="page">
  <header class="masthead"><div class="brand">RIPCORD</div><div class="target"><h1>Calibration set</h1>
    <span class="muted">${pages.length} mainnet protocols, every one pinned to block 25800000 on chain 1</span></div></header>
  <section>
    <h2>What these pages are</h2>
    <p class="note">Each page is rendered from a pinned JSON report — no live scanning, no network access at render or view time.
    Only reports that pass the disclosure gate are published here; reports blocked by an unrecognised probe result are deliberately absent.</p>
    <p class="note"><strong>Read the colours as epistemics, not as grades.</strong> Amber is not "medium risk" — it means Ripcord
    could not establish an answer, and an unestablished answer is never rendered as a pass. A hatched bar has no length to read off it
    on purpose.</p>
  </section>
  <section><h2>Reports</h2><div class="cards">${rows}</div></section>
</main>`;
}

if (process.argv[1] && process.argv[1].endsWith("render.ts")) main();
