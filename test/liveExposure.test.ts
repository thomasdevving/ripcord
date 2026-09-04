/**
 * Tests for the Mobula live layer — pure-logic, with the network stubbed. What
 * they pin is not "Mobula works", which is not ours to guarantee, but the three
 * properties that make it safe to put third-party data on a Ripcord page:
 *
 *   1. A Mobula failure degrades the panel and NOTHING else. Never an exception,
 *      never an empty result that could read as "holds nothing".
 *   2. Value is only claimed when it is defensible, and the reason is recorded.
 *      The cases are drawn from real responses: the sentinel-address collision
 *      that quoted ETH at BNB's price, and cbETH's $11.8tn total.
 *   3. Withholding is itemised by reason, never merged into one vague number.
 */
import { describe, expect, it, vi, afterEach, beforeAll } from "vitest";
import { buildLiveExposure, DISPLAY_FLOOR_USD } from "../src/live/exposure.js";
import { isNativeAsset, tokenKey, NATIVE_ASSET_SENTINEL } from "../src/live/mobula.js";

// Retries are real in production and pointless here: these tests assert what a
// failure DOES, not how long it waits first.
beforeAll(() => { process.env.MOBULA_RETRY_BASE_MS = "0"; });

/** Installs a fetch stub that answers by URL, so no test touches the network. */
function stubFetch(handler: (url: string, init?: RequestInit) => { status?: number; body: unknown } | Error): void {
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const out = handler(url, init);
    if (out instanceof Error) throw out;
    const status = out.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: "",
      headers: new Map() as unknown as Headers,
      text: async () => JSON.stringify(out.body),
      json: async () => out.body,
    } as unknown as Response;
  });
}

const holdingsBody = (holdings: unknown[], total = 0) => ({
  data: { totalWalletBalanceUSD: total, wallets: ["0x1"], holdings },
});

const erc20 = (address: string, symbol: string, amount: number, amountUSD: number, chainId = "evm:1") => ({
  token: { address, chainId, symbol, name: symbol, decimals: 18, liquidityUSD: 1e9 },
  amount,
  amountUSD,
  chainBalances: { [chainId]: { chainId, address, amount, amountUSD } },
});

afterEach(() => vi.unstubAllGlobals());

describe("failure is a panel state, never an exception and never a blank", () => {
  it("returns status=unavailable with the reason when holdings fail", async () => {
    stubFetch(() => ({ status: 503, body: {} }));
    const e = await buildLiveExposure("0xabc", 1);
    expect(e.status).toBe("unavailable");
    expect(e.reason).toContain("503");
    // The distinction that matters: no data is NOT zero data.
    expect(e.exposureUsd).toBeNull();
    expect(e.holdingsCount).toBeNull();
    expect(e.holdings).toEqual([]);
  });

  it("survives a network throw rather than propagating it", async () => {
    stubFetch(() => new Error("getaddrinfo ENOTFOUND"));
    const e = await buildLiveExposure("0xabc", 1);
    expect(e.status).toBe("unavailable");
    expect(e.reason).toContain("ENOTFOUND");
  });

  it("treats a 200 carrying non-JSON as a failure, not as an empty portfolio", async () => {
    vi.stubGlobal("fetch", async () => ({
      ok: true, status: 200, statusText: "", headers: new Map() as unknown as Headers,
      text: async () => "<html>gateway</html>",
    } as unknown as Response));
    const e = await buildLiveExposure("0xabc", 1);
    expect(e.status).toBe("unavailable");
    expect(e.reason).toContain("not JSON");
  });

  it("still renders holdings when only the enrichment endpoints fail", async () => {
    stubFetch((url) => {
      if (url.includes("/wallet/holdings")) return { body: holdingsBody([erc20("0xaaa", "AAA", 10, 100)], 100) };
      return { status: 500, body: {} };
    });
    const e = await buildLiveExposure("0xabc", 1);
    expect(e.status).toBe("ok");
    expect(e.holdings).toHaveLength(1);
    expect(e.endpoints).toEqual({ holdings: true, price: false, metadata: false });
    // Degradation is recorded, not silent.
    expect(e.notes.join(" ")).toMatch(/price enrichment unavailable/);
    expect(e.notes.join(" ")).toMatch(/metadata unavailable/);
  });
});

