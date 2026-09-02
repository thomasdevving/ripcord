# The Mobula live layer

Ripcord's verdict is a **pinned artifact**: one target, one block, one ruleset, and
a report that is byte-identical whether you run it today from a cold cache or in a
year from a warm one. That property is the reason anyone should believe the tool,
and `pnpm determinism` exists to prove it rather than assert it.

Live market data is the opposite kind of thing. It is current, it is third-party,
and it is different every time you ask. It is also genuinely useful — it answers
questions the pinned layer structurally cannot.

So Ripcord has both, and keeps them apart on purpose. This document explains which
Mobula endpoints are used, why each one earns its place, and why none of them is
allowed anywhere near the verdict.

> **About the figures in this document.** Every dollar amount below is a **live
> observation**, read from Mobula on **2026-09-02** and stamped in the sidecar it
> came from. Unlike every figure on a rendered report page, these are not
> reproducible and will differ next time anyone fetches — that is the whole point of
> the layer. This is why `docs/MOBULA.md` is deliberately excluded from
> `pnpm verify:claims`, which checks prose against *pinned* reports; the exclusion is
> recorded in `scripts/verify-claims.mjs` so it cannot later look like an oversight.
> Quote these numbers as "observed on 2026-09-02", never as standing facts.

---

## 1. The separation, stated plainly

| | Pinned verdict | Live layer |
|---|---|---|
| Source | On-chain reads + Chainlink, via `PinnedChain` | Mobula REST |
| Anchored to | A block number and hash | A wall-clock instant |
| Reproducible | Byte-identical, cold or warm | Never — by design |
| Cached | `(chainId, block, method, params)`, permanently valid | Not cached at all |
| Lives in | `calibration/reports/*.json` | `calibration/live/*.json` (sidecar) |
| Can affect a verdict | — | **No. Structurally prevented.** |
| Failure means | An explicit `unknowns[]` / `errors[]` entry | The panel says "live data unavailable" |

**Nothing in the pinned path calls Mobula.** The pinned path is `src/cli.ts`,
`src/chain`, `src/detect`, `src/report`, `src/fork`. The live layer is `src/live`
plus `scripts/fetch-live.ts` and `scripts/live-panel.ts`. There is no import edge
from the first set to the second, at any depth.

That is not a promise. `pnpm verify:boundary` walks the import graph transitively
from the pinned roots and fails the build if it can reach `src/live` by any number
of hops — it prints the offending chain when it does. It runs in CI beside
`verify:pages` and `verify:claims`, and it needs neither network nor an API key,
because the property is structural.

It checks four things:

1. **No import path** from pinned code into `src/live` (transitive walk, not a grep).
2. **No Mobula reference** — hostname, module, or env var — anywhere in the pinned path.
3. **No live data inside a pinned report**: every report JSON is scanned for the
   live layer's field names and for the vendor's name.
4. **No API key** in any committed sidecar or rendered page.

Verified to actually fail: injecting `import { liveLayerVersion } from "../live/exposure.js"`
into `src/detect/ownership.ts` produces

```
✗ the pinned path reaches the live layer: src/report/build.ts -> src/detect/ownership.ts -> src/live/exposure.ts
```

and injecting an `exposureUsd` field into a report produces
`✗ report weth9.json carries live-layer field "exposureUsd"`.

### Why not just cache Mobula through `PinnedChain`?

Because `DiskCache` is keyed by `(chainId, blockNumber, method, params)` and
justified by one sentence: *a historical block never changes, so a cache hit is
permanently valid*. A live price has no block and is stale on arrival. Caching it
under that key would make a warm run serve yesterday's market as today's — the
cache boundary laundering a stale read into a fact, which is the exact defect class
of KNOWN EDGES #14, #23 and #31. So the live layer has no cache, no pinning, and
carries a `fetchedAt` stamp that is rendered on the page.

### The sidecars are deliberately non-deterministic

`calibration/live/*.json` change on every fetch. That is correct and expected.
`pnpm determinism` covers `calibration/reports/` only. A changed sidecar is never
a determinism regression, and `verify-boundary` prints that note on every run so
nobody has to rediscover it.

---

