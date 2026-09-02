# Ripcord

**Who holds privileged power over a DeFi contract, how fast they can use it, and whether you could get out first.**

## What it does

Ripcord scans a deployed EVM contract at a pinned block and produces an evidence-carrying report of its power structure: who can upgrade it, mint, freeze or sweep; whether those holders are EOAs, multisigs or timelocks; and how far the chain of authority really runs. It then computes the metric the rest of the tool exists for — the **Exit Window**: how much notice you get before the rules can change, minus every way that notice can be cut, measured against how long you would actually need to leave. Where it can, it stops arguing and *demonstrates*: `ripcord prove` executes the admin's own legitimate upgrade path on an ephemeral mainnet fork and measures the funds leaving. Every finding carries the exact read that produced it — the call, its parameters, the raw value, the block — so any claim can be re-executed against the chain without trusting Ripcord at all.

## The problem

An audit answers *"is there a bug in this code."* It does not answer *"who holds the keys."* With an upgradeable proxy, the code an auditor reviewed is not necessarily the code that runs tomorrow: an admin can swap the implementation, or exercise some other entirely legitimate on-chain power, without breaking a single rule any audit checked. No exploit is required. The system works exactly as designed and the user's funds are gone anyway.

The audience is anyone deciding whether to put money into a protocol and, more sharply, the security professionals who advise them. Every fact needed to see this coming is public, on-chain, and readable **before** you deposit — the proxy pattern, the admin address, whether it is an EOA or a 3-of-11 Safe, whether a timelock sits in between, how long that timelock is and who can shorten it. Nobody reads it, because nobody automates reading it.

## Why it matters

Because "audited" has become a synonym for "safe", and it is not the same claim. The gap between them is where a large share of user losses actually live, and it is a *legibility* problem rather than a cryptography problem — the information is already published, just never assembled.

Ripcord's contribution is to assemble it and then refuse to overstate it. That second half is the harder half and it is the whole design: a tool that flags everything is worthless, and a tool that reassures you is dangerous. Calibrated against 26 mainnet protocols, Ripcord produced **zero false-clean results** — no protocol was told it was fine when it was not. Its remaining error mode is under-determination: on 15 of 26 it says "I could not establish this" and names exactly what is missing. That trade is deliberate and it is the right way round, because an under-determination is visible and arguable in the report, while a false clean bill is invisible by construction.

## How it works

Five engines feed one verdict. Everything is pinned to a block and cached by `(chainId, block, method, params)`, so a warm run makes zero network calls and a **cold run is byte-identical to a warm one** — verified over all 26 reports.

| Stage | What it establishes |
|---|---|
| **Power map** | Proxy pattern (EIP-1967 transparent/UUPS/beacon, EIP-1167, legacy-zos), `owner()`/`pendingOwner()`, OpenZeppelin AccessControl roles (Enumerable getters, else a `RoleGranted`/`RoleRevoked` event replay from the binary-searched deployment block). Each power holder is classified: EOA / Safe (threshold + owners) / contract. |
| **Capabilities** | A reachability-limited walk of the contract's dispatcher recovers its real selector set — *not* a linear byte scan, so a factory's embedded child bytecode is structurally unreachable rather than misread. Selectors match a versioned taxonomy into power categories (CODE_CHANGE, FUND_MOVEMENT, SUPPLY, ACCESS_RESTRICTION, ECONOMIC, AUTHORITY_CHANGE). |
| **Guards, by probing** | For each capability, a real `eth_call` at the pinned block from three deterministic protocol-unrelated addresses, and the **revert is parsed**. A recognised auth revert attributes a holder; anything unrecognised is routed out of findings entirely and can never be reported as "unguarded". |
| **Authority resolution** | Recursion into each power holder's own authority (max depth 3, cycle detection, confidence degrading with depth), terminating explicitly at an EOA, a Safe, a timelock with its delay, or `no_authority_found`. Produces a path — `upgrade → ProxyAdmin → EOA 0x…` — not just a terminal address. |
| **Exit window vs. time to exit** | The window is modelled **per route** and the protocol figure is the **minimum**: a 2-day timelock on the upgrade path is worth nothing beside an un-delayed role. A Safe is not a delay. Binding-ness is established **by probe** against the delay mutator, never assumed. Time-to-exit is a lower bound with its gaps named. |

