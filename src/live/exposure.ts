/**
 * Composes the Mobula endpoints into one LIVE exposure view for a target.
 *
 * WHAT THIS IS FOR. The pinned report's dependency graph answers "does this
 * contract hold any of six curated major ERC20s at block N" — a deliberate,
 * documented limitation (KNOWN EDGE #5: no indexer, no balance discovery). That
 * limitation is honest but it is still a limitation, and it is exactly the shape
 * of thing a live indexed source closes. So this layer answers a DIFFERENT
 * question with different epistemics: "what does this address hold right now,
 * across every chain, according to a third party." It sits beside the verdict
 * and is never an input to it.
 *
 * THE CLEAREST CASE, and the reason native assets get their own handling below:
 * Lido's withdrawal queue holds ~$63M of NATIVE ETH. Native ETH is not an ERC20,
 * so no entry in MAJOR_TOKENS could ever match it, at any block, under any
 * provider. That is not a gap the pinned layer should close by guessing — it is
 * a gap this layer closes by asking someone who indexes.
 *
 * ---------------------------------------------------------------------------
 * THREE PROBLEMS WITH LIVE WALLET DATA, ALL FOUND BY LOOKING AT IT
 * ---------------------------------------------------------------------------
 *
 * 1. THE NAMES ARE ATTACKER-CONTROLLED. Holdings for any well-known address are
 *    full of airdropped phishing tokens whose symbol and name are chosen by
 *    whoever minted them — verified live on Lido's queue, which carries entries
 *    reading "⚠️ URGENT WHATSAPP MODERATOR +31…" and "Visit website nano-eth
 *    .net to claim rewards". Escaping stops them being markup. It does NOT stop
 *    them being believed. So this layer treats the (chainId, contract address)
 *    pair as the token's IDENTITY, and the vendor's name and symbol as
 *    unverified display metadata that the renderer must label as such. A
 *    phishing token that clears the value floor still cannot present itself as
 *    a legitimate asset, because its name is never what identifies it.
 *
 * 2. THE VALUES CAN BE FICTION. cbETH's wallet reports a `totalWalletBalanceUSD`
 *    of $11.8 TRILLION, produced by one empty-symbol token at $237bn per unit
 *    that passed Mobula's own `filterSpam=true&minLiquidity=10000`. Publishing a
 *    vendor's portfolio total verbatim would put that figure on a Ripcord page.
 *    So the headline is computed HERE, from holdings this layer is willing to
 *    stand behind, and a holding earns that by its `valuation` basis below.
 *
 * 3. FILTERING MUST BE VISIBLE AND ITEMISED. Withholding a row is fine;
 *    withholding it silently is the same failure as an unlabelled partial scan.
 *    And a single "N filtered" number would blur together things with different
 *    meanings, because most junk is not below the floor — it is UNPRICEABLE.
 *    So `withheld` has one bucket per REASON, each with its own count.
 */
import { fetchHoldings, fetchPrices, fetchMetadata, chainName, isNativeAsset, tokenKey } from "./mobula.js";
import type { MobulaHolding } from "./mobula.js";
import { MAJOR_TOKENS } from "../chain/majorTokens.js";

/** Bump when the shape, the valuation rules, or the withholding rules change. */
export const liveLayerVersion = "0.5.0";

/** Holdings worth less than this are withheld from the page (and counted). */
export const DISPLAY_FLOOR_USD = 1;
/** At most this many rows are rendered; the remainder is counted, never dropped. */
export const DISPLAY_CAP = 12;
/** Two quotes further apart than this fraction are treated as disagreeing. */
export const CORROBORATION_TOLERANCE = 0.1;