describe("native assets get their own path", () => {
  it("recognises the sentinel and never sends it to the ERC20 endpoints", async () => {
    const priceCalls: string[] = [];
    stubFetch((url, init) => {
      if (url.includes("/wallet/holdings")) {
        return {
          body: holdingsBody([
            { token: { address: NATIVE_ASSET_SENTINEL, chainId: "evm:1", symbol: "ETH", name: "Ethereum", decimals: 18 },
              amount: 100, amountUSD: 250_000,
              chainBalances: { "evm:1": { chainId: "evm:1", amount: 100, amountUSD: 250_000 } } },
          ], 250_000),
        };
      }
      if (url.includes("/token/price")) { priceCalls.push(String(init?.body)); return { body: { payload: [] } }; }
      return { body: { data: [] } };
    });

    const e = await buildLiveExposure("0xabc", 1);
    expect(e.holdings[0]!.isNative).toBe(true);
    // The sentinel is not a contract; quoting it would be meaningless.
    expect(priceCalls.join("")).not.toContain(NATIVE_ASSET_SENTINEL);
    // Single source is stated explicitly rather than passed off as corroborated.
    expect(e.holdings[0]!.valuation.basis).toBe("single_source");
    expect(e.exposureUsd).toBe(250_000);
  });

  it("counts a native holding as outside the curated list — MAJOR_TOKENS cannot contain it", async () => {
    stubFetch((url) =>
      url.includes("/wallet/holdings")
        ? { body: holdingsBody([{ token: { address: NATIVE_ASSET_SENTINEL, chainId: "evm:1", symbol: "ETH" },
            amount: 1, amountUSD: 2500, chainBalances: {} }], 2500) }
        : { body: { payload: [], data: [] } },
    );
    const e = await buildLiveExposure("0xabc", 1);
    expect(e.holdings[0]!.outsideCuratedList).toBe(true);
  });

  it("keys tokens by (chain, address) so the shared sentinel cannot merge ETH with BNB", () => {
    // The live defect this prevents: on cbETH both ETH and BNB came back under
    // the same sentinel, and an address-keyed price map quoted ETH at $687.
    expect(tokenKey("evm:1", NATIVE_ASSET_SENTINEL)).not.toBe(tokenKey("evm:56", NATIVE_ASSET_SENTINEL));
    expect(isNativeAsset(NATIVE_ASSET_SENTINEL.toUpperCase())).toBe(true);
    expect(isNativeAsset("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48")).toBe(false);
  });
});

describe("a USD figure has to be defensible to be counted", () => {
  const withPrice = (priceUSD: number, liquidityUSD = 1e9) => (url: string) => {
    if (url.includes("/wallet/holdings")) return { body: holdingsBody([erc20("0xaaa", "AAA", 10, 1000)], 1000) };
    if (url.includes("/token/price"))
      return { body: { payload: [{ address: "0xaaa", chainId: "evm:1", priceUSD, liquidityUSD }] } };
    return { body: { data: [] } };
  };

  it("counts a holding when both endpoints agree", async () => {
    stubFetch(withPrice(100)); // 10 units × $100 = $1000, matching the holdings quote
    const e = await buildLiveExposure("0xabc", 1);
    expect(e.holdings[0]!.valuation.basis).toBe("endpoints_agree");
    expect(e.exposureUsd).toBe(1000);
  });

  it("claims NO value when two quotes materially disagree", async () => {
    stubFetch(withPrice(500)); // 10 × $500 = $5000 vs a $1000 holdings quote
    const e = await buildLiveExposure("0xabc", 1);
    const v = e.holdings[0]!.valuation;
    expect(v.basis).toBe("uncorroborated");
    expect(v.usd).toBeNull();
    expect(e.exposureUsd).toBe(0);
    // Still SHOWN, and the disagreement is on the record.
    expect(e.holdings).toHaveLength(1);
    expect(e.withheld.some((b) => /quotes disagreed/.test(b.reason))).toBe(true);
  });

  it("refuses to count a marking that is off by an order of magnitude", async () => {
    stubFetch(withPrice(100, 5)); // $1000 marked against $5 of liquidity = 200x
    const e = await buildLiveExposure("0xabc", 1);
    const v = e.holdings[0]!.valuation;
    expect(v.basis).toBe("implausible_vs_liquidity");
    expect(v.usd).toBeNull();
    expect(e.exposureUsd).toBe(0);
  });

  it("still counts a large REAL position that merely exceeds one venue's depth", async () => {
    // The regression this pins: Curve 3pool holds $93.2M of USDT against a
    // reported $80.9M of liquidity. An absolute "value > liquidity" rule
    // discarded it, along with $35.7M of genuine DAI. Both are real holdings.
    stubFetch(withPrice(100, 870)); // $1000 marked against $870 = 1.15x, plainly fine
    const e = await buildLiveExposure("0xabc", 1);
    expect(e.holdings[0]!.valuation.basis).toBe("endpoints_agree");
    expect(e.exposureUsd).toBe(1000);
  });

  it("never adopts the vendor's own portfolio total as the headline", async () => {
    stubFetch((url) =>
      url.includes("/wallet/holdings")
        ? { body: holdingsBody([erc20("0xaaa", "AAA", 10, 1000)], 11_869_053_141_142.9) }
        : { body: { payload: [], data: [] } },
    );
    const e = await buildLiveExposure("0xabc", 1);
    expect(e.vendorReportedTotalUsd).toBe(11_869_053_141_142.9);
    expect(e.exposureUsd).toBe(1000);
  });
});