Two structural properties do most of the honesty work, and they are enforced by the schema rather than by discipline:

- **A capability cannot claim a holder it has not evidenced.** `GuardStatus` is a zod discriminated union in which only the `attributed` variant has a `holders` field.
- **An unproven delay cannot be expressed as a window**, and a reassuring result cannot be built over an incomplete role scan. Only the `binding` and `immutable_within_checks` variants carry `enumeration: { complete: z.literal(true) }`, so both are *unconstructable* without a positive completeness witness — zod and `tsc` refuse.

Full detail — report shape, each engine, the calibration results, trust assumptions, disclosure policy and the complete limitations list — is in **[docs/TECHNICAL.md](docs/TECHNICAL.md)**, with the calibration write-up in **[docs/CALIBRATION.md](docs/CALIBRATION.md)**.

### What Ripcord does NOT do

The [Limitations](docs/TECHNICAL.md#limitations) section below is the exhaustive engineering
list. This is the short version: the **deliberate boundaries**, so you can tell
in one screen what this tool is and is not claiming. None of these are bugs, and
none of them are on a roadmap to be fixed by the end of the week.

| Boundary | What that means in practice |
|---|---|
| **Capability, not intent** | Ripcord reports what a privileged address *can* do. It never claims anyone will do it, and the words "malicious", "scam" and "rug" appear nowhere in its output. A finding is not an accusation. |
| **Not a vulnerability scanner** | It does not look for bugs. An admin's ability to call a function it holds the key to is design, not a flaw. Ripcord answers "who holds the keys", which is the question an audit does *not* answer. |
| **EVM, one chain, one block** | Mainnet Ethereum, pinned to a block you pass. No L2s, no non-EVM chains, no "current state" mode. Everything is reproducible precisely because nothing is live. |
| **No indexer, no explorer API, no 4byte lookup** | Every fact comes from raw RPC reads. That is what keeps a report deterministic and re-runnable offline from cache — and it is why the token list, the taxonomy and the exit-mechanism tables are curated rather than discovered. |
| **One proof archetype** | `ripcord prove` simulates exactly one path: `CODE_CHANGE → drain` on an EIP-1967 **transparent** proxy. UUPS, beacon and legacy-zos paths return `produced: false` with a stated reason rather than a guessed simulation. Depth over breadth, on purpose. |
| **Dollar figures are floors, never ceilings** | A proof counts only the 6 curated major tokens. Value in unlisted tokens, LP positions or staked principal is invisible to it. |
| **Liquidity is not modelled at all** | `timeToExit.liquidity.modelled` is a literal `false` in the schema, so a made-up number cannot even be expressed. For a position large relative to available liquidity, the real exit is *longer* than reported. |
| **Enumeration is bounded by the provider's `eth_getLogs` range** | Role membership on a non-Enumerable contract is reconstructed by replaying events. On a range-capped endpoint a deep-history contract is only partially scanned — and Ripcord then refuses to issue a reassuring verdict at all. See [Aave's ACLManager](docs/TECHNICAL.md#the-aave-case-what-a-bounded-answer-looks-like) for the worked example. **By design, not by accident.** |
| **It does not follow authority it cannot model** | Custom registries, Aragon ACLs, Maker's `wards`, governance whose delay lives off the executor — Ripcord detects that an indirection *exists* where it can, names the address, and stops. It never calls into what it finds and never guesses at the structure behind it. |
| **It does not monitor** | There is no watchtower, no alerting, no queue-watching. A report is a photograph of one block, not a subscription. |
| **It is frequently less useful than a good auditor** | 15 of 26 calibration protocols come back `undetermined`. That is the deliberate trade: an under-determination is visible and arguable in the report, while a false clean bill is invisible by construction. |

**The one thing it will not do, under any circumstance, is tell you a contract
is safe when it has not established that.** Every reassuring result in Ripcord is
a *positive* claim carrying the evidence that earned it — and two of them are
literally unconstructable without a completeness witness, enforced by zod and by
the type checker rather than by anyone remembering to check.

## Tech stack

| Technology | Role |
|---|---|
| **TypeScript / Node 22** | The entire codebase. One language on purpose — even the drainer contract used in the proof is hand-assembled EVM bytecode in TS rather than Solidity, so it stays auditable inline and there is no `solc` in the toolchain. |
| **[viem](https://viem.sh)** | Ethereum RPC, ABI encode/decode, keccak. Also the source of every derived constant: storage slots and selectors are *computed from their preimages in code*, never hand-copied, and asserted in tests against independent reference values. |
| **[zod](https://zod.dev)** | Runtime schema validation — and load-bearing, not decorative. The report's structural honesty invariants (discriminated unions, `z.literal(true)` witnesses) are enforced by zod. A report that fails its own schema is treated as a Ripcord bug, not a target problem. |
| **[Foundry](https://book.getfoundry.sh) (`anvil`, `cast`)** | Ephemeral mainnet-fork EVM for the proof engine, and `cast run --trace` for the human-readable call trace. The only non-npm dependency. |
| **[vitest](https://vitest.dev)** | 224 unit tests, all network-free, so CI needs no RPC key. |
| **[gitleaks](https://github.com/gitleaks/gitleaks)** | Secret scanning over the full history, in CI on every push. |
| **commander** | CLI argument parsing. |

## Partner technologies

- **Alchemy** — the mainnet RPC provider used for development and for the entire calibration run. Ripcord names the active provider by **host only** at the start of every scan (`Alchemy (eth-mainnet.g.alchemy.com)`), never the full URL, because that carries the key. Working against a real provider is also what produced two of the project's most important findings: the free tier's 9-block `eth_getLogs` cap is what forced role reconstruction to degrade into an explicitly *labelled* partial rather than a silent truncation, and reproducing real provider failures against it is what exposed a bug where an infrastructure error was being cached as a contract revert (see [Deployment](#deployment) and `docs/CALIBRATION.md` §10).
- **Chainlink** — price feeds are what turn the proof engine's output from "some tokens moved" into a dollar figure. `src/chain/priceFeeds.ts` maps the six curated major tokens to their aggregators; a feed that cannot be read at the pinned block yields `usd: null` **with the reason**, never a silent `$0` that would make a real drain look harmless.
- **Foundry** — `anvil` is the sandbox the proof engine executes in, and it is what makes "capability, not intent" enforceable rather than aspirational: impersonation works precisely *because* no signature and no key are involved, so the demonstration can never become a real transaction.

## How to run / test

**Prerequisites:** Node **22.13+** and pnpm (the exact version is pinned in `package.json`'s `packageManager` field, so `corepack` fetches it). `ripcord prove` additionally needs Foundry's `anvil` and `cast` on your `PATH`.

Everything below runs with **no network and no RPC key**:

```sh
git clone https://github.com/thomasdevving/ripcord.git
cd ripcord
pnpm install
pnpm typecheck      # tsc --noEmit
pnpm test           # 224 unit tests, network-free
pnpm verify:pages   # re-check every published page against its source report
pnpm verify:claims  # re-check this README's claims against those reports
```

The last two are worth understanding, because they are where the honesty claims stop being prose. `verify:pages` re-resolves every headline figure on every rendered page back to the exact JSON path it came from, then checks properties that would each be a credibility failure if violated — an undetermined verdict never wearing the healthy tone, an unproven delay never drawn as a settled window, a partial role reconstruction always showing its covered block range, and **no reassuring verdict sitting on an incomplete enumeration anywhere in its authority graph** (derived independently of the code that computes it, so a bug in the derivation cannot hide itself). `verify:claims` does the same for prose, because on day 6 the sentences in this README drifted from the reports and nothing caught it.

To scan a live contract, add an RPC URL:

```sh
cp .env.example .env      # set RPC_URL_1
pnpm ripcord scan 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 --block 25800000 --chain 1
```

### Reproduce the headline claims

Two commands, both pinned. Run them back to back — they are the pair that shows the tool **discriminates** rather than alarms, which is the first thing a sceptical reviewer will test.

```sh
# 1. The power is real, and the exit is SHUT. PAID Network token proxy.
pnpm ripcord scan 0x1614f18fc94f47967a3fbe5ffcd46d4e7da3d787 --block 25800000 --chain 1

# 2. Power far larger — and it is BOUND. Compound III, proof engine on a fork.
pnpm ripcord prove 0xc3d688B66703497DAA19211EEdff47f25384cdc3 --block 25800000 --chain 1
```

The first comes back `no_notice`: both authority routes terminate at plain EOAs with no delay anywhere, so there is no interval to move inside — and `paused()` reads **`true`** at that block, so the exit is not slow, **it is shut**. The second comes back `can_exit_in_time`, and the proof engine demonstrates the scale of the authority: **$540,604,938.71** moved on an ephemeral fork by impersonating the resolved controller and executing its own upgrade path — against a **proven-binding 2-day notice** and an instant exit. Run twice on two independent forks it produces the same total to the cent.

That pair is the point. Same tool, same engines, opposite verdicts: one protocol where the power is modest and you are trapped anyway, one where the power is enormous and you are fine.

To regenerate the whole published calibration set:

```sh
rm -rf .cache/                    # start cold
node scripts/run-calibration.mjs  # all 26 targets, pinned to block 25800000
node scripts/compare-reports.mjs calibration/reports <your-output-dir>
```

A cold run and a warm run must be **byte-identical** — `compare-reports.mjs` normalises `generatedAt`, the only intentionally non-deterministic field, and diffs everything else byte for byte. Expect a full cold run to take about an hour on a free-tier endpoint; the two deep-history AccessControl contracts each fire up to ~1500 `eth_getLogs` requests on a 9-block range, which exhausts a free tier's throughput. Ripcord fails **loud** there rather than producing a clean-looking report from a dead endpoint; the runner retries a failed target three times with a cooldown, and because the cache is never invalidated each retry resumes where the last stopped.

## Deployment

There is **no backend and no hosted scanner** — Ripcord is a local CLI, and the only thing deployed is a set of pre-generated static pages.

- **Report site:** `https://thomasdevving.github.io/ripcord/` — 22 rendered calibration pages, no JavaScript beyond native `<details>`, no network request at view time. Generated ahead of time from the pinned JSON reports by `scripts/render.ts`, so a page cannot show a result that differs from its committed report. Published by [`.github/workflows/pages.yml`](.github/workflows/pages.yml), which runs `verify:pages` and `verify:claims` first and deploys only if both pass.
- **Source:** `https://github.com/thomasdevving/ripcord`
- **Chain:** Ethereum mainnet (chain 1), everything pinned to **block 25800000**.
- **No contracts were deployed.** Ripcord deploys nothing on-chain and holds no address. The one piece of bytecode it produces — the minimal sweep implementation used in the proof — exists **only inside an ephemeral local fork** and is never sent to a network.
- **Calibration targets** (all mainnet, all read-only): the full set of 26 with their addresses is in [`calibration/run-manifest.json`](calibration/run-manifest.json); the two used above are PAID Network `0x1614f18fc94f47967a3fbe5ffcd46d4e7da3d787` and Compound III cUSDCv3 `0xc3d688B66703497DAA19211EEdff47f25384cdc3`.

## What we built during Common S3nse

**Everything in this repository.** The repo was created at event start; the first commit is dated **2026-08-31 11:39:09 +0200** (`git log --reverse | head`), day 1 of a 7-day solo build. `git log` is the incremental record.

- **Day 1 — Power Map.** Proxy detection, Ownable, AccessControl (Enumerable + event reconstruction), power-holder classification, the report schema, the CLI, 5 verified mainnet fixtures.
- **Day 2 — Capabilities.** Dispatcher-based selector extraction using reachability analysis; the versioned capability taxonomy; guard attribution **by probing real `eth_call`s** rather than static analysis; weakest-link uncertainty encoded in the schema; a one-level dependency graph over curated major tokens and oracle getters.
- **Day 3 — Depth and proof.** Recursive authority resolution with cycle detection (proven live on Aave's mutually-owning governance contracts) and timelock detection; the **proof engine** — one archetype, `CODE_CHANGE → drain` on a transparent proxy, impersonating the *resolved* controller, priced via Chainlink, emitting a `cast run` trace and a reproduce command.
- **Consolidation pass.** Provider preflight (the `eth_getLogs` range is *probed*, not assumed), adaptive chunking with labelled partial reconstruction, the versioned cleared-dependency registry, and a cross-layer sweep that found an authority-resolution `catch` turning a network outage into "no roles found".
- **Day 4 — the Exit Window.** Per-route modelling with the protocol figure as the minimum; binding-ness established by probe; `checksPerformed[]` so "none found" is distinguishable from "not checked"; time-to-exit as a lower bound with named gaps; the verdict as pure, exhaustively testable composition.
- **Day 5 — Calibration.** 26 mainnet protocols, all pinned, 0 errors — including four chosen *because* their authority lives somewhere Ripcord does not model, so a wrong answer would be false-clean rather than a visible false alarm. Found and fixed the one optimism-direction bug. Built the renderer and its verifier.
- **Day 6 — Self-audit.** The semantic cache audit; the enumeration-completeness witness; the prose-vs-reports claim checker; submission hardening.

**The bugs found by running against live mainnet, rather than by unit tests, are the part worth reading** — each is written up in KNOWN EDGES in `CLAUDE.md`:

- An authority-resolution `catch` that turned a network outage into "no roles found".
- An infrastructure failure cached as a contract *revert* — a false-clean reached through the cache rather than through a detector.
- A cache miss returning a different **type** than a cache hit, found by the mandated cold re-run.
- A status that conflated *"no route was found"* with *"no route exists"*, and read as "no exit-window risk identified" about two fully-controllable contracts.
- Enumeration completeness recorded correctly and then **read by nothing downstream**, so a partial role scan could not stop a reassuring verdict. Two live instances.
- Three ordinary provider failures — a bad API key, an unreachable host, a **block not found** — all being cached as "this function reverted", i.e. as an absence of authority. Since every read is pinned to a *historical* block, a non-archive endpoint fails exactly that way and would have produced a complete, schema-valid, confidently clean report in which every contract has no owner, no roles and no capabilities.
- The project's own README drifting from its own reports, caught only by running the documented command from a clean clone.
- A CI secret-scanner that walked **zero bytes** and reported "no leaks found".

## Pre-existing work

**None.** There is no pre-existing codebase, no ported prototype, and no code carried in from earlier work. No Solidity was written at all.

Third-party code I did not write, in full:

| Dependency | Role |
|---|---|
| `viem` | Ethereum RPC client, ABI encode/decode, keccak, address utilities. Runtime. |
| `zod` | Runtime schema validation. Runtime, and load-bearing for the honesty invariants. |
| `commander` | CLI argument parsing. Runtime. |
| `typescript`, `tsx`, `vitest`, `@types/node` | Type checking, TS execution, test runner, Node types. Dev-only. |
| Foundry `anvil` | Ephemeral mainnet-fork EVM for `ripcord prove`. External binary, subprocess. |
| Foundry `cast` | Renders the proof's call trace. External binary; optional — if absent the trace artefact is simply not written. |
| `gitleaks` | Secret scanning, CI and local. Dev/CI only. |

Everything else is original work written during the event: proxy detection, the dispatcher's reachability walk, the capability taxonomy, guard probing and the dialect dictionary, recursive authority resolution, the exit-window and time-to-exit models, verdict composition, the enumeration witness, the report schema, the hand-assembled drainer bytecode, the renderer, and the two verifiers.

## Team

**Thomas Nguyen** — solo build. Design, implementation, calibration, and write-up.

---

## Security

- `.env` and `.cache/` are gitignored from the first commit; `.env.example` ships placeholder values only.
- **gitleaks over the full history reports no leaks**, across every commit — not just the working tree. Verified with `gitleaks detect --source . --config .gitleaks.toml`, which is what makes "no secret was ever committed to this repository" a checkable statement rather than an assurance. The same scan runs with `fetch-depth: 0` in CI, so the property is enforced going forward.
- [gitleaks](https://github.com/gitleaks/gitleaks) runs in CI on every push (see [`.github/workflows/ci.yml`](.github/workflows/ci.yml)).
- Ripcord never signs anything, never holds a private key, and never requests an approval. The only secret it ever touches is an RPC URL — and it is never logged: every scan prints the provider by **host only** (`eth-mainnet.g.alchemy.com`), never the full URL that carries the key.

## License

MIT — see [LICENSE](LICENSE).