## 2. The endpoints, and why each one is there

### Holdings — `GET genius-api.mobula.io/api/2/wallet/holdings`

*What does this contract hold right now, across every chain.*

This is the endpoint that closes a real, documented gap. Ripcord's dependency graph
checks the target's balance against a **curated list of six mainnet ERC20s**
(`src/chain/majorTokens.ts`) — a deliberate limitation, recorded as KNOWN EDGE #5,
because Ripcord runs no indexer and does no balance discovery. Anything outside
that list is invisible to it, at any block, under any provider.

Called with `fetchAllChains=true`, so the answer spans chains rather than
re-confirming mainnet.

**The case that makes the point.** Lido's withdrawal queue holds roughly **$63.7M of
native ETH**. Native ETH is not an ERC20. No entry in `MAJOR_TOKENS` could ever
match it — not because the list is too short, but because it is a list of contract
addresses and native ETH has none. The live layer marks that holding
`outsideCuratedList: true`, and the panel labels it, so what the live layer adds is
visible per row rather than claimed in prose.

Native assets get their **own path** through the composer. They arrive under the
sentinel pseudo-address `0xeeee…eeee`, which is *the same on every chain*: a price
map keyed on address alone silently merges ETH with BNB, and did — verified on
cbETH, where ETH came back carrying BNB's quote. Every lookup in this layer is
keyed by `(chainId, address)`, and the sentinel is never sent to the ERC20 price or
metadata endpoints, because it is not a contract.

### Market data — `POST genius-api.mobula.io/api/2/token/price`

*A second quote, and the liquidity behind it.*

Batched (up to 500 pairs). Returns `priceUSD` and `liquidityUSD`. Used for two things:

- A **second derivation** of each holding's value — `amount × priceUSD`, compared
  against the holdings endpoint's own `amountUSD`. Disagreement beyond 10% means no
  USD figure is published for that holding at all.
- **Liquidity**, as a plausibility floor. The pinned verdict deliberately does not
  model liquidity depth (KNOWN EDGE #20 — `timeToExit.liquidity.modelled` is a zod
  literal `false`, so a fabricated number cannot even be expressed), and this layer
  does not model it either. It only rejects a marking that is off by an **order of
  magnitude**, which is the signature of a bad price rather than a big position.

  > **This threshold was wrong first, and the correction is worth recording.** The
  > original rule was the obvious one — refuse to count value exceeding the token's
  > liquidity at all. It discarded **$93.2M of USDT and $35.7M of DAI on Curve
  > 3pool**, both completely real, because a large protocol routinely holds more of
  > a token than any single venue's depth. It also failed to catch the biggest
  > fiction in the set. With the 10× multiple, 3pool's live exposure comes to
  > **$160,373,035.58** against the vendor's independently-reported
  > $160,373,036 — agreement that the absolute rule destroyed.

### Metadata — `GET api.mobula.io/api/1/multi-metadata`

*Names and logos, for readability.*

A holdings row reading `0x2260fac5…` is useless to a non-crypto-native reader;
"Wrapped Bitcoin" with a logo is not. Batched, keyed by `(contract, blockchain)`
pairs — Mobula returns `contracts[]` and `blockchains[]` as parallel arrays, and
pairing them by index is what keeps a multi-chain token's entries distinct.

Logos are **downloaded once at fetch time and inlined as `data:` URIs**, never
hotlinked. A rendered Ripcord page must not reach the network when someone opens it
— `verify-pages.mjs` rejects any page containing `src="https://…"`, a remote
stylesheet, a `<script src>` or a `fetch(` — and hotlinking a CDN would break that
for decoration while leaking every page view to the vendor. Oversized, non-image or
failed fetches fall back to a text monogram.

> **A documentation correction, since it cost time.** The v2 endpoints are on
> `genius-api.mobula.io`, not `api.mobula.io` as the reference pages state —
> `api.mobula.io/api/2/wallet/holdings` returns `{"statusCode":404}`. The v1
> metadata endpoint is the other way round. Both hosts answer keyless at a reduced
> rate limit.

### WebSocket — `wss://api.mobula.io`

Not shipped. See §5.

---

