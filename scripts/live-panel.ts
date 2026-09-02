/**
 * Renders the LIVE (Mobula) panel that sits BESIDE a pinned report.
 *
 * Kept in its own file, and taking an exposure rather than a Report, so the
 * separation is visible in the module graph and not merely asserted in prose:
 * this function cannot read a verdict, cannot touch the FigureLog, and cannot
 * contribute a figure that verify-pages would check against the report. It
 * renders third-party data that the report does not contain and never will.
 *
 * THREE RENDERING RULES, each answering a specific way this panel could mislead:
 *
 * 1. IDENTITY IS THE ADDRESS, NEVER THE NAME. Token names in wallet data are
 *    chosen by whoever minted the token, and airdropped phishing tokens use that
 *    to impersonate real assets. Escaping stops them being markup; it does not
 *    stop them being believed. So every row leads with (chain, contract address)
 *    and carries the vendor's name and symbol underneath, explicitly badged
 *    "unverified". A lure that clears the value floor still cannot dress itself
 *    up as an asset, because the name is never what identifies it here.
 *
 * 2. THE TOTAL IS OURS AND SAYS SO. The vendor's own portfolio total is fiction
 *    on at least one calibration target ($11.8tn for cbETH, from a single
 *    empty-symbol token at $237bn a unit). The headline is the sum of holdings
 *    with a defensible valuation basis, the vendor's figure is shown beside it
 *    when it differs, and both are labelled with whose number they are.
 *
 * 3. LIVE IS TIMESTAMPED AND VISUALLY SEPARATE. The panel carries the fetch
 *    instant and a plain statement that it is not part of the verdict. It never
 *    borrows the verdict's tones: this data cannot make a contract safe or
 *    unsafe, so painting it green or red would be a category error.
 */
import { escapeHtml, shortAddress } from "./figures.js";
import type { LiveExposure, LiveHolding, Valuation } from "../src/live/exposure.js";

/** The sidecar adds an inlined logo; see src/live/logos.ts for why it is inlined. */
export type SidecarHolding = LiveHolding & { logoDataUri?: string | null };
export type Sidecar = Omit<LiveExposure, "holdings"> & { holdings: SidecarHolding[] };

const usd = (v: number | null): string =>
  v === null ? "—" : "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const compactUsd = (v: number | null): string =>
  v === null ? "—" : "$" + v.toLocaleString("en-US", { maximumFractionDigits: 0 });

/**
 * A token's mark. Deliberately NOT the vendor logo when that is missing: a
 * generic placeholder glyph would imply we know something about the token. The
 * first character of the address is at least true.
 */
function tokenMark(h: SidecarHolding): string {
  if (h.logoDataUri) {
    // alt is empty on purpose: the address beside it is the real label, and an
    // attacker-chosen symbol must not become alt text a screen reader announces
    // as the token's identity.
    return `<img class="lv-logo" src="${escapeHtml(h.logoDataUri)}" alt="" width="20" height="20">`;
  }
  const glyph = h.isNative ? "◆" : (h.address ?? "?").slice(2, 3).toUpperCase();
  return `<span class="lv-logo lv-logo-fallback" aria-hidden="true">${escapeHtml(glyph)}</span>`;
}

/** Valuation basis → what the value cell says. A non-value is never a blank. */
function valuationCell(v: Valuation): string {
  switch (v.basis) {
    case "endpoints_agree":
      return `<strong>${usd(v.usd)}</strong><br><span class="lv-basis lv-ok" title="The wallet-holdings figure and the batch-price quote agree. Both come from the same vendor, so this is a consistency check rather than independent verification.">two endpoints agree</span>`;
    case "single_source":
      return `<strong>${usd(v.usd)}</strong><br><span class="lv-basis lv-single" title="${escapeHtml(v.source)}">single source</span>`;
    case "uncorroborated":
      return `<span class="lv-nonvalue">not counted</span><br><span class="lv-basis lv-warn">${escapeHtml(v.note)}</span>`;
    case "implausible_vs_liquidity":
      return `<span class="lv-nonvalue">not counted</span><br><span class="lv-basis lv-warn">marked ${usd(
        v.markedUsd,
      )} against ${usd(v.liquidityUsd)} of reported liquidity (${v.multiple.toFixed(0)}x)</span>`;
  }
}