describe("withholding is itemised, and identity is never the vendor's name", () => {
  it("separates below-floor from not-counted rather than merging them", async () => {
    stubFetch((url) => {
      if (url.includes("/wallet/holdings")) {
        return {
          body: holdingsBody([
            erc20("0xaaa", "AAA", 10, 1000),
            erc20("0xdust", "DUST", 1, DISPLAY_FLOOR_USD / 2),
            erc20("0xdust2", "DUST2", 1, 0),
          ], 1000),
        };
      }
      if (url.includes("/token/price"))
        return { body: { payload: [{ address: "0xaaa", chainId: "evm:1", priceUSD: 100, liquidityUSD: 1e9 }] } };
      return { body: { data: [] } };
    });
    const e = await buildLiveExposure("0xabc", 1);
    const floorBucket = e.withheld.find((b) => /display floor/.test(b.reason));
    expect(floorBucket?.count).toBe(2);
    // Each bucket carries its own reason — a single blended count would be less
    // honest than it needs to be.
    expect(new Set(e.withheld.map((b) => b.reason)).size).toBe(e.withheld.length);
  });

  it("keeps an attacker-chosen name as unverified metadata, with the address as identity", async () => {
    const lure = "⚠️ URGENT WHATSAPP MODERATOR +31684797985";
    stubFetch((url) =>
      url.includes("/wallet/holdings")
        ? { body: holdingsBody([erc20("0xbad", lure, 1, 500)], 500) }
        : { body: { payload: [], data: [] } },
    );
    const e = await buildLiveExposure("0xabc", 1);
    const h = e.holdings[0]!;
    // The vendor string is preserved verbatim — truncating it would be its own
    // small lie — but it lives in a field whose NAME says it is not trusted.
    expect(h.unverifiedSymbol).toBe(lure);
    expect(h.address).toBe("0xbad");
    expect(h.chainId).toBe("evm:1");
    expect(Object.keys(h)).not.toContain("symbol");
    expect(Object.keys(h)).not.toContain("name");
  });
});

describe("concentration is disclosed, because agreeing endpoints can both be wrong", () => {
  it("reports the dominant holding's share and whether the vendor can even name it", async () => {
    // USDC's own contract, live: $101bn of a $101bn total sits in one
    // empty-symbol token that reports $825bn of liquidity, so it passes the
    // agreement check AND the liquidity check. The only honest response left is
    // to say out loud that the total is one token.
    stubFetch((url) => {
      if (url.includes("/wallet/holdings")) {
        return {
          body: holdingsBody([
            { token: { address: "0x6cada", chainId: "evm:1", symbol: "", name: "" },
              amount: 1, amountUSD: 101_412_764_944, chainBalances: {} },
            erc20("0xusdt", "USDT", 10, 209_146),
          ], 101_412_974_090),
        };
      }
      if (url.includes("/token/price")) {
        return { body: { payload: [
          { address: "0x6cada", chainId: "evm:1", priceUSD: 101_412_764_944, liquidityUSD: 825_567_421_414 },
          { address: "0xusdt", chainId: "evm:1", priceUSD: 20_914.6, liquidityUSD: 78_176_562 },
        ] } };
      }
      return { body: { data: [] } };
    });

    const e = await buildLiveExposure("0xabc", 1);
    expect(e.holdings[0]!.valuation.basis).toBe("endpoints_agree");
    expect(e.concentration).not.toBeNull();
    expect(e.concentration!.topShare).toBeGreaterThan(0.99);
    expect(e.concentration!.topIsUnnamed).toBe(true);
    expect(e.concentration!.topAddress).toBe("0x6cada");
  });

  it("reports no meaningful concentration for a spread portfolio", async () => {
    stubFetch((url) => {
      if (url.includes("/wallet/holdings")) {
        return { body: holdingsBody([erc20("0xa", "A", 10, 1000), erc20("0xb", "B", 10, 1000)], 2000) };
      }
      if (url.includes("/token/price")) {
        return { body: { payload: [
          { address: "0xa", chainId: "evm:1", priceUSD: 100, liquidityUSD: 1e9 },
          { address: "0xb", chainId: "evm:1", priceUSD: 100, liquidityUSD: 1e9 },
        ] } };
      }
      return { body: { data: [] } };
    });
    const e = await buildLiveExposure("0xabc", 1);
    expect(e.concentration!.topShare).toBeCloseTo(0.5, 5);
    expect(e.concentration!.topIsUnnamed).toBe(false);
  });
});