## 3. Live wallet data is hostile input, and is treated as such

Three problems, all found by looking at real responses rather than by reasoning
about them.

### The names are attacker-controlled

Holdings for any well-known address are full of airdropped tokens whose symbol and
name are chosen by whoever minted them. Lido's queue really carries entries reading
`⚠️ URGENT WHATSAPP MODERATOR +31684797985` and
`Visit website nano-eth .net to claim rewards`. Mobula's own
`filterSpam=true&minLiquidity=10000` does **not** remove them — measured, not assumed.

Escaping stops them being markup. It does not stop them being *believed*. A phishing
token rendered as the identity of a holding borrows the page's credibility, on a
security tool's own site.

So **identity is `(chainId, contract address)`, and nothing else.** The vendor's
strings live in fields literally named `unverifiedSymbol` and `unverifiedName`, the
renderer shows them underneath the address with an `unverified` badge, and the
logo's `alt` is deliberately empty so a screen reader never announces an
attacker-chosen string as the token's name. A lure that clears the value floor still
cannot present itself as an asset.

### The values can be fiction

cbETH's wallet reports a `totalWalletBalanceUSD` of **$11.8 trillion**, produced by
one empty-symbol token at $237bn per unit that passed the vendor's own spam filter.
So the headline figure is **computed here**, by summing holdings this layer is
willing to stand behind. The vendor's own total is shown separately and labelled as
theirs.

Each holding carries a `valuation` basis, which is weakest-link provenance
(CLAUDE.md design rule 7) applied to market data:

| Basis | Meaning | Counted? |
|---|---|---|
| `endpoints_agree` | Holdings value and price-derived value agree within 10% | Yes |
| `single_source` | Only one quote exists — natives have no ERC20 contract to quote | Yes, and says so |
| `uncorroborated` | The two quotes materially disagree | **No** — shown, not counted |
| `implausible_vs_liquidity` | Marked value exceeds reported liquidity by **more than 10×** | **No** — shown with both figures |

`endpoints_agree` is named carefully. Both figures come from the same vendor and
probably the same pool data, so it is a **consistency check between two endpoints,
not independent verification**. Calling it "corroborated" would claim more than the
evidence supports.

That distinction is not academic. At 16:20 UTC, USDC's own contract reported
**$101bn**, almost all of it one empty-symbol token at `0x6cada045…` whose two
quotes agreed perfectly and which also reported $825bn of liquidity — so it passed
every check above. **Agreement between two views of one vendor's bad data is still
bad data.** The remaining defence is disclosure, so the exposure carries a
`concentration` field and the panel says, above the table:

> **99.9% of this figure is one token** (`0x6cada045…`, which the vendor cannot
> name). Ripcord does not verify third-party price or liquidity data, and a single
> dominant holding is exactly where a vendor's figures are least worth trusting.
> Treat the total as a pointer to look, not as a measurement.

**And then it disappeared.** Re-fetching the same address two hours later returned
no such token at all: USDC's live exposure is now **$404,903** across nine
holdings, with USDT at 52% the largest. Same endpoint, same address, same working
session — **$101,413,176,500 and then $404,903**.

Nothing was wrong with either read. That is simply what live third-party data is:
current, useful, and revisable without notice. It is also the most compact argument
this project can make for the boundary. A verdict that anyone can re-derive in a
year cannot rest on a number that changed by five orders of magnitude over lunch,
and a report that quoted the first figure would have been permanently, unfalsifiably
wrong. The pinned layer reads its own facts from a block that will never change; the
live layer says what it saw and stamps when it saw it. Neither is a substitute for
the other, which is the whole design.

### Filtering must be visible, and itemised

Withholding a row is fine; withholding it silently is the same failure as an
unlabelled partial role scan. And one blended "N filtered" number would blur
together things that mean different things — most junk is not *below the floor*, it
is *unpriceable*.

So `withheld` carries **one bucket per reason**, each with its own count and, where
meaningful, its own total:

- `N below the $1 display floor`
- `N beyond the top 12 shown`
- `N shown, but not counted in the total: two price quotes disagreed`
- `N shown, but not counted in the total: marked value exceeds reported liquidity`

---

## 4. Reliability