/**
 * A holding is treated as implausibly marked when its value exceeds the token's
 * own reported liquidity by MORE THAN THIS MULTIPLE.
 *
 * The multiple exists because the first version of this check had no multiple,
 * and was wrong in the expensive direction. "Value greater than pool liquidity"
 * sounds like a sound plausibility test and is not: a large protocol routinely
 * holds more of a token than any single venue's depth. Verified live on Curve
 * 3pool, where the rule discarded $93.2M of USDT (1.15x the reported figure) and
 * $35.7M of DAI (5.9x) — both entirely real — while FAILING to catch the largest
 * piece of fiction in the whole set, USDC's $101bn empty-symbol token, whose
 * vendor-reported liquidity is an equally fictitious $825bn.
 *
 * So this is now a plausibility FLOOR, not a liquidity model. It is not trying to
 * decide whether a position could be exited — that needs pool discovery and depth
 * integration across venues, which Ripcord deliberately does not do (KNOWN EDGE
 * #20, where `liquidity.modelled` is a zod literal `false` precisely so a made-up
 * number cannot be expressed). It only rejects a marking that is off by an order
 * of magnitude, which is the shape of a bad price rather than a big position.
 *
 * The real defence against a plausible-looking fiction is not this check at all —
 * it is the concentration disclosure, which says out loud when a total rests on
 * one token.
 */
export const LIQUIDITY_IMPLAUSIBILITY_MULTIPLE = 10;

/**
 * How a holding's USD figure was established. This is weakest-link provenance
 * (CLAUDE.md design rule 7) applied to market data: a number that only one
 * source vouches for says so, and a number two sources disagree about is not
 * published as a number at all.
 */
export type Valuation =
  /**
   * The wallet-holdings value and the batch-price quote agree.
   *
   * NAMED CAREFULLY. Both figures come from the SAME vendor and probably from
   * the same underlying pool data, so this is a CONSISTENCY check between two
   * endpoints, not independent verification — calling it "corroborated" would
   * claim more than the evidence supports. Verified live why this distinction
   * matters: USDC's own contract holds an empty-symbol token at
   * 0x6cada045… whose two quotes agree perfectly on $101bn and which also
   * reports $825bn of liquidity, so it passes every check below. Agreement
   * between two views of one vendor's bad data is still bad data.
   */
  | { basis: "endpoints_agree"; usd: number }
  /** Only one quote exists — natives (no ERC20 contract to price), or no batch entry. */
  | { basis: "single_source"; usd: number; source: string }
  /** Two quotes materially disagree, so no USD value is claimed. Shown, not counted. */
  | { basis: "uncorroborated"; usd: null; note: string }
  /**
   * Marked value exceeds the token's own reported liquidity by more than an
   * order of magnitude, which is the signature of a bad price rather than a
   * large position. Shown with both figures, excluded from the total.
   */
  | { basis: "implausible_vs_liquidity"; usd: null; markedUsd: number; liquidityUsd: number; multiple: number };

export interface LiveChainSlice {
  chainId: string;
  chainName: string;
  amountUSD: number | null;
}

export interface LiveHolding {
  /** IDENTITY. The only fields a reader should trust. */
  chainId: string | null;
  address: string | null;
  isNative: boolean;
  /** UNVERIFIED display metadata, straight from the vendor. Never identity. */
  unverifiedSymbol: string;
  unverifiedName: string;
  logo: string | null;
  amount: number | null;
  valuation: Valuation;
  /** The two quotes, kept separately so a reader can check the corroboration. */
  holdingsQuoteUsd: number | null;
  priceQuoteUsd: number | null;
  liquidityUsd: number | null;
  chains: LiveChainSlice[];
  /**
   * True when this holding could not have appeared in the pinned report's
   * dependency graph. The concrete measure of what the live layer adds.
   */
  outsideCuratedList: boolean;
}

/**
 * Minimal identity supplied to the post-analysis discovery pass.
 *
 * This is intentionally separate from `holdings`: that array is a ranked,
 * floored UI view. Security discovery must also see unpriced and sub-dollar
 * entries, while still treating every vendor name as unverified metadata.
 */
export interface LiveCandidateHolding {
  chainId: string | null;
  address: string | null;
  isNative: boolean;
  unverifiedSymbol: string;
  unverifiedName: string;
  holdingsQuoteUsd: number | null;
}

/** One withheld bucket. Separate reasons stay separate — see problem 3 above. */
export interface WithheldBucket {
  reason: string;
  count: number;
  totalUsd: number | null;
}