function holdingRow(h: SidecarHolding): string {
  const chains = h.chains.length
    ? h.chains.map((c) => escapeHtml(c.chainName)).join(", ")
    : escapeHtml(h.chainId ?? "—");
  // The address is the identity and gets the prominent slot. The vendor's
  // strings sit underneath, badged, and are never presented as a fact.
  const identity = h.isNative
    ? `<code class="addr">native asset</code>`
    : `<code class="addr" title="${escapeHtml(h.address ?? "")}">${escapeHtml(shortAddress(h.address))}</code>`;
  const vendorLabel =
    h.unverifiedSymbol || h.unverifiedName
      ? `<span class="lv-unverified" title="Supplied by the data vendor and chosen by the token's deployer. Not verified by Ripcord.">unverified</span>
         <span class="lv-vendor">${escapeHtml(h.unverifiedSymbol)}${
           h.unverifiedName && h.unverifiedName !== h.unverifiedSymbol ? ` · ${escapeHtml(h.unverifiedName)}` : ""
         }</span>`
      : `<span class="lv-vendor lv-muted">no name supplied</span>`;

  return `<tr>
    <td>${tokenMark(h)}</td>
    <td>${identity}<div class="lv-names">${vendorLabel}</div></td>
    <td>${chains}</td>
    <td class="lv-num">${valuationCell(h.valuation)}</td>
    <td>${h.outsideCuratedList ? `<span class="lv-new">outside curated list</span>` : `<span class="lv-muted">on curated list</span>`}</td>
  </tr>`;
}

export function renderLivePanel(live: Sidecar | null): string {
  // No sidecar at all is its own state, and must not look like "holds nothing".
  if (!live) {
    return panelShell(
      null,
      `<p class="lv-unavailable"><strong>Live data not fetched.</strong> No Mobula snapshot exists for this target.
       Run <code>pnpm live:fetch</code> to add one. The verdict above does not depend on it and is unchanged either way.</p>`,
    );
  }

  if (live.status === "unavailable") {
    return panelShell(
      live,
      `<p class="lv-unavailable"><strong>Live data unavailable.</strong>
       ${escapeHtml(live.reason ?? "no reason recorded")}.</p>
       <p class="lv-note">This is a third-party availability failure, not a finding about the contract.
       Every figure in the report above was derived on-chain at the pinned block and is entirely unaffected.</p>`,
    );
  }

  const nTokens = live.countedHoldings;
  const nChains = live.chainCount ?? 0;
  const vendorDiffers =
    live.vendorReportedTotalUsd !== null &&
    live.exposureUsd !== null &&
    Math.abs(live.vendorReportedTotalUsd - live.exposureUsd) > Math.max(1, live.exposureUsd * 0.01);

  const headline = `<p class="lv-headline">Current exposure
    <strong>${compactUsd(live.exposureUsd)}</strong>
    across <strong>${nTokens}</strong> token${nTokens === 1 ? "" : "s"}
    on <strong>${nChains}</strong> chain${nChains === 1 ? "" : "s"}.</p>`;

  const vendorLine = vendorDiffers
    ? `<p class="lv-note">The vendor reports a portfolio total of ${compactUsd(live.vendorReportedTotalUsd)} for this
       address. Ripcord's figure counts only holdings whose value survived the checks below, so the two differ by design —
       vendor portfolio totals include tokens whose quoted price no market could honour.</p>`
    : "";

  // Concentration is disclosed BEFORE the table, because a total that rests on
  // one unnamed token is a fact about the headline, not a footnote to it.
  const c = live.concentration;
  const concentrationLine =
    c && c.topShare > 0.5
      ? `<p class="lv-concentration"><strong>${(c.topShare * 100).toFixed(1)}% of this figure is one token</strong>
         (<code>${escapeHtml(shortAddress(c.topAddress))}</code>${
           c.topIsUnnamed ? `, which the vendor cannot name` : ""
         }). Ripcord does not verify third-party price or liquidity data, and a single dominant holding is exactly where a
         vendor's figures are least worth trusting. Treat the total as a pointer to look, not as a measurement.</p>`
      : "";

  const rows = live.holdings.map(holdingRow).join("\n");

  // An empty portfolio is a real answer and gets a sentence, not an empty table.
  // It is also NOT the same statement as "live data unavailable" — one says the
  // vendor looked and found nothing, the other says we could not ask — so the
  // two must never render alike.
  const tableOrEmpty = live.holdings.length
    ? `<div class="scroll"><table>
       <thead><tr><th></th><th>Token identity</th><th>Chains</th><th>Live value</th><th>Pinned report</th></tr></thead>
       <tbody>${rows}</tbody>
     </table></div>
     <p class="lv-note"><strong>Tokens are identified by chain and contract address.</strong> Names and symbols come from the
     data vendor, originate with whoever deployed the token, and are shown only as unverified labels — wallet data routinely
     contains airdropped tokens whose names are phishing lures.</p>`
    : `<p class="lv-note">The vendor returned no token holdings for this address on any chain it indexes. That is an answer,
       not a failure — compare the "live data unavailable" state, which means the question could not be asked.</p>`;

  const withheld = live.withheld.length
    ? `<ul class="lv-withheld">${live.withheld
        .map(
          (b) =>
            `<li><strong>${b.count}</strong> ${escapeHtml(b.reason)}${
              b.totalUsd !== null && b.totalUsd > 0 ? ` <span class="lv-muted">(${usd(b.totalUsd)} in total)</span>` : ""
            }</li>`,
        )
        .join("")}</ul>`
    : `<p class="lv-note">Nothing was withheld: every holding the vendor returned is shown above.</p>`;

  const endpointNote = `<p class="lv-note">Endpoints answered — holdings: ${live.endpoints.holdings ? "yes" : "no"},
    price: ${live.endpoints.price ? "yes" : "no"}, metadata: ${live.endpoints.metadata ? "yes" : "no"}.
    ${live.notes.length ? escapeHtml(live.notes.join("; ")) + "." : ""}</p>`;

  return panelShell(
    live,
    `${headline}
     ${concentrationLine}
     ${vendorLine}
     ${tableOrEmpty}
     <h3 class="lv-h3">What is not in the total</h3>
     ${withheld}
     ${endpointNote}`,
  );
}

