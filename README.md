# Ripcord

Who holds privileged power over a DeFi contract, and how fast could they use it versus how fast you could leave.

## The question

An audit answers "is there a bug in this code." It does not answer "who holds the keys." With an upgradeable proxy, the code an auditor reviewed is not necessarily the code that runs tomorrow — the admin can swap the implementation without breaking a single rule the audit checked. No exploit required. The system works exactly as designed, and the user's funds are gone anyway.

Every DeFi hack of this shape is preventable *in advance* — the proxy pattern, the admin address, whether it's an EOA or a multisig, the threshold, whether a timelock sits in between: all of it is public, on-chain, and readable before you deposit. Nobody reads it, because nobody automates it.

Ripcord reads it. Day 1 built the **Power Map**: a static scan of who holds privileged power over a contract. Day 2 adds **capability detection** — which specific privileged functions exist (upgrade, mint, freeze, sweep, ...) and, where the evidence supports it, who can call them — and a one-level **dependency graph**: a protocol can be impeccably governed and you still aren't sovereign if the tokens it holds, or the oracle it trusts, can be frozen or repriced by someone else. (The full system also includes a fork-simulation Proof Engine, the Exit Window metric — upgrade delay versus real time-to-exit — and live Watchtower monitoring. Those come later in the week; see [What's next](#whats-next).)

## Quickstart

```sh
git clone <this-repo>
cd ripcord
pnpm install
cp .env.example .env   # then fill in RPC_URL_1 with a real mainnet RPC URL
pnpm ripcord scan 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 --block 25800000 --chain 1
```

That's WETH — the simplest possible case: no proxy, no owner, nothing to see. Real, unedited output (the bytecode blob in `proxy.evidence[0].rawValue` is truncated to `...` here purely for README readability; nothing else is touched):

```json
{
  "schemaVersion": "0.1.0",
  "rulesetVersion": "0.1.0",
  "generatedAt": "2026-08-31T09:54:06.959Z",
  "chainId": 1,
  "block": {
    "number": "25800000",
    "hash": "0xeb4ccbdb418b083ebbf646b371092c7c02016194e3a90caba9a9492becba8a2d"
  },
  "target": {
    "address": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    "hasCode": true,
    "bytecodeSize": 3124,
    "bytecodeHash": "0xd0a06b12ac47863b5c7be4185c2deaad1c61557033f56c7d4ea74429cbb25e23"
  },
  "proxy": {
    "pattern": "not_a_proxy",
    "isProxy": false,
    "implementation": null,
    "beacon": null,
    "admin": null,
    "slots": {
      "eip1967Implementation": "0x0000...0000",
      "eip1967Admin": "0x0000...0000",
      "eip1967Beacon": "0x0000...0000",
      "eip1822Proxiable": "0x0000...0000",
      "legacyZosImplementation": "0x0000...0000",
      "legacyZosAdmin": "0x0000...0000"
    },
    "evidence": [
      { "kind": "bytecode", "params": { "address": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" }, "rawValue": "0x6060...", "block": "25800000" },
      { "kind": "storage_slot", "params": { "address": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", "slot": "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" }, "rawValue": "0x0000...0000", "block": "25800000" }
    ]
  },
  "authority": {
    "owner": { "address": null, "source": "owner() reverted or returned no data — contract likely does not implement it", "evidence": [ { "kind": "call", "params": { "address": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", "data": "0x8da5cb5b" }, "block": "25800000" } ] },
    "pendingOwner": { "address": null, "source": "pendingOwner() reverted or returned no data — contract likely does not implement it", "evidence": [ { "kind": "call", "params": { "address": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", "data": "0xe30c3978" }, "block": "25800000" } ] },
    "accessControl": { "detected": false, "method": "not_applicable", "roles": [] }
  },
  "powerHolders": [],
  "unknowns": [],
  "errors": []
}
```

A more useful example — one of the pinned fixtures, a PAID Network token proxy (`0x8c8687fc965593dfb2f0b4eaefd55e9d8df348df`, the protocol behind the real March 2021 proxy-admin-key exploit):

```json
{
  "proxy": { "pattern": "eip1967_transparent", "implementation": "0xb828e66eb5b41b9ada9aa42420a6542cd095b9c7", "admin": "0x7bb7580edb70170daf8a24afc6aaef93db720c24" },
  "authority": { "owner": { "address": "0x53bc21D38281D6AcdFE0b92e0B534a19C90344cC", "source": "owner()" } },
  "powerHolders": [
    { "address": "0x53bc21D38281D6AcdFE0b92e0B534a19C90344cC", "type": "eoa" },
    { "address": "0x7bb7580edb70170daf8a24afc6aaef93db720c24", "type": "contract" }
  ]
}
```

The token's own owner is a plain EOA — no multisig, anywhere. Full command:

```sh
pnpm ripcord scan 0x8c8687fc965593dfb2f0b4eaefd55e9d8df348df --block 25800000 --chain 1
```

And the honest-uncertainty case — Wasabi Protocol's PerpManager (`0xc0b01a4f4a4459d5a7e13c2e8566cde93a010e7d`), the exact protocol whose April 2026 admin-key incident motivated this project:

```json
{
  "proxy": { "pattern": "eip1967_uups", "implementation": "0xa8516ff9d132ed3a3c352fe04f05fe117bae97ce" },
  "authority": { "owner": null, "accessControl": { "detected": false } },
  "powerHolders": [],
  "unknowns": [
    {
      "field": "authority",
      "reason": "target is a confirmed upgradeable proxy, but no upgrade authority could be identified via owner()/AccessControl — it likely uses a non-standard or custom access-control scheme; the proxy IS upgradeable by someone, manual review required"
    }
  ]
}
```

Ripcord correctly identifies the proxy pattern but does **not** implement Wasabi's custom access-control scheme, and says so explicitly — `powerHolders: []` here is not a claim that nobody can upgrade this contract. It's a claim that Ripcord couldn't find who can with the detectors it has today.

Day 2 adds capability detection and a dependency graph. Same PAID Network proxy as above — its implementation exposes `renounceOwnership()`/`transferOwnership(address)`, and Ripcord didn't just find them, it *asked the contract who guards them*: a real `eth_call`, zero-valued args, from an address with no relationship to the protocol, and the revert reason it got back — `"Ownable: caller is not the owner"` — is what attributes the guard to the token's owner, not a source-code assumption.

Note the two different addresses. Selectors are read from the **implementation's** bytecode (`scannedAddress`), because that's where the code lives — but the probe is sent to the **proxy** (`probedAddress`), because a delegatecall through the proxy runs that code against the *proxy's* storage, which is where the owner actually is. Probing the implementation directly would read its own uninitialized storage (its `owner()` is `address(0)`) and any revert it produced would say nothing about who controls the proxy:

```json
{
  "capabilities": {
    "taxonomyVersion": "0.1.0",
    "dispatcherRecognized": true,
    "scannedAddress": "0xb828e66eb5b41b9ada9aa42420a6542cd095b9c7",
    "probedAddress": "0x8c8687fc965593dfb2f0b4eaefd55e9d8df348df",
    "findings": [
      {
        "signature": "transferOwnership(address)",
        "category": "AUTHORITY_CHANGE",
        "matchConfidence": "high",
        "guard": {
          "status": "attributed",
          "holders": ["0x53bc21D38281D6AcdFE0b92e0B534a19C90344cC"],
          "authSource": "owner",
          "evidence": [
            { "kind": "call", "params": { "address": "0x8c8687fc965593dfb2f0b4eaefd55e9d8df348df", "data": "0xf2fde38b...", "from": "0x30bf246519796e6e83153ff35f6ff46ef9fb14bf" },
              "rawValue": "0x08c379a0...4f776e61626c653a2063616c6c6572206973206e6f7420746865206f776e6572" }
          ]
        }
      }
    ],
    "needsManualVerification": [
      {
        "signature": "unpause()",
        "category": "ACCESS_RESTRICTION",
        "reason": "no_auth_revert_observed",
        "note": "probed from three unrelated addresses with zero-valued arguments and observed no AccessControl/Ownable-shaped auth revert from any of them — this does not prove the function is unguarded..."
      }
    ]
  }
}
```

`unpause()` reverted on every probe too — but with `"Pausable: not paused"`, an unrelated state check, not an auth check. Ripcord can't distinguish "no guard" from "guarded, but this particular probe didn't reach the guard check" by probing alone, so it never claims either — `unpause()` lands in `needsManualVerification`, not in `findings`, and not as a vulnerability claim. See [Disclosure policy](#disclosure-policy) for why that distinction matters.

The dependency graph runs the same detection one level deeper. This same PAID proxy holds real USDC and USDT balances; here's WETH9 — the "nothing to see here" contract from the first example — showing what it actually holds:

```json
{
  "dependencies": {
    "tokens": [
      {
        "token": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        "balance": "6169188602",
        "capabilities": {
          "findings": [{ "signature": "transferOwnership(address)", "category": "AUTHORITY_CHANGE" }],
          "needsManualVerification": [
            { "signature": "blacklist(address)", "category": "ACCESS_RESTRICTION" },
            { "signature": "pause()", "category": "ACCESS_RESTRICTION" },
            { "signature": "mint(address,uint256)", "category": "SUPPLY" }
          ]
        }
      }
    ]
  }
}
```

WETH9 holds ~6,169 USDC directly on the contract address — and that USDC has real freeze (`blacklist`) and mint capability. Ripcord's own guard-probing couldn't attribute those particular guards on this run (see [Trust assumptions](#trust-assumptions) — revert-data availability is RPC-provider-dependent), but the capabilities themselves are real, evidence-backed findings: this is the "80% of this vault's holdings sit in a freezable token" headline the dependency graph exists to produce, even in a case as boring as WETH9.

## What a report contains

- `target` — address, whether it has code, bytecode size and hash.
- `proxy` — pattern (`eip1967_transparent` / `eip1967_uups` / `eip1967_beacon` / `eip1167_minimal_proxy` / `legacy_zos_unstructured` / `not_a_proxy` / `unknown`), the implementation/admin/beacon addresses if applicable, the raw slot values, and evidence for every read.
- `authority` — `owner()`/`pendingOwner()` results, and AccessControl role membership (enumerated live via `AccessControlEnumerable` getters, or reconstructed by replaying `RoleGranted`/`RoleRevoked` events when that extension isn't present).
- `powerHolders` — every address that turned up holding some capability, classified as `eoa` / `safe` / `contract`, with the Safe's threshold and owners read directly if it is one, and a list of which capabilities route through it.
- `capabilities` — every privileged function Ripcord's dispatcher-based selector extraction found (`scannedAddress` — the *implementation*, for a proxy) that matches the versioned taxonomy (`CODE_CHANGE` / `FUND_MOVEMENT` / `SUPPLY` / `ACCESS_RESTRICTION` / `ECONOMIC` / `AUTHORITY_CHANGE`), grouped by the power it grants, not by name. `findings[]` carries a `guard` — `attributed` (a real probe found an OZ Ownable/AccessControl-shaped revert and mapped it to a known holder), `guarded_unknown_holder` (auth-shaped revert, holder unmapped), or `inconclusive` (nothing interpretable) — never omitted, never a false attribution. Probes are always sent to `probedAddress` (the target/proxy), never to the implementation, so the storage the revert reflects is the storage the named holder actually sits in. A capability where probing observed no auth-shaped revert from any of three unrelated probe addresses is never a normal finding: it moves to `needsManualVerification[]`, which can say "no guard was detected" but never "this is unguarded" — see [Disclosure policy](#disclosure-policy).
- `dependencies` — one level deep. `tokens[]`: major ERC20s (a curated list, not full discovery — see Limitations) the target holds a nonzero balance of, each re-scanned for its own proxy/authority/capabilities. `oracles[]`: addresses returned by a short list of common oracle-getter probes, with authority detection run on each.
- `unknowns` — always present. Anything Ripcord could not determine, and why. **Never empty just because everything looked fine** — an upgradeable proxy with no identified authority produces an explicit unknowns entry precisely because "nothing found" must never read as "nothing to find."
- `errors` — always present. Any RPC read that actually failed (as opposed to a contract-level revert, which is a normal, evidence-carrying result, not an error).

Every finding, everywhere in the schema, carries an `evidence[]` array: the kind of read (`storage_slot` / `call` / `log` / `bytecode`), its exact parameters, the raw value the node returned, and the block it was read at. A finding without evidence is a rumour.

## Trust assumptions

- **You trust the RPC to tell the truth.** Ripcord does not run its own node or cross-check against a second provider. If the RPC lies about a storage slot or a call result, Ripcord reports the lie, with evidence, faithfully. Pin `--block` to a specific number and use an RPC provider you trust for the chain in question.
- **You trust Ripcord's pattern coverage.** Day 1 recognizes EIP-1967 (transparent/UUPS/beacon), EIP-1167 minimal proxies, and legacy zeppelinos unstructured storage. Anything else — a custom proxy, a diamond (EIP-2535), a non-standard access-control scheme — is either misclassified as `not_a_proxy` (if it has no delegatecall Ripcord's scanner can find) or explicitly flagged `unknown` (if it does). See Limitations below for exactly where this breaks down today, verified against real contracts, not hypothesized.
- **Guard probing depends on the RPC returning revert data.** Ripcord attributes a capability's guard by making a real `eth_call` and parsing the raw revert bytes; whether a provider returns those bytes on a reverted call is provider-dependent. Observed live during day-2 development: probing USDT against a public mainnet RPC returned no revert data on any of three probes, so its `pause()`/`unpause()`/`transferOwnership(address)` guards all came back `inconclusive` on that run — not because USDT lacks guards, but because that specific provider didn't hand back the bytes needed to see them. A different provider can produce a different (more attributed) result for the identical, deterministic on-chain state.
- **The cache is trusted once written.** Every RPC read is pinned to a historical block and cached to disk forever (a historical block's contents never change), which is what makes a warm-cache rerun byte-identical and network-free. If you believe an RPC provider fed Ripcord bad data, delete `.cache/` and rerun with a provider you trust — don't edit cache files by hand, since nothing checks them for tampering.

## Disclosure policy

Ripcord's findings split into two branches with different disclosure rules.

**Admin capability findings are published freely** — everything in `powerHolders`, `capabilities.findings`, and the dependency graph. Executing any of these paths requires the admin key (or an attributed role) itself, so publishing the finding grants no capability to anyone who doesn't already hold it. It only ever demonstrates something on a fork with impersonation of a key nobody but the admin holds. The admin already knows their own key exists and what it can do. And there is no patch to withhold time for: an admin's ability to call a function it holds the key to is inherent design, not a vulnerability. Day 5's calibration run against 10-15 live protocols publishes this class of finding without restriction.

**Actual vulnerabilities are not published, and are not what `needsManualVerification` claims to have found.** An unprotected initializer, a genuinely unguarded privileged function reachable by *any* caller, or anything else where a non-privileged party could seize control, is a different category entirely — and Ripcord's probing methodology is deliberately incapable of asserting it exists. `needsManualVerification` entries are an honest "no guard was detected by probing," not "no guard exists": a custom access-control scheme, a revert triggered by an unrelated state check before the auth check runs, or an RPC provider that silently drops revert data can all produce the exact same observation as a genuinely missing guard (see KNOWN EDGES in `CLAUDE.md`).

Because that distinction is easy to lose under time pressure, it is enforced as a rule rather than a judgement call, and the rule is checked by the tool rather than by whoever is running it:

> **Ripcord does not publish a report whose `needsManualVerification` is non-empty** — at the target or anywhere in its dependency graph. Such a report stays local until the entry is either cleared by a human as a design property, or disclosed to the project. The published calibration set consists exclusively of reports where that field is empty.

Every report carries a `disclosure` block computed from exactly that rule (`publishable`, `reason`, and `blockedBy` naming each entry), and the CLI prints a loud `DO NOT PUBLISH THIS REPORT` warning to stderr when it trips. Day 5's calibration set is filtered on `disclosure.publishable`, so nothing gets published because someone eyeballed it and thought it looked fine.

Where an entry does turn out to be a real, exploitable vulnerability rather than a design property: do not publish it, do not commit it to this repository's fixtures or examples, make one contact attempt through the project's published security channel (or a platform such as Immunefi if they run one), document that the attempt was made, and leave it there. Standard responsible disclosure, and the documented attempt is what makes it verifiable that we followed it.

## Limitations

- **Day 1 stops at the immediate power holder.** If a proxy's admin is itself a contract (e.g. an OpenZeppelin `ProxyAdmin`), Ripcord classifies it as `type: "contract"` and stops — it does not (yet) recursively resolve *that* contract's own `owner()`. This is real and demonstrated in the fixtures: one PAID Network proxy's admin is a `ProxyAdmin` contract whose own owner turns out (verified manually, not by Ripcord today) to be a plain EOA. Dependency-graph traversal is explicitly day-2 scope.
- **The DELEGATECALL "unknown" proxy-pattern heuristic is a linear byte scan, not control-flow analysis** (day 1). It correctly skips PUSH-immediate data and Solidity's trailing CBOR metadata blob, but it has no notion of reachability. A factory contract that deploys a proxy via `new SomeProxy(...)` embeds that proxy's full initcode — including its real `DELEGATECALL` — inside its own bytecode, and this scanner cannot tell "code this contract would execute" from "code embedded as another contract's creation bytecode." Demonstrated live: Aave's `PoolAddressesProvider`, not itself upgradeable, comes back `pattern: "unknown"` for exactly this reason. Reported as uncertain, not as a false "not a proxy" — the correct failure mode, but worth knowing about before reading too much into a lone `unknown`. (Day 2's dispatcher-based selector extraction, below, does not have this problem — it uses reachability analysis specifically to avoid it — but this older proxy-pattern heuristic is unrelated code and still has it.)
- **Capability selector extraction uses reachability analysis, not a linear scan** (day 2), specifically to avoid the problem above: a minimal static walk follows only real JUMP/JUMPI targets from offset 0, so a CODECOPY'd child contract's embedded creation bytecode is structurally unreachable rather than misread as the parent's own dispatch branches. Verified against the same Aave fixture: the child proxy's admin selectors do not appear. Still: if bytecode doesn't match a recognized Solidity dispatcher shape at all (Vyper, hand-written assembly, an unusual compiler), extraction returns `recognized: false` rather than guessing.
- **Ripcord does not report whether a contract has a fallback or `receive()` function.** An early heuristic for this was removed rather than shipped: it returned "has a fallback" for every real contract tested, including ones that have none — a flag with no evidence behind it. Proving a fallback body exists, as opposed to the compiler's default revert stub, needs the control-flow analysis that is deliberately out of scope. Selector extraction walks past these guards correctly; it just doesn't report on them.
- **Capability taxonomy matching only recognizes selectors on its own curated table.** A selector not in `src/detect/taxonomy.ts` is unclassified, not "no privileged capability" — Ripcord does not do reverse-lookup against an external 4byte-style selector database (that would be a live, non-deterministic dependency, inconsistent with pinned-block reproducibility). The report is explicit about the size of this gap rather than hiding it: `selectorsExtracted` always equals `findings + needsManualVerification + unmatchedSelectors`, and the unmatched ones are listed. Scanning USDC today extracts 55 selectors and classifies 7 of them — the other 48 are named in `unmatchedSelectors` so you can see exactly what the taxonomy didn't cover.
- **Guard attribution is by probing, not proof.** Ripcord calls each detected capability's selector with zero-valued arguments from three deterministic, protocol-unrelated addresses and parses the revert for a recognized OpenZeppelin Ownable/AccessControl shape. A recognized auth-shaped revert is real, strong evidence. The absence of one is not proof of absence: the call may revert for an unrelated reason before ever reaching an auth check (observed live: PAID Network's `unpause()` reverts with `"Pausable: not paused"`, telling us nothing about its guard), the contract may use a custom scheme Ripcord doesn't recognize (observed live: USDC's `"FiatToken: caller is not a minter"`), or the RPC provider may not return revert data at all (observed live: USDT against a public RPC). All three produce the same `needsManualVerification` outcome — genuinely different situations that probing alone cannot distinguish. See [Disclosure policy](#disclosure-policy).
- **AccessControl role discovery depends on finding every role hash that was ever granted.** Non-enumerable contracts are reconstructed by replaying `RoleGranted`/`RoleRevoked` from the contract's deployment block (found by binary search over `getCode`, not an indexer). The event scan is chunked and capped at 500 chunks of 10,000 blocks (5,000,000 blocks); a contract with a longer, unscanned history produces an explicit `unknowns[]` entry rather than a silently incomplete role list.
- **Day 1 stops at the immediate power holder, and day 2's dependency graph doesn't change that.** If a proxy's admin is itself a contract (e.g. an OpenZeppelin `ProxyAdmin`), Ripcord classifies it as `type: "contract"` and stops — it does not recursively resolve *that* contract's own `owner()`. Demonstrated in the fixtures: one PAID Network proxy's admin is a `ProxyAdmin` contract whose own owner turns out (verified manually, not by Ripcord) to be a plain EOA.
- **The dependency graph's token list is curated, not discovered.** `src/chain/majorTokens.ts` checks balances against 6 hand-verified mainnet tokens (USDC/USDT/DAI/WETH/WBTC/stETH). A target holding a large position in any other token produces no dependency finding for it — Ripcord does not run an indexer or a balance-discovery service, by design.
- **Oracle dependency detection only tries three getter names** (`oracle()`, `priceOracle()`, `priceFeed()`) directly against the target. A protocol exposing its oracle under a different name, or only reachable through an intermediate contract, produces no oracle finding.
- **Dependency-graph depth is exactly one level, on purpose.** A token a target holds is scanned for its own authority/capabilities; that token's *own* dependencies (if it wraps or is backed by something else) are not followed. Deliberate, not an oversight — see the day-2 brief.
- **No Exit Window metric, no fork simulation, no monitoring.** All out of day-1/day-2 scope by design — see [What's next](#whats-next).

## What's next

- **Day 3** — the Proof Engine: fork-simulate the admin's own upgrade path on a mainnet fork and produce the call trace where user funds actually leave.
- **Day 4** — the Exit Clock: the Exit Window metric itself — upgrade/admin-change delay (minus who can bypass or shorten it) versus real time-to-exit (unstaking periods, withdrawal cooldowns, queues, liquidity depth).
- **Day 5** — calibration against 10-15 real protocols, README/report polish.
- **Day 6 (optional)** — Watchtower: live monitoring of timelock queues, alerting when a rule change is actually queued.

## Development

```sh
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest — pure-logic unit tests, no network required
pnpm ripcord scan <address> --block <n> --chain <id> [--no-cache] [--cache-dir <dir>]
```

`pnpm test` runs in CI without any RPC access. It covers derived constants (asserted against the EIP-1967 reference values), bytecode pattern matching, the dispatcher's reachability-limited selector extraction (hand-built bytecode fixtures for every dispatch shape, plus real mainnet bytecode saved under `test/fixtures/bytecode/` for WETH9/USDC/WBTC/Aave's `PoolAddressesProvider`, each checked against an independently-sourced full ABI), guard-probe revert parsing (real captured mainnet revert bytes plus viem-encoded synthetic OZ v5 custom errors), and capability/proxy-resolution wiring — all against network-free fakes. End-to-end verification against the five pinned fixtures in [`test/fixtures/targets.json`](test/fixtures/targets.json) requires a real RPC URL and was run manually during development; every observed result is recorded in that file alongside each target.

## Security

- `.env` and `.cache/` are gitignored from the first commit; `.env.example` ships placeholder values only.
- [gitleaks](https://github.com/gitleaks/gitleaks) runs in CI on every push (see [`.github/workflows/ci.yml`](.github/workflows/ci.yml)).
- Ripcord never signs anything, never holds a private key, and never requests an approval. The only secret it ever touches is an RPC URL.

## What was built during this hackathon

Everything in this repository — first commit dated 2026-08-31, day 1 of a 7-day solo build. See `git log` for the incremental history: repo hygiene and CI first, then derived constants, the cached chain access layer, the report schema, each detector, orchestration, the CLI, and finally verified fixtures and two bugs (a Solidity-metadata false positive and a silent "clean-looking" unknown-authority case) found and fixed by actually running the tool against live mainnet data rather than only unit tests.
# ripcord