Every Mobula call returns a discriminated result rather than throwing:

```ts
type MobulaResult<T> = { ok: true; data: T } | { ok: false; reason: string }
```

In the pinned path, "fail loud" means throwing so a caller can record an explicit
unknown. Here it means something slightly different, because a third-party outage is
not a fact about the contract and must never take down a page whose verdict does not
depend on it. The loudness moves to the page: **"live data unavailable — `<reason>`"**,
with the reason rendered verbatim.

What is forbidden is the third option — a silent empty result that reads as "this
contract holds nothing." An unavailable exposure has `exposureUsd: null` and
`holdingsCount: null`, never `0`.

- **Timeout** hard, via `AbortController`: 30s for price and metadata, **120s for holdings**.

  > The split was measured, not guessed, and the first version was wrong. A flat
  > 30s budget failed on six targets — Balancer Vault, cbETH, WETH9 and three
  > Compound contracts — and because the failures arrived mixed in with genuine
  > HTTP 503s, they read as rate limiting. They were not. A multi-chain sweep over
  > a large wallet is simply slow: WETH9 holds **5,341 entries across 21 chains**
  > and takes **50.7 seconds** to come back. The mainnet-only variant of the same
  > request is *slower* still, which rules out "ask for less" as the fix. Worth
  > recording because the misdiagnosis was self-consistent: a timeout and a 503
  > both surface as "live data unavailable", and only timing the raw request
  > separated them.
- **Retry** up to 4 attempts with exponential backoff on 429/5xx and network errors; a 4xx returns immediately.
- **A 200 carrying non-JSON** (proxy pages, captive portals) is a failure, not an empty portfolio.
- **Partial degradation**: if holdings succeed but price or metadata fail, the panel still renders and `endpoints` records which answered, with the failure in `notes`.
- **Resumable fetch**: `pnpm live:fetch` skips targets that already have a good sidecar, so a rate-limited sweep converges over re-runs. `--refetch` forces a full re-pull.

All of this is tested with the network stubbed (`test/liveExposure.test.ts`, 15
tests, no network in CI): a 503, a thrown network error, an HTML-instead-of-JSON
response, enrichment-only failure, the sentinel collision, each valuation basis, the
vendor-total rejection, itemised withholding, the phishing-name case, and
concentration.

### Coverage of the calibration set

21 of the 22 publishable targets have a live sidecar. The exception is **Balancer
Vault**, which the vendor refuses outright — an immediate HTTP 503 in 0.23s, not a
timeout, on every attempt across a working day. Balancer's Vault holds the pooled
assets of the entire protocol, and the holdings sweep for it is evidently more work
than the endpoint will do.

That one is left in place rather than papered over. It is the degradation path
running on a real target, and its page says exactly what happened:

> **Live data unavailable.** holdings: HTTP 503.
> This is a third-party availability failure, not a finding about the contract.
> Every figure in the report above was derived on-chain at the pinned block and is
> entirely unaffected.

Which is the property that matters: the verdict for Balancer Vault is complete,
checked and unchanged, because it never depended on Mobula in the first place.

### The API key

`MOBULA_API_KEY` in `.env`, free from https://admin.mobula.io. **Optional** — every
endpoint used here answers keyless at a lower rate limit, so the layer works without
one and a report is byte-identical either way. The key is read only by `src/live/*`
and `scripts/fetch-live.ts`, never committed, and `verify-boundary` fails the build
if it ever appears in a sidecar or a page. `.env` is gitignored and gitleaks scans
the full history on every CI run.

---

## 5. What is not built

**WebSocket streaming.** Mobula exposes `wss://api.mobula.io` with market-details,
balance and position streams, and a live watcher over the analysed protocols is the
natural next step for the Watchtower idea in CLAUDE.md's day-6 plan. It is not
shipped here. A streaming watcher is a stateful, long-running component, and the
honest place to add one is after the static layer is solid rather than beside it —
the same depth-over-breadth call the proof engine made in covering exactly one
upgrade archetype.

**Live data in the verdict.** Not a scoping decision — a boundary. It is the thing
this document exists to explain, and `pnpm verify:boundary` exists to enforce.
