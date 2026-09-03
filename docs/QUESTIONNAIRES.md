# Ripcord — Privacy, Security and Sovereignty

Answered against the tool **as it actually is** at the end of day 7, not against
an intended design. Where the honest answer is a caveat, it is written as a
caveat. Every claim below is checkable from this repository: the file is named,
or the command that demonstrates it is given.

One framing note that applies to all three sections. Ripcord is a **read-only
analysis tool**. It holds no key, signs nothing, submits no mainnet transaction,
and requests no approval. Its pinned write surface is a JSON report on stdout, a
disk cache under `.cache/`, and — for `prove`/`restrict` — an ephemeral local
`anvil` fork; `prove` may also write its two trace artefacts. The optional Mobula
fetcher writes timestamped sidecars under `calibration/live/`, structurally
outside the pinned verdict. Those facts answer a large share of what follows, so
they are stated once here rather than repeated.

---

## 1. Privacy

**What personal data does Ripcord collect?**
None. There is no account, no login, no telemetry, no analytics and no crash
reporting. The pinned analyser contacts only the RPC endpoint you configure;
`prove` and `restrict` also make the local `anvil` process read that same endpoint.
The optional, explicitly separate live-exposure fetcher contacts Mobula's holdings,
price and metadata endpoints. It is never called by the CLI or a rendered page,
and `pnpm verify:boundary` proves it cannot enter the pinned verdict. See
[`docs/MOBULA.md`](MOBULA.md) for the complete endpoint and metadata account.

**What data does it send to third parties, and to whom?**
For a scan, only what an Ethereum read requires, and only to the RPC provider
*you* choose in `RPC_URL_1`. Concretely: `eth_call`, `eth_getStorageAt`, `eth_getCode`,
`eth_getLogs`, `eth_getBlockByNumber`. Those requests reveal to your provider
which contract addresses you are analysing and at which block — which is
inherent to reading a chain you do not run yourself, and is stated in the
README's trust assumptions rather than glossed over. Ripcord adds nothing to
those requests: no identifiers, no headers, no user agent beyond the default.
If the optional live fetcher is run, Mobula additionally receives the public
contract addresses whose holdings and metadata are requested; no user identity is
sent.

**Is any of the data you analyse personal?**
Ripcord reads public on-chain state: contract code, storage slots, event logs,
and addresses holding privileged roles. Addresses are pseudonymous public
identifiers, not identity data, and Ripcord never attempts to attach a real-world
identity to one — no ENS resolution, no labelling service, no clustering, no
attribution beyond the on-chain relation that produced the address
("`owner()` returned this"). It also never characterises a holder: rule 4 of the
project's design philosophy forbids "malicious", "scam" or "rug", and the
capability-not-intent discipline is asserted in the proof engine's own tests.

**Where is data stored, and for how long?**
Locally, on the machine that ran the command. `.cache/` holds pinned RPC responses
keyed by `(chainId, blockNumber, method, params)` and never expires — deliberately,
because a historical block's contents cannot change. `.ripcord/proofs/` holds
optional proof artefacts. `calibration/live/` holds optional, timestamped Mobula
sidecars and is deliberately non-deterministic. Nothing is uploaded by Ripcord;
delete those local paths and their local copies are gone.

**The honest caveat: the hosted report site is not private.**
The pages under `site/`, deployed to GitHub Pages, are **public static files**.
Anyone with the link can read them, and they are indexable. That is intentional —
they are a published calibration set, not a user's private workspace — but it
means the deployment is a publication, not a service with privacy properties. If
you scan your own protocol, the report stays on your machine unless you choose to
publish it; the tool never publishes anything for you.

**A second honest caveat: your RPC provider sees your queries.**
Ripcord cannot fix this, and does not pretend to. If which contracts you are
investigating is itself sensitive, use a provider you trust, or your own node.
The cache reduces repeat exposure — a warm scan makes zero network calls — but
the first scan is visible to whoever serves it.

---

## 2. Security

**Does the tool hold keys, sign, or move funds?**
No, in all three cases, and this is structural rather than a promise.
- There is no key material anywhere in the codebase: no private key, no
  mnemonic, no keystore, no signing library configured for one. `viem`'s wallet
  client is used **only** against the local anvil fork, and only through
  `anvil_impersonateAccount`, which works precisely *because* no signature is
  required.
- No mainnet transaction is ever constructed or submitted. Every mainnet
  interaction is a read (`eth_call` and friends).
- The proof engine's own output states this in the artefact header it writes:
  `sandbox fork only. No mainnet tx, no key. Capability, not intent.`

**What is the blast radius if Ripcord is compromised or buggy?**
It reads public data and writes JSON. A worst-case bug produces a *wrong report*,
not a loss of funds — there are no funds under its control. The one component
that executes adversarial-shaped logic (`src/fork/`) is confined to an ephemeral
local `anvil` process pinned to a historical block, with a mandatory gas cap and
a guaranteed teardown (SIGTERM, then a SIGKILL backstop). It never touches
mainnet; the fork is the only execution surface.

**What secrets exist, and how are they handled?**
Two optional configuration secrets can exist: the RPC URL, which usually embeds
an API key, and `MOBULA_API_KEY` for a higher third-party rate limit (the Mobula
endpoints also work keyless). Both live in `.env`, which is gitignored from the
first commit, with `.env.example` shipping placeholders only. The RPC URL is
**never logged**: `describeProvider()`
(`src/chain/rpcPreflight.ts`) deliberately prints the URL's **host only** —
`Alchemy (eth-mainnet.g.alchemy.com)` — and there is a unit test asserting that
the fingerprint of a cache key does not incorporate the provider URL, so a key
cannot leak into a committed cache file either. `verify:boundary` rejects an API
key or Authorization value in committed live sidecars and pages.