export interface LiveExposure {
  liveLayerVersion: string;
  /**
   * ISO instant this was pulled. NOT deterministic and not meant to be: this
   * file is a timestamped snapshot, excluded from the determinism gate by
   * design. See docs/MOBULA.md and scripts/verify-boundary.mjs.
   */
  fetchedAt: string;
  target: string;
  chainId: number;
  status: "ok" | "unavailable";
  /** Present iff status is "unavailable". Rendered verbatim; never swallowed. */
  reason: string | null;
  /**
   * The headline. Computed here by summing holdings with a defensible valuation
   * basis — deliberately NOT the vendor's own portfolio total, which on one
   * calibration target is $11.8tn of fiction.
   */
  exposureUsd: number | null;
  countedHoldings: number;
  /** The vendor's own total, kept for comparison and clearly labelled as theirs. */
  vendorReportedTotalUsd: number | null;
  holdingsCount: number | null;
  chainCount: number | null;
  chains: string[];
  holdings: LiveHolding[];
  /** All vendor-proposed identities, before the independent discovery cap. */
  candidateHoldings?: LiveCandidateHolding[];
  withheld: WithheldBucket[];
  floorUsd: number;
  cap: number;
  /** Which Mobula endpoints answered, so a partial panel is legible as partial. */
  endpoints: { holdings: boolean; price: boolean; metadata: boolean };
  /**
   * How much of `exposureUsd` rests on its single largest holding.
   *
   * The check the valuation bases cannot make. A vendor's price and liquidity
   * figures can BOTH be wrong together, and when they are, the result is one
   * enormous holding that passes every test — USDC's contract reports $101bn
   * dominated entirely by one unnamed token. Publishing that as a flat total
   * would be technically sourced and practically misleading, so the panel
   * discloses the concentration instead of burying it.
   */
  concentration: { topShare: number; topAddress: string | null; topIsUnnamed: boolean } | null;
  /** Non-fatal degradations (e.g. price enrichment failed but holdings arrived). */
  notes: string[];
}

