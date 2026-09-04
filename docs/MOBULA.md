# The Mobula live layer

Ripcord's verdict is a **pinned artifact**: one target, one block, one ruleset, and
a report that is byte-identical whether you run it today from a cold cache or in a
year from a warm one. That property is the reason anyone should believe the tool,
and `node scripts/compare-reports.mjs <cold-dir> <warm-dir>` exists to test it
rather than assert it.

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
| Cached | `(chainId, block, method, params)`, permanently valid | Mobula responses are not put in the pinned cache; live-job results are stored as report-keyed sidecars |
| Lives in | `calibration/reports/*.json` | `calibration/live/*.json` and `.ripcord-data/asset-contexts/*.json` (sidecars) |
| Can affect a verdict | — | **No. Structurally prevented.** |
| Failure means | An explicit `unknowns[]` / `errors[]` entry | The panel says "live data unavailable" |

**Nothing in the pinned path calls Mobula.** The pinned path is `src/cli.ts`,
`src/chain`, `src/detect`, `src/report`, `src/fork`. The live layer is `src/live`
plus `scripts/fetch-live.ts` and `scripts/live-panel.ts`. There is no import edge
from the first set to the second, at any depth.

The live path is `src/live`, `server/asset-context.ts`, and the live scripts.
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

Mobula responses are never put in `DiskCache`, because `DiskCache` is keyed by `(chainId, blockNumber, method, params)` and
justified by one sentence: *a historical block never changes, so a cache hit is
permanently valid*. A live price has no block and is stale on arrival. Caching it
under that key would make a warm run serve yesterday's market as today's — the
cache boundary laundering a stale read into a fact, which is the exact defect class
of KNOWN EDGES #14, #23 and #31. So the live layer has no cache, no pinning, and
carries a `fetchedAt` stamp that is rendered on the page. The second layer does
use `PinnedChain` for its own `getCode` and `balanceOf` reads after Mobula has
proposed candidates. Those reads really are block facts, so the normal pinned
cache is the correct place for them.

### The sidecars are deliberately non-deterministic

`calibration/live/*.json` change on every fetch. That is correct and expected.
The report-directory comparison covers `calibration/reports/` only. A changed
sidecar is never a determinism regression, and `verify-boundary` prints that note
on every run so nobody has to rediscover it.

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

All of this is tested with the network stubbed (`test/liveExposure.test.ts`) and
the candidate pass has its own network-free tests (`test/assetContext.test.ts`): a 503, a thrown network error, an HTML-instead-of-JSON
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

## 5. Candidate verification and supported fork scenarios

### What the second layer now does

A live web analysis presents two explicit choices: **Ripcord analysis** and
**Ripcord + Mobula 2nd layer**. The second choice is default-off and is currently
enabled only for the supported Compound III cUSDCv3 target in a withdrawal-test
mode. That restriction is enforced both by the form and by server-side request
validation. Once a publishable deterministic report has been stored, this
separate process:

1. fetches a new timestamped Mobula snapshot for the analysed address;
2. takes identities from the complete holdings response, independently of the
   UI's $1 floor and top-12 display cap, then selects at most 64 unique valid
   same-chain ERC20 candidates;
3. verifies contract code and `balanceOf(target)` at the report's exact block;
4. checks the block hash before and after the pass; and
5. stores the result under the report id in `.ripcord-data/asset-contexts/`; and
6. itemises candidates withheld because they are native, on another/unclear
   chain, malformed, duplicated or beyond the independent discovery cap; and
7. when the user selected a fork mode and the report identifies Compound III,
   offers candidates with an explicit pinned balance result — including zero —
   to the supported collateral scenario.

### What survives when the discovery cap bites

Consuming the whole holdings response is what stopped an unpriced new collateral
from being invisible. A cap still has to drop something once there are more
eligible identities than slots, and the order it drops them in is not a detail:
these lists are full of airdropped tokens — verified live on Lido's withdrawal
queue, whose entries include outright phishing lures — so taking the first N in
the order the vendor happened to return would let that spam displace a real
collateral asset for no reason anyone could state, and would pick a different
set on the next fetch.