function panelShell(live: Sidecar | null, body: string): string {
  const stamp = live
    ? `<time datetime="${escapeHtml(live.fetchedAt)}">${escapeHtml(live.fetchedAt.replace("T", " ").replace(/\.\d+Z$/, " UTC"))}</time>`
    : "—";
  return `
  <section class="lv">
    <div class="lv-head">
      <h2>Live exposure <span class="lv-badge">LIVE · MOBULA</span></h2>
      <p class="lv-boundary">Live market data (Mobula) — <strong>not part of the reproducible verdict</strong>.
      Fetched ${stamp}. Everything above this line is pinned to the report's block and is byte-identical on a cold
      re-run; this section is a snapshot of the present and will differ every time it is fetched.</p>
    </div>
    ${body}
  </section>`;
}

/** Styles for the panel. Deliberately share no colour token with the verdict tones. */
export const LIVE_STYLE = `<style>
.lv{margin-top:30px;border:1px solid var(--border);border-left:4px solid #6b7cff;border-radius:9px;padding:16px 18px;background:var(--surface-1);}
.lv-head h2{margin:0 0 6px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.lv-badge{font-size:10.5px;letter-spacing:.08em;font-weight:700;color:#fff;background:#6b7cff;border-radius:999px;padding:3px 9px;}
.lv-boundary{font-size:12.5px;color:var(--text-secondary);margin:0 0 14px;}
.lv-headline{font-size:15px;margin:0 0 8px;}
.lv-headline strong{font-size:17px;}
.lv-note{font-size:12px;color:var(--text-secondary);margin:8px 0 0;}
.lv-h3{font-size:13px;margin:16px 0 6px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-secondary);}
.lv-withheld{margin:0;padding-left:18px;font-size:12.5px;color:var(--text-secondary);}
.lv-withheld li{margin:3px 0;}
.lv-logo{width:20px;height:20px;border-radius:50%;display:block;}
.lv-logo-fallback{background:var(--plane);border:1px solid var(--border);font-size:11px;line-height:18px;text-align:center;color:var(--muted);}
.lv-names{margin-top:3px;display:flex;gap:6px;align-items:baseline;flex-wrap:wrap;}
.lv-unverified{font-size:9.5px;text-transform:uppercase;letter-spacing:.06em;border:1px solid var(--border);border-radius:3px;padding:1px 4px;color:var(--muted);}
.lv-vendor{font-size:12px;color:var(--text-secondary);word-break:break-word;max-width:34ch;display:inline-block;}
.lv-muted{color:var(--muted);}
.lv-num{white-space:nowrap;}
.lv-basis{font-size:11px;}
.lv-ok{color:var(--text-secondary);}
.lv-single{color:var(--muted);border-bottom:1px dotted var(--muted);cursor:help;}
.lv-warn{color:var(--warn-ink);}
.lv-nonvalue{color:var(--muted);font-style:italic;}
.lv-new{font-size:11px;color:#4a56c8;}
.lv-unavailable{font-size:13px;margin:0;}
.lv-concentration{font-size:12.5px;margin:8px 0 0;padding:8px 10px;border-radius:6px;background:var(--warn-bg);color:var(--warn-ink);}
</style>`;