**How do you know no secret was ever committed?**
`gitleaks detect --source . --config .gitleaks.toml` over the **full history**
(not just HEAD) reports *no leaks found* across all commits. The same scan runs
in CI on every push with `fetch-depth: 0`, so the property is enforced going
forward rather than asserted once.

**What is the tool's own supply chain?**
Three runtime dependencies, all widely used and pinned by a committed
`pnpm-lock.yaml`: `viem` (Ethereum RPC/ABI), `zod` (schema validation), and
`commander` (CLI argument parsing). Dev-only: `typescript`, `tsx`, `vitest`,
`@types/node`. One external binary, used by `prove` and `restrict`: Foundry's `anvil`,
which `src/fork/preflight.ts` fails loudly about if it is absent. No `solc`, no
Hardhat, no forge scripts — the drainer contract used in the proof is
hand-assembled EVM bytecode in TypeScript specifically so the whole codebase
stays one language and stays auditable inline.

**What is the tool's central security property?**
That it cannot quietly tell you something is safe when it is not. This is not a
policy but an enforced invariant, in four layers:
1. A capability finding is **structurally incapable** of naming a holder without
   the evidence for one (`GuardStatus` is a zod discriminated union).
2. An unproven delay is **structurally incapable** of appearing as an exit
   window (only the `binding` variant has a `windowSeconds` field).
3. The two static reassuring assessments carry
   `enumeration: { complete: z.literal(true) }`, so either one **cannot be
   constructed** over an incomplete authority picture — zod and `tsc` both refuse.
4. The newer `no_direct_restriction_found` fork tier is explicitly scoped and
   occurs nowhere in the calibration set; it is not presented as “safe exit”.
5. A report-level invariant in `scripts/verify-pages.mjs`, run in CI, re-derives
   incompleteness *independently* and rejects any reassuring verdict sitting on
   it, so a bug in the derivation cannot hide itself.

**Where is it weakest?**
Three places, all documented. First, it trusts the RPC to tell the truth; it runs
no node and cross-checks no second provider, so a lying endpoint is reported
faithfully. Second, its coverage is bounded by curated tables (proxy patterns,
taxonomy signatures, guard dialects, cooldown accessors) — and while an
unrecognised input always fails toward "undetermined" rather than toward
"clean", that means the tool is frequently less useful than an auditor, by
design. Third, the fork differential currently validates one Comet exit archetype
and one registered restriction candidate; its demonstrated restrictor is strong,
but its general clean direction is not yet a calibrated claim. See "What Ripcord
does NOT do" in the README.

---

## 3. Sovereignty

**Can a user run this without depending on us?**
Yes, and that is the point of the architecture. Ripcord is a local CLI: clone,
`pnpm install`, point `RPC_URL_1` at any endpoint you like (including your own
node), run. There is no Ripcord server, no API we host that the tool calls, no
license check, no account. If this project disappeared tomorrow, every clone
keeps working unchanged.

**Can a user verify our published results rather than trusting them?**
Yes, and this is the strongest sovereignty property the project has. Every
published report is pinned to a block, so it is reproducible rather than
merely repeatable:

```sh
rm -rf .cache/                       # start from nothing
node scripts/run-calibration.mjs     # regenerate all 26 reports cold
node scripts/compare-reports.mjs calibration/reports <your-output-dir>
```

`compare-reports.mjs` normalises `generatedAt` — the single intentionally
non-deterministic field — and diffs everything else byte for byte. A cold run
and a warm run must be **byte-identical**; that equivalence is what makes
"delete the cache and check for yourself" a meaningful instruction rather than a
hopeful one.

**Is the ruleset something we control?**
Partly, and this is the honest caveat in this section. The taxonomy, the guard
dialects, the cleared-dependency registry and the cooldown tables are curated by
us. They are **versioned** (`rulesetVersion`, `taxonomyVersion`,
`guardDialectsVersion`, `clearedRegistryVersion`, `authorityIndirectionVersion`)
and every report records the versions it was produced under, so a result is
always attributable to a specific ruleset and a change to our rules can never
silently alter what an old report meant. But they are curated, they live in this
repository, and today we are the ones who edit them. A user can fork and edit
them — they are plain data tables in TypeScript with derived selectors, not a
compiled blob — but there is no governance process, and pretending otherwise
would be dishonest.

**Do you host anything a user has to trust?**
One thing: the static report site. It is a convenience, not a dependency —
every page is generated from a committed JSON report by `scripts/render.ts`, and
`pnpm verify:pages` re-checks all 75 headline figures on the pages against the
source reports in CI. So a reader who does not trust the hosted pages can
regenerate them from the repository and diff. Nothing about the tool requires the
site to exist.

**What data does a user give up to use it?**
Nothing to us — we receive nothing at all. To their RPC provider: the addresses
and blocks they query. If they explicitly run the optional live fetcher, Mobula
also sees the public contract addresses requested. See Privacy above.

**Is the analysis itself sovereign — could we bias it?**
The reports are evidence-carrying by construction: every finding names the read
that produced it (`kind`, `params`, `rawValue`, `block`), so a claim can be
re-executed against the chain without going through Ripcord at all. That is the
real answer to "why trust the output" — you do not have to. The evidence is the
product; the verdict is a summary of it.