The ordering is therefore explicit and deliberately **value-blind**, because a
value ranking here would rebuild the exclusion this layer exists to remove, one
step further down:

1. curated major tokens for the analysed chain first — their identity is already
   established by an independent committed list, so excluding one would be
   indefensible;
2. everything else by address. Arbitrary, but stable: two selections over the
   same identities pick the same set, which vendor order does not guarantee even
   between two fetches a second apart.

Ordering only ever decides who is dropped once the cap is exceeded; below it,
every eligible identity is selected either way. Whatever is dropped is counted in
`beyond_cap` and rendered. Three regression tests pin this, all verified to fail
against vendor ordering: a curated token buried behind 70 airdrops is still
selected and ranked first, a reversed vendor response yields an identical
selection, and attaching vendor prices changes nothing about which candidates
survive.

The UI distinguishes five outcomes, and they are deliberately not
interchangeable: a non-zero balance, an explicitly verified zero, no contract at
that address at the block, a contract that did not answer `balanceOf` as an
ERC20 (it reverted, returned nothing, or returned something undecodable), and a
read that did not complete. Only the last is about our infrastructure; the other
four are things the chain positively said. Collapsing them — as an earlier
version did, mapping everything that was not a balance onto "read failed" —
would repeat, in the presentation layer, the absence-from-failure defect KNOWN
EDGE #31 closed in the read layer. Native assets, other chains and invalid addresses
are not guessed at. A candidate balance is still **not a fork experiment** and
does not mean that asset's exit was tested. The coverage table links a candidate
to a fork experiment only when the sidecar contains an exact chain-and-address
scenario record.

### The supported Compound III scenario

The additional fork pass is intentionally narrow. It does not infer arbitrary
protocol exits from token metadata. It first requires the deterministic report
to identify the Compound III / Comet exit interface. On one ephemeral Anvil fork
at the report block, it then:

1. reads Comet's base token, pause guardian and existing pause flags;
2. asks Comet itself whether each pinned-verified candidate is registered
   collateral;
3. seeds one whole token into a deterministic holder only inside Anvil by
   locating a standard Solidity balance mapping and verifying the mutation with
   the token's own `balanceOf`; it never removes tokens from Comet;
4. creates a debt-free position through the token's real approval and Comet's
   real supply path, with each candidate starting from its own snapshot;
5. in the control branch, withdraws the exact collateral amount and requires the
   holder to recover it completely;
6. reverts to the snapshot, calls the real guardian `pause` mutation with only
   withdrawals changed from false to true; and
7. repeats the identical withdrawal, accepting a direct restrictor
   only when the `withdraw` flag — and no other pause flag — moved false to true,
   Compound returns its exact `Paused()` error, and the position remains
   unchanged. All five flags are read on both sides of the mutation: re-sending
   the values observed beforehand is not a substitute for checking what actually
   changed, and a mutation that also froze supply or transfer is a different
   experiment that must not be reported as this one.

The base token is not exercised twice: it is linked to the primary exit-
restriction experiment already stored in the report. Assets Compound positively rejects — an
identified contract revert from `getAssetInfoByAddress`, never merely a failed
call — are `unsupported_asset`. An asset whose role read did not complete is
`role_unresolved`, which claims nothing about Compound at all; a later setup read
failing after the role was established is `read_failed`. Recognised collateral
for which Ripcord cannot create and exit a valid control position is
`baseline_unestablished`, not safe and not unsupported. Other incomplete paths
are `inconclusive`. These states keep a failed setup from becoming a reassuring
result, and keep an infrastructure failure from becoming a claim about the
protocol.

Before supplying, the pass records both the asset's `supplyCap` and Comet's
`totalsCollateral(asset)`. If the cap has no headroom, setup stops and names that
cause from those reads. If supply still reverts with headroom available, the
revert and measured headroom are recorded but no different cause is guessed.

The guardian is impersonated only inside the fork to invoke the real pause
function. Sandbox token funding is a disclosed Anvil storage mutation whose
result must be confirmed by `balanceOf`; Comet is not impersonated or drained
for funding. No key or mainnet transaction is used. Contract guardians,
including Safes, retain an explicit
caveat: their real signatures, guards, modules and internal execution path were
not reproduced, so the scenario proves protocol capability rather than a
real-world compromise.

