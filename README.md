# Ripcord

Who holds privileged power over a DeFi contract, and how fast could they use it versus how fast you could leave.

## The question

An audit answers "is there a bug in this code." It does not answer "who holds the keys." With an upgradeable proxy, the code an auditor reviewed is not necessarily the code that runs tomorrow — the admin can swap the implementation without breaking a single rule the audit checked. No exploit required. The system works exactly as designed, and the user's funds are gone anyway.

Every DeFi hack of this shape is preventable *in advance* — the proxy pattern, the admin address, whether it's an EOA or a multisig, the threshold, whether a timelock sits in between: all of it is public, on-chain, and readable before you deposit. Nobody reads it, because nobody automates it.

Ripcord reads it. Day 1 builds the **Power Map**: a static scan of who holds privileged power over a contract, and what that power actually is. (The full system also includes a fork-simulation Proof Engine, the Exit Window metric — upgrade delay versus real time-to-exit — and live Watchtower monitoring. Those come later in the week; see [What's next](#whats-next).)

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

## What a report contains

- `target` — address, whether it has code, bytecode size and hash.
- `proxy` — pattern (`eip1967_transparent` / `eip1967_uups` / `eip1967_beacon` / `eip1167_minimal_proxy` / `legacy_zos_unstructured` / `not_a_proxy` / `unknown`), the implementation/admin/beacon addresses if applicable, the raw slot values, and evidence for every read.
- `authority` — `owner()`/`pendingOwner()` results, and AccessControl role membership (enumerated live via `AccessControlEnumerable` getters, or reconstructed by replaying `RoleGranted`/`RoleRevoked` events when that extension isn't present).
- `powerHolders` — every address that turned up holding some capability, classified as `eoa` / `safe` / `contract`, with the Safe's threshold and owners read directly if it is one, and a list of which capabilities route through it.
- `unknowns` — always present. Anything Ripcord could not determine, and why. **Never empty just because everything looked fine** — an upgradeable proxy with no identified authority produces an explicit unknowns entry precisely because "nothing found" must never read as "nothing to find."
- `errors` — always present. Any RPC read that actually failed (as opposed to a contract-level revert, which is a normal, evidence-carrying result, not an error).

Every finding, everywhere in the schema, carries an `evidence[]` array: the kind of read (`storage_slot` / `call` / `log` / `bytecode`), its exact parameters, the raw value the node returned, and the block it was read at. A finding without evidence is a rumour.

## Trust assumptions

- **You trust the RPC to tell the truth.** Ripcord does not run its own node or cross-check against a second provider. If the RPC lies about a storage slot or a call result, Ripcord reports the lie, with evidence, faithfully. Pin `--block` to a specific number and use an RPC provider you trust for the chain in question.
- **You trust Ripcord's pattern coverage.** Day 1 recognizes EIP-1967 (transparent/UUPS/beacon), EIP-1167 minimal proxies, and legacy zeppelinos unstructured storage. Anything else — a custom proxy, a diamond (EIP-2535), a non-standard access-control scheme — is either misclassified as `not_a_proxy` (if it has no delegatecall Ripcord's scanner can find) or explicitly flagged `unknown` (if it does). See Limitations below for exactly where this breaks down today, verified against real contracts, not hypothesized.
- **The cache is trusted once written.** Every RPC read is pinned to a historical block and cached to disk forever (a historical block's contents never change), which is what makes a warm-cache rerun byte-identical and network-free. If you believe an RPC provider fed Ripcord bad data, delete `.cache/` and rerun with a provider you trust — don't edit cache files by hand, since nothing checks them for tampering.

## Limitations

- **Day 1 stops at the immediate power holder.** If a proxy's admin is itself a contract (e.g. an OpenZeppelin `ProxyAdmin`), Ripcord classifies it as `type: "contract"` and stops — it does not (yet) recursively resolve *that* contract's own `owner()`. This is real and demonstrated in the fixtures: one PAID Network proxy's admin is a `ProxyAdmin` contract whose own owner turns out (verified manually, not by Ripcord today) to be a plain EOA. Dependency-graph traversal is explicitly day-2 scope.
- **The DELEGATECALL "unknown" heuristic is a linear byte scan, not control-flow analysis.** It correctly skips PUSH-immediate data and Solidity's trailing CBOR metadata blob, but it has no notion of reachability. A factory contract that deploys a proxy via `new SomeProxy(...)` embeds that proxy's full initcode — including its real `DELEGATECALL` — inside its own bytecode, and Ripcord's scanner cannot yet tell "code this contract would execute" from "code embedded as another contract's creation bytecode." This is demonstrated live in the fixtures: Aave's `PoolAddressesProvider`, which is not itself upgradeable, still comes back `pattern: "unknown"` for exactly this reason. It is reported as uncertain, not as a false "not a proxy" — which is the correct failure mode for this tool, but worth knowing about before you read too much into a lone `unknown`.
- **AccessControl role discovery depends on finding every role hash that was ever granted.** Non-enumerable contracts are reconstructed by replaying `RoleGranted`/`RoleRevoked` from the contract's deployment block (found by binary search over `getCode`, not an indexer). The event scan is chunked and capped at 500 chunks of 10,000 blocks (5,000,000 blocks); a contract with a longer, unscanned history produces an explicit `unknowns[]` entry rather than a silently incomplete role list.
- **No dependency-graph traversal.** Ripcord does not yet follow into tokens, oracles, or other contracts a target depends on. Day 2.
- **No capability/selector detection.** Ripcord does not yet check for `pause()`, `blacklist()`, `mint()`, or similar. Day 2.
- **No Exit Window metric, no fork simulation, no monitoring.** All out of day-1 scope by design — see [What's next](#whats-next).

## What's next

- **Day 2** — capability/selector detection (pause/blacklist/mint and similar), dependency-graph traversal into a target's tokens/oracles, and recursive resolution of `type: "contract"` power holders.
- **Day 3** — the Proof Engine: fork-simulate the admin's own upgrade path on a mainnet fork and produce the call trace where user funds actually leave.
- **Day 4** — the Exit Clock: the Exit Window metric itself — upgrade/admin-change delay (minus who can bypass or shorten it) versus real time-to-exit (unstaking periods, withdrawal cooldowns, queues, liquidity depth).
- **Day 5** — calibration against 10-15 real protocols, README/report polish.
- **Day 6 (optional)** — Watchtower: live monitoring of timelock queues, alerting when a rule change is actually queued.

## Development

```sh
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest — pure-logic unit tests (constants, bytecode pattern matching), no network required
pnpm ripcord scan <address> --block <n> --chain <id> [--no-cache] [--cache-dir <dir>]
```

`pnpm test` runs in CI without any RPC access — it covers derived constants (asserted against the EIP-1967 reference values) and bytecode pattern matching. End-to-end verification against the five pinned fixtures in [`test/fixtures/targets.json`](test/fixtures/targets.json) requires a real RPC URL and was run manually during day-1 development; every observed result is recorded in that file alongside each target.

## Security

- `.env` and `.cache/` are gitignored from the first commit; `.env.example` ships placeholder values only.
- [gitleaks](https://github.com/gitleaks/gitleaks) runs in CI on every push (see [`.github/workflows/ci.yml`](.github/workflows/ci.yml)).
- Ripcord never signs anything, never holds a private key, and never requests an approval. The only secret it ever touches is an RPC URL.

## What was built during this hackathon

Everything in this repository — first commit dated 2026-08-31, day 1 of a 7-day solo build. See `git log` for the incremental history: repo hygiene and CI first, then derived constants, the cached chain access layer, the report schema, each detector, orchestration, the CLI, and finally verified fixtures and two bugs (a Solidity-metadata false positive and a silent "clean-looking" unknown-authority case) found and fixed by actually running the tool against live mainnet data rather than only unit tests.
# ripcord