function curatedAddresses(chainId: number): Set<string> {
  return new Set((MAJOR_TOKENS[chainId] ?? []).map((t) => t.address.toLowerCase()));
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * An unavailable panel is a first-class result, not an exception and not a
 * blank. Every field a caller might read is present and explicitly empty, so a
 * renderer cannot accidentally paint "we could not ask" as "holds nothing".
 */
function unavailable(target: string, chainId: number, reason: string): LiveExposure {
  return {
    liveLayerVersion,
    fetchedAt: new Date().toISOString(),
    target,
    chainId,
    status: "unavailable",
    reason,
    exposureUsd: null,
    countedHoldings: 0,
    vendorReportedTotalUsd: null,
    holdingsCount: null,
    chainCount: null,
    chains: [],
    holdings: [],
    candidateHoldings: [],
    withheld: [],
    concentration: null,
    floorUsd: DISPLAY_FLOOR_USD,
    cap: DISPLAY_CAP,
    endpoints: { holdings: false, price: false, metadata: false },
    notes: [],
  };
}

/**
 * Decides what USD figure, if any, this layer is willing to publish for one
 * holding. The ordering matters: liquidity is checked FIRST, because a value
 * two sources happen to agree on is still not exposure if it cannot be realised.
 */
function valuate(
  holdingsUsd: number | null,
  priceUsd: number | null,
  liquidityUsd: number | null,
  native: boolean,
): Valuation {
  if (holdingsUsd === null) {
    return { basis: "uncorroborated", usd: null, note: "the vendor returned no USD value for this holding" };
  }
  if (liquidityUsd !== null && liquidityUsd > 0 && holdingsUsd > liquidityUsd * LIQUIDITY_IMPLAUSIBILITY_MULTIPLE) {
    return {
      basis: "implausible_vs_liquidity",
      usd: null,
      markedUsd: holdingsUsd,
      liquidityUsd,
      multiple: holdingsUsd / liquidityUsd,
    };
  }
  if (priceUsd === null) {
    // Natives have no ERC20 contract, so the batch price endpoint cannot quote
    // them at all — a structural single source, not a failure. Said out loud
    // rather than quietly treated as if it were corroborated.
    return {
      basis: "single_source",
      usd: holdingsUsd,
      source: native
        ? "wallet holdings only — a native asset has no ERC20 contract for the price endpoint to quote"
        : "wallet holdings only — the price endpoint returned no entry for this token",
    };
  }
  const spread = Math.abs(holdingsUsd - priceUsd) / Math.max(holdingsUsd, priceUsd);
  if (spread > CORROBORATION_TOLERANCE) {
    return {
      basis: "uncorroborated",
      usd: null,
      note: `two quotes disagree by ${(spread * 100).toFixed(1)}% ($${holdingsUsd.toFixed(2)} vs $${priceUsd.toFixed(2)})`,
    };
  }
  return { basis: "endpoints_agree", usd: holdingsUsd };
}

export async function buildLiveExposure(
  target: string,
  chainId: number,
  opts: { signal?: AbortSignal } = {},
): Promise<LiveExposure> {
  const fetchedAt = new Date().toISOString();
  const notes: string[] = [];

  // --- endpoint 1: holdings. The only failure that is fatal to the panel,
  // because there is nothing to price or name without it.
  const holdingsRes = await fetchHoldings(target, { ...(opts.signal ? { signal: opts.signal } : {}) });
  if (!holdingsRes.ok) return unavailable(target, chainId, holdingsRes.reason);

  const payload = holdingsRes.data.data;
  if (!payload || !Array.isArray(payload.holdings)) {
    return unavailable(target, chainId, "holdings: response contained no holdings array");
  }

  const all = payload.holdings;
  const curated = curatedAddresses(chainId);

  const usdOf = (h: MobulaHolding) => num(h.amountUSD) ?? 0;
  const sorted = [...all].sort((a, b) => usdOf(b) - usdOf(a));
  const aboveFloor = sorted.filter((h) => usdOf(h) >= DISPLAY_FLOOR_USD);
  const belowFloor = sorted.filter((h) => usdOf(h) < DISPLAY_FLOOR_USD);
  const shown = aboveFloor.slice(0, DISPLAY_CAP);
  const cappedOut = aboveFloor.slice(DISPLAY_CAP);

  // Candidate discovery deliberately consumes ALL identities, not `shown`.
  // No price or metadata endpoint is needed to decide whether an address can
  // be verified on-chain, and an unpriced new collateral is exactly the asset
  // a display-floor-derived security pass used to miss.
  const candidateHoldings: LiveCandidateHolding[] = all.map((h) => ({
    chainId: h.token?.chainId ?? null,
    address: h.token?.address ?? null,
    isNative: isNativeAsset(h.token?.address),
    unverifiedSymbol: h.token?.symbol ?? "",
    unverifiedName: h.token?.name ?? "",
    holdingsQuoteUsd: num(h.amountUSD),
  }));

  // --- endpoint 2: batch price, for the ERC20s being shown. The native
  // sentinel is deliberately NOT sent: it is not a contract, and because the
  // same sentinel is used on every chain, including it once produced a price
  // map in which ETH carried BNB's quote. Verified live on cbETH.
  const erc20Items = shown
    .filter((h) => !isNativeAsset(h.token?.address))
    .map((h) => ({ address: h.token?.address ?? "", blockchain: h.token?.chainId ?? "" }))
    .filter((i) => i.address && i.blockchain);

  const priceRes = await fetchPrices(erc20Items, { ...(opts.signal ? { signal: opts.signal } : {}) });
  // Keyed by (chainId, address) — never by address alone. See tokenKey().
  const priceBy = new Map<string, { priceUSD: number | null; liquidityUSD: number | null; logo: string | null }>();
  if (priceRes.ok) {
    for (const p of priceRes.data.payload ?? []) {
      if (!p.address) continue;
      if (p.error) {
        notes.push(`price unavailable for ${p.address}: ${p.error}`);
        continue;
      }
      priceBy.set(tokenKey(p.chainId, p.address), {
        priceUSD: num(p.priceUSD),
        liquidityUSD: num(p.liquidityUSD),
        logo: p.logo ?? null,
      });
    }
  } else {
    notes.push(`price enrichment unavailable — ${priceRes.reason}`);
  }

  // --- endpoint 3: metadata, for display names and logos. ERC20s only, same
  // reason as above.
  const metaRes = await fetchMetadata(erc20Items, { ...(opts.signal ? { signal: opts.signal } : {}) });
  const metaBy = new Map<string, { name: string | null; logo: string | null }>();
  if (metaRes.ok) {
    for (const entry of metaRes.data.data ?? []) {
      const d = entry?.data;
      if (!d) continue;
      const chains = d.blockchains ?? [];
      (d.contracts ?? []).forEach((c, i) => {
        // Mobula returns contracts and blockchains as parallel arrays; pairing
        // by index is what keeps a multi-chain token's entries distinct.
        metaBy.set(tokenKey(chains[i] ?? null, c), { name: d.name ?? null, logo: d.logo ?? null });
        metaBy.set(tokenKey("?", c), { name: d.name ?? null, logo: d.logo ?? null });
      });
    }
  } else {
    notes.push(`metadata unavailable — ${metaRes.reason}`);
  }

  const holdings: LiveHolding[] = shown.map((h) => {
    const addr = h.token?.address ?? null;
    const cid = h.token?.chainId ?? null;
    const native = isNativeAsset(addr);
    const price = priceBy.get(tokenKey(cid, addr));
    const meta = metaBy.get(tokenKey(cid, addr)) ?? metaBy.get(tokenKey("?", addr ?? ""));

    const holdingsQuote = num(h.amountUSD);
    const amount = num(h.amount);
    // The second quote is RECOMPUTED from the independent unit price, so
    // corroboration compares two derivations rather than one number to itself.
    const priceQuote = price?.priceUSD != null && amount != null ? price.priceUSD * amount : null;
    const liquidity = price?.liquidityUSD ?? num(h.token?.liquidityUSD);

    return {
      chainId: cid,
      address: addr,
      isNative: native,
      unverifiedSymbol: h.token?.symbol ?? "",
      unverifiedName: meta?.name ?? h.token?.name ?? "",
      logo: meta?.logo ?? price?.logo ?? h.token?.logo ?? null,
      amount,
      valuation: valuate(holdingsQuote, priceQuote, liquidity, native),
      holdingsQuoteUsd: holdingsQuote,
      priceQuoteUsd: priceQuote,
      liquidityUsd: liquidity,
      chains: Object.entries(h.chainBalances ?? {}).map(([id, b]) => ({
        chainId: id,
        chainName: chainName(id),
        amountUSD: num(b?.amountUSD),
      })),
      // A native asset is outside the curated list by definition — MAJOR_TOKENS
      // holds ERC20 contract addresses and native ETH has none.
      outsideCuratedList: native || chainId !== 1 || !addr || !curated.has(addr.toLowerCase()),
    };
  });

  const counted = holdings.filter((h) => h.valuation.usd !== null);
  const exposureUsd = counted.reduce((s, h) => s + (h.valuation.usd ?? 0), 0);

  const top = counted.reduce<LiveHolding | null>(
    (best, h) => (best === null || (h.valuation.usd ?? 0) > (best.valuation.usd ?? 0) ? h : best),
    null,
  );
  const concentration =
    top && exposureUsd > 0
      ? {
          topShare: (top.valuation.usd ?? 0) / exposureUsd,
          topAddress: top.address,
          // "Unnamed" is the honest signal here: a token the vendor cannot even
          // name, carrying most of a nine-figure total, is the shape of bad data.
          topIsUnnamed: top.unverifiedSymbol.trim() === "" && top.unverifiedName.trim() === "",
        }
      : null;

  const chainSet = new Set<string>();
  for (const h of all) for (const id of Object.keys(h.chainBalances ?? {})) chainSet.add(id);

  // One bucket per REASON. Empty buckets are dropped so the panel stays short,
  // but a non-zero count is always shown — see problem 3 in the header.
  const sumUsd = (hs: MobulaHolding[]) => hs.reduce((s, h) => s + usdOf(h), 0);
  const withheld: WithheldBucket[] = [
    { reason: `below the $${DISPLAY_FLOOR_USD} display floor`, count: belowFloor.length, totalUsd: sumUsd(belowFloor) },
    { reason: `beyond the top ${DISPLAY_CAP} shown`, count: cappedOut.length, totalUsd: sumUsd(cappedOut) },
    {
      reason: "shown, but not counted in the total: two price quotes disagreed",
      count: holdings.filter((h) => h.valuation.basis === "uncorroborated").length,
      totalUsd: null,
    },
    {
      reason: `shown, but not counted in the total: marked value exceeds reported liquidity by over ${LIQUIDITY_IMPLAUSIBILITY_MULTIPLE}x`,
      count: holdings.filter((h) => h.valuation.basis === "implausible_vs_liquidity").length,
      totalUsd: null,
    },
  ].filter((b) => b.count > 0);

  return {
    liveLayerVersion,
    fetchedAt,
    target,
    chainId,
    status: "ok",
    reason: null,
    exposureUsd,
    countedHoldings: counted.length,
    vendorReportedTotalUsd: num(payload.totalWalletBalanceUSD),
    holdingsCount: all.length,
    chainCount: chainSet.size,
    chains: [...chainSet].sort(),
    holdings,
    candidateHoldings,
    withheld,
    concentration,
    floorUsd: DISPLAY_FLOOR_USD,
    cap: DISPLAY_CAP,
    endpoints: { holdings: true, price: priceRes.ok, metadata: metaRes.ok },
    notes,
  };
}


/**
 * Recomputes every valuation, and the totals that depend on it, from quotes a
 * sidecar ALREADY holds — no network.
 *
 * This exists because the valuation rules are the part of this layer most likely
 * to need correcting (the liquidity multiple above was corrected once already,
 * from live evidence), and re-fetching 22 targets through a rate-limited public
 * tier to test a threshold change is both slow and a waste of someone's API
 * quota. Every input the rules use — both quotes and the liquidity figure — is
 * stored per holding, so this is a pure function of the sidecar.
 *
 * Deliberately does NOT touch `fetchedAt`: the market data is still from the
 * moment it was fetched, and re-stamping it would be a lie about its age.
 */
export function revalueExposure<T extends LiveExposure>(sidecar: T): T {
  if (sidecar.status !== "ok") return sidecar;

  const holdings = sidecar.holdings.map((h) => ({
    ...h,
    valuation: valuate(h.holdingsQuoteUsd, h.priceQuoteUsd, h.liquidityUsd, h.isNative),
  }));

  const counted = holdings.filter((h) => h.valuation.usd !== null);
  const exposureUsd = counted.reduce((s, h) => s + (h.valuation.usd ?? 0), 0);
  const top = counted.reduce<LiveHolding | null>(
    (best, h) => (best === null || (h.valuation.usd ?? 0) > (best.valuation.usd ?? 0) ? h : best),
    null,
  );

  // Only the valuation-derived buckets are recomputed; the below-floor and cap
  // buckets describe holdings this sidecar never stored and cannot be re-derived.
  const structural = sidecar.withheld.filter((b) => !/not counted in the total/.test(b.reason));
  const withheld: WithheldBucket[] = [
    ...structural,
    {
      reason: "shown, but not counted in the total: two price quotes disagreed",
      count: holdings.filter((h) => h.valuation.basis === "uncorroborated").length,
      totalUsd: null,
    },
    {
      reason: `shown, but not counted in the total: marked value exceeds reported liquidity by over ${LIQUIDITY_IMPLAUSIBILITY_MULTIPLE}x`,
      count: holdings.filter((h) => h.valuation.basis === "implausible_vs_liquidity").length,
      totalUsd: null,
    },
  ].filter((b) => b.count > 0);

  return {
    ...sidecar,
    liveLayerVersion,
    holdings,
    exposureUsd,
    countedHoldings: counted.length,
    concentration:
      top && exposureUsd > 0
        ? {
            topShare: (top.valuation.usd ?? 0) / exposureUsd,
            topAddress: top.address,
            topIsUnnamed: top.unverifiedSymbol.trim() === "" && top.unverifiedName.trim() === "",
          }
        : null,
    withheld,
  };
}