The option is consent-gated because making the request discloses the analysed
contract address to Mobula. It is not sent by default. The worker never receives
the option, Mobula data or candidate results; enrichment starts only after a
publishable report exists, and it cannot delay or modify that report.
If the service restarts during enrichment, the stranded `pending` sidecar is
handled explicitly at boot: an unfinished snapshot becomes unavailable, while a
completed balance pass is preserved and only its unfinished fork batch becomes
unavailable.

### The deadline is cancellation, not a race

Worth stating because the first implementation got it wrong in a way that read
as correct. It wrapped the refresh in `Promise.race([complete(), expiry])`. A
race does not cancel its loser, so when the deadline won: the slot was released,
a terminal `unavailable` record was stored — and the vendor call kept going and
later overwrote that record with its own answer. Reproduced end to end, the
timeout at +100ms and the stale overwrite afterwards. The concurrency limit had
the same hole: it bounded wrappers, not work.

Each refresh now carries a `runId` and an `AbortController`. The signal reaches
the Mobula client, which checks it before every attempt and before every backoff
sleep, and the fork batch, which refuses to spawn anvil on an aborted signal.
Every write from inside a run is refused once that run is sealed or superseded,
and sealing happens before the terminal record is written, so the losing side is
already mute when it lands. The slot is normally returned after the work has
really stopped. If an operation ignores cancellation beyond the bounded grace
period, the run remains sealed, the slot is returned to preserve liveness, and a
loud server error records that the physical work outlived its logical slot.
Shutdown seals every in-flight run for the same reason. Settled runs are removed
from the generation map, so a long-lived server does not retain one controller
forever for every report it has processed.

Atomic file replacement prevents partial JSON, but by itself cannot preserve the
order of two concurrent complete replacements. Sidecar writes are therefore
serialised per report id: an older, slower write must finish before the newer
generation can be stored. Writes for different reports remain independent.

Regression tests pin these boundaries and were verified to fail against the old
behaviour: a late vendor answer cannot overwrite the timeout result, a sealed run
cannot write after cancellation, and two deliberately reordered physical writes
still leave the newest requested sidecar on disk.

### Fork port ownership is cross-process safe

Forks no longer select a random port from a process-local reservation set. Each
Anvil child receives `--port 0`, so the operating system assigns the port in the
same bind operation that gives the child ownership. Ripcord creates its RPC
client only after that exact child announces `Listening on 127.0.0.1:<port>`.
An existing node can therefore never be mistaken for the child that Ripcord
just spawned, even when it has the same fork block and no expected hash was
supplied. The exact block-number and block-hash checks remain as separate state
identity checks. Child output is discarded, and stderr is redacted before it
can enter an error, because Anvil output can contain the upstream RPC secret.

### Status: EXPERIMENTAL, live-tested but not a calibration claim

The multi-asset candidate scenario is shipped behind an **experimental** label,
in the UI and in the batch artifact itself (`experimental: true`). It is not
part of any calibration claim and no figure from it appears in this document.

An exploratory end-to-end run was performed against the committed Compound III
USDC report. Its per-asset counts have been **removed from this document**
rather than quoted, for the reason KNOWN EDGE #34 exists: the run produced no
artifact that is committed to this repository, so nothing here or in CI can
check the numbers against the evidence, and an unverifiable figure in a
write-up is the failure mode that edge documents. `.ripcord-data/` is runtime
state and gitignored; a claim about a run belongs in a committed artifact or
nowhere.

What the run did establish qualitatively, and what a reader may rely on, is
only this: the pipeline executes end to end, the base asset is linked to the
primary report rather than re-tested, assets Compound does not recognise are
refused rather than guessed at, and a recognised collateral whose sandbox
supply reverts stays `baseline_unestablished` instead of being scored. Any
per-asset count belongs in a committed artifact and a `verify:claims` rule
before it is written down again — see "What must land before a figure is
quoted" below.

### What must land before a quantitative figure is quoted

The mechanical gaps from the first version are now closed: discovery no longer
inherits the UI floor/cap, funding no longer drains the target, every candidate
has its own fork root, and supply-cap exhaustion is established from explicit
reads. Counts still should not be published until a representative batch
artifact is committed and covered by
`scripts/verify-claims.mjs`, so the prose and the evidence are checked against
each other in CI like every other figure in this project.

### The enriched assessment — where the two artifacts finally meet

Everything else in this layer is inert by construction: the sidecar cannot
change the report, and the coverage panel only describes what evidence exists.
Refusing to connect them forever has a cost of its own, though, and it is real.
A run can hold a fork-confirmed, zero-notice restriction on several collateral
assets while the report beside it reports only that base-asset suppliers can be
stopped — two artifacts disagreeing about how much was tested, with a reader
left to do the join by hand.

`buildEnrichedAssessment(report, assetContext)` composes one statement from
both. It is a pure function of two artifacts that already exist: no chain read,
no fork, no vendor fetch. Four rules make that safe, and each is in the types
rather than in care:

1. **The report is never modified.** This is a separate artifact served beside
   the verdict, and `changesVerdict` is a literal `false` — the schema cannot
   express a version that edited anything.
2. **The direction is caution-only.** There is no outcome variant that softens,
   clears or reassures. A demonstrated restriction can broaden a finding's scope
   (`scope_broadened`) or state something the report did not reach on its own
   (`stricter_than_report`). Anything else — including every candidate coming
   back `no_effect` — is `no_change`. The gate is reached before any speaking
   outcome is considered, so no route exists from a clean sidecar to a softer
   conclusion.
3. **The link must be earned.** Target, chain, block number, block hash and the
   batch's own fork block must all agree. Anything else is `unusable` with the
   mismatch named, because attaching a fork result to the wrong block would be a
   fabricated finding. Two MISSING hashes are not agreement.
4. **The scope travels with the claim.** Every outcome names the assets it rests
   on and lists the ones it does not, by (chain, address), so a total can always
   be reconciled against the batch it came from.

The rendered panel always quotes the report's own verdict in the same block, so
a statement that reaches further can never be read as a replacement for it.

Three break-tests hold this up, and each was verified to fail the suite when its
rule is removed: treating a no-effect candidate as a confirmation, skipping the
link check entirely, and treating two absent block hashes as a match.

### Still not built

**Generic per-asset fork discovery.** The shipped scenario covers Compound III
collateral withdrawal against its registered withdrawal-pause mutation. It does
not yet discover arbitrary asset roles, position construction, exit calls or
restrictors for other protocol families. Native assets, other chains and
unsupported contracts do not enter this fork pass. A verified-zero ERC20 may
now enter because the isolated holder is seeded without depending on the
target's balance.

**A mandatory real multi-asset fork integration test in CI.** An opt-in test now
runs the actual Compound III bytecode with several assets on a historical Anvil
fork: `pnpm test:live:assets`. It reads `RPC_URL_1` from the environment or local
`.env`, and sanitises provider failures before they reach test output. The normal
suite discovers but skips it, because public CI has no archive-RPC secret. Unit
tests remain mandatory and network-free; run the live test before a release or
demo when an archive endpoint is available. The same external-infrastructure
limit applies to the primary engine (see docs/FORK_VALIDATION.md).

**Economic and multi-step failure scenarios.** The fork pass does not model
governance proposals, timelock execution sequences, oracle manipulation,
liquidity shocks, mass withdrawals, supply-cap changes or combinations of
privileged calls. Those require explicit scenario definitions and their own
causality and completeness criteria.

**WebSocket streaming.** Mobula exposes `wss://api.mobula.io` with market-details,
balance and position streams, and a live watcher over the analysed protocols is the
natural next step for the Watchtower idea in CLAUDE.md's day-6 plan. It is not
shipped here. A streaming watcher is a stateful, long-running component, and the
honest place to add one is after the static layer is solid rather than beside it —
the same depth-over-breadth call the proof engine made in covering exactly one
upgrade archetype.

**Live data in the verdict.** Not a scoping decision — a boundary. It is the thing
this document exists to explain, and `pnpm verify:boundary` exists to enforce.
