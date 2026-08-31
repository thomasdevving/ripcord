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

## Following the authority chain

An audit tells you a proxy's admin is a `ProxyAdmin` contract. That is not the answer to "who holds the keys" — it is one hop short of it. Ripcord's recursion follows the chain until it terminates. On a real PAID Network token proxy:

```sh
pnpm ripcord scan 0x1614f18fc94f47967a3fbe5ffcd46d4e7da3d787 --block 25800000
```

```
authorityResolution.paths:
  [owner]      owner:0x5f1bD0Feb0…(safe) @d1                                    → 3-of-11 Gnosis Safe   (confidence high)
  [proxyAdmin] proxyAdmin:0x8f7e89f9…(contract) @d1 → owner:0x3CC21A33…(eoa) @d2 → a single EOA         (confidence medium)
```

This is the whole thesis in two lines. The token's *business-logic* owner is a well-configured 3-of-11 multisig. But the far more powerful **upgrade** authority — the one that can swap the code out from under everyone — resolves one hop further to a lone EOA with no multisig and no timelock. The more dangerous capability is the *less* protected one, and you cannot see that without walking past the `ProxyAdmin`.

## Proving it: the fork simulation

`ripcord prove` turns the static "this authority can upgrade the proxy" claim into an executed demonstration on a mainnet fork — impersonating the **resolved** controller (the EOA at the end of the path above, not the proxy's nominal owner), running the admin's own legitimate upgrade to a minimal implementation, and measuring the target's holdings leaving.

```sh
pnpm ripcord prove 0x8c8687fc965593dfb2f0b4eaefd55e9d8df348df --block 25800000
```

```
✓ PROOF PRODUCED (sandbox fork — no mainnet tx sent)
   In simulation on a fork at block 25800000, the resolved upgrade authority
   0x18738290…65be CAN move $748.90 of the tokens this contract holds, in one upgrade path.
   impersonated: proxyAdmin:0x7bb7580e… → owner:0x18738290…65be (depth 2, confidence medium)
   - USDC: moved 200000000 ($199.98) via Chainlink USDC/USD
   - USDT: moved 549123214 ($548.92) via Chainlink USDT/USD
   reproduce: pnpm ripcord prove 0x8c8687fc965593dfb2f0b4eaefd55e9d8df348df --block 25800000 --chain 1
```

The human-readable call trace is written to `.ripcord/proofs/<target>-<block>/trace.txt` (captured via `cast run`), the exact tree of `ProxyAdmin.upgrade → delegatecall drainer → USDC.transfer / USDT.transfer` with the `Transfer` events. The **reproduce command** is the whole thing, deterministic against the pinned block — a judge runs that one line to replay it.

Non-negotiable honesty rules, because auditors will (and should) probe them:

- **Sandbox only.** Everything runs on an ephemeral local anvil fork. No mainnet transaction is ever sent, no private key is used or held, no approval is requested.
- **Capability, not intent.** Every string says what the authority *can* do — never "will," "malicious," or "rug." The impersonated address is a legitimate admin exercising a legitimate power; the point is that the power exists and is under-protected.
- **A missing proof is honest; a fabricated one is disqualifying.** If the archetype doesn't apply — a non-transparent proxy, an authority that didn't resolve to an impersonable account, or a target holding none of the priced tokens — `prove` returns `produced: false` with a stated reason and falls back to the static finding. It never invents a trace. (Verified: Wasabi's UUPS proxy, WETH9, and the empty-holdings PAID v2 all return an explicit not-produced reason, no crash.)

The dollar figure is a **floor**, not a ceiling: it counts only the curated major-token holdings the [dependency graph](#what-a-report-contains) knows to look for, priced from Chainlink — value in unlisted tokens, LP positions, or staked principal is invisible to it. See [Limitations](#limitations).

## What a report contains

- `target` — address, whether it has code, bytecode size and hash.
- `proxy` — pattern (`eip1967_transparent` / `eip1967_uups` / `eip1967_beacon` / `eip1167_minimal_proxy` / `legacy_zos_unstructured` / `not_a_proxy` / `unknown`), the implementation/admin/beacon addresses if applicable, the raw slot values, and evidence for every read.
- `authority` — `owner()`/`pendingOwner()` results, and AccessControl role membership (enumerated live via `AccessControlEnumerable` getters, or reconstructed by replaying `RoleGranted`/`RoleRevoked` events when that extension isn't present). When roles come from an event scan, `authority.accessControl.reconstruction` states how complete that scan was: `complete` (true/false), a `confidence` on the shared high/medium/low certainty scale, the provider's probed `maxLogRange`, and the exact `scannedFromBlock`/`scannedToBlock` — so a partial reconstruction on a range-limited provider is visible, not silent.
- `powerHolders` — every address that turned up holding some capability, classified as `eoa` / `safe` / `contract`, with the Safe's threshold and owners read directly if it is one, and a list of which capabilities route through it.
- `capabilities` — every privileged function Ripcord's dispatcher-based selector extraction found (`scannedAddress` — the *implementation*, for a proxy) that matches the versioned taxonomy (`CODE_CHANGE` / `FUND_MOVEMENT` / `SUPPLY` / `ACCESS_RESTRICTION` / `ECONOMIC` / `AUTHORITY_CHANGE`), grouped by the power it grants, not by name. `findings[]` carries a `guard` — `attributed` (a real probe found an OZ Ownable/AccessControl-shaped revert and mapped it to a known holder), `guarded_unknown_holder` (auth-shaped revert, holder unmapped), or `inconclusive` (nothing interpretable) — never omitted, never a false attribution. Probes are always sent to `probedAddress` (the target/proxy), never to the implementation, so the storage the revert reflects is the storage the named holder actually sits in. A capability where probing observed no auth-shaped revert from any of three unrelated probe addresses is never a normal finding: it moves to `needsManualVerification[]`, which can say "no guard was detected" but never "this is unguarded" — see [Disclosure policy](#disclosure-policy).
- `authorityResolution` — the day-3 recursion. Each direct power holder that is a contract is followed into *its* own authority until it terminates, producing a `roots[]` tree and a flattened `paths[]` projection you can read as a chain: `proxyAdmin → ProxyAdmin contract → EOA 0x…`. Every path carries its `effectiveController` (the address the proof engine would impersonate), a per-hop `depth`, and a `confidence` that degrades with depth (`high` at depth 1, `medium` at 2, `low` at 3) — an effective controller three hops away is never asserted with a direct owner's certainty. Every leaf states an explicit `terminationReason` (`eoa`/`safe`/`timelock`/`max_depth`/`cycle`/`no_authority_found`); a contract that resolves to a timelock records the delay (`getMinDelay()`/`delay()`), and cycles (A owns B owns A — seen live on Aave governance) are recorded in `cyclesDetected`, never looped on.
- `proof` — null unless you ran `ripcord prove`. When present it is the fork-simulation result: `produced: true` with a dollar-denominated `deltas[]`/`totalUsd` when funds actually moved, or `produced: false` with a `failureReason` when the archetype didn't apply — never a fabricated result. See [Proving it](#proving-it-the-fork-simulation).
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

### Cleared dependency registry

Taken literally, the gate above blocks essentially every protocol on earth — because almost all of them hold USDC, and USDC's blacklist/pause/mint are exactly the powerful, probe-resistant capabilities the gate is built to catch. But those are not latent vulnerabilities: they are the loudly-documented, audited design of a centrally-issued stablecoin. Circle *can* freeze a USDC balance; that is the defining, publicly-known property of the asset, not something Ripcord discovered.

So Ripcord keeps a small, **versioned** cleared registry ([`src/chain/clearedRegistry.ts`](src/chain/clearedRegistry.ts)) recording, per `(token, capability)`, that a capability is documented design — with a one-line justification and a source. A cleared capability **on that specific token** is recorded in `disclosure.cleared` (with the registry version the report used) and does not force `publishable: false`. Everything else still blocks: the same signature on a *different* token, an *undocumented* signature on a cleared token, and — always — the **target's own** capabilities, which the registry never clears. The clearing is auditable and reversible, never a silent allowlist: `disclosure.cleared` names exactly what was waved through, on which token, and why. It doubles as a standalone artefact — a curated statement of who can freeze or mint the major assets.

## Limitations

- **Recursion resolves owner-of-owner, but only to depth 3 and only through standard authority.** Day 3 follows a contract power holder into its own `owner()`/AccessControl/`proxyAdmin` (this is what surfaces PAID's `ProxyAdmin → EOA` chain), but it stops at max depth 3 (a longer legitimate chain terminates as `max_depth`, explicit, never silently truncated) and it can only follow *standard* authority — a contract controlled through a custom scheme with no `owner()`/AccessControl/`proxyAdmin` terminates as `no_authority_found` at whatever depth it's reached, honestly short of the true controller (the same class as Wasabi's unrecognised access control). Cycles are detected and recorded rather than looped on.
- **The DELEGATECALL "unknown" proxy-pattern heuristic is a linear byte scan, not control-flow analysis** (day 1). It correctly skips PUSH-immediate data and Solidity's trailing CBOR metadata blob, but it has no notion of reachability. A factory contract that deploys a proxy via `new SomeProxy(...)` embeds that proxy's full initcode — including its real `DELEGATECALL` — inside its own bytecode, and this scanner cannot tell "code this contract would execute" from "code embedded as another contract's creation bytecode." Demonstrated live: Aave's `PoolAddressesProvider`, not itself upgradeable, comes back `pattern: "unknown"` for exactly this reason. Reported as uncertain, not as a false "not a proxy" — the correct failure mode, but worth knowing about before reading too much into a lone `unknown`. (Day 2's dispatcher-based selector extraction, below, does not have this problem — it uses reachability analysis specifically to avoid it — but this older proxy-pattern heuristic is unrelated code and still has it.)
- **Capability selector extraction uses reachability analysis, not a linear scan** (day 2), specifically to avoid the problem above: a minimal static walk follows only real JUMP/JUMPI targets from offset 0, so a CODECOPY'd child contract's embedded creation bytecode is structurally unreachable rather than misread as the parent's own dispatch branches. Verified against the same Aave fixture: the child proxy's admin selectors do not appear. Still: if bytecode doesn't match a recognized Solidity dispatcher shape at all (Vyper, hand-written assembly, an unusual compiler), extraction returns `recognized: false` rather than guessing.
- **Ripcord does not report whether a contract has a fallback or `receive()` function.** An early heuristic for this was removed rather than shipped: it returned "has a fallback" for every real contract tested, including ones that have none — a flag with no evidence behind it. Proving a fallback body exists, as opposed to the compiler's default revert stub, needs the control-flow analysis that is deliberately out of scope. Selector extraction walks past these guards correctly; it just doesn't report on them.
- **Capability taxonomy matching only recognizes selectors on its own curated table.** A selector not in `src/detect/taxonomy.ts` is unclassified, not "no privileged capability" — Ripcord does not do reverse-lookup against an external 4byte-style selector database (that would be a live, non-deterministic dependency, inconsistent with pinned-block reproducibility). The report is explicit about the size of this gap rather than hiding it: `selectorsExtracted` always equals `findings + needsManualVerification + unmatchedSelectors`, and the unmatched ones are listed. Scanning USDC today extracts 55 selectors and classifies 7 of them — the other 48 are named in `unmatchedSelectors` so you can see exactly what the taxonomy didn't cover.
- **Guard attribution is by probing, not proof.** Ripcord calls each detected capability's selector with zero-valued arguments from three deterministic, protocol-unrelated addresses and parses the revert for a recognized OpenZeppelin Ownable/AccessControl shape. A recognized auth-shaped revert is real, strong evidence. The absence of one is not proof of absence: the call may revert for an unrelated reason before ever reaching an auth check (observed live: PAID Network's `unpause()` reverts with `"Pausable: not paused"`, telling us nothing about its guard), the contract may use a custom scheme Ripcord doesn't recognize (observed live: USDC's `"FiatToken: caller is not a minter"`), or the RPC provider may not return revert data at all (observed live: USDT against a public RPC). All three produce the same `needsManualVerification` outcome — genuinely different situations that probing alone cannot distinguish. See [Disclosure policy](#disclosure-policy).
- **AccessControl role discovery depends on the provider's `eth_getLogs` range, and degrades to a *labelled partial* on a small one.** Non-enumerable role membership is reconstructed by replaying `RoleGranted`/`RoleRevoked` from the contract's deployment block (found by binary search over `getCode`, not an indexer). Ripcord probes the provider's real getLogs block-range at startup and chunks to it; if covering the full history would exceed a request budget, it scans the most recent affordable window and marks `authority.accessControl.reconstruction.complete = false` with a lowered `confidence` and the exact block window it *did* cover — never a silent truncation, never a false "no roles." A generous (Alchemy/Infura-class) provider returns `complete: true` / `high`; a capped public endpoint (e.g. blastapi, ~9-block range) returns an honest medium/low partial. Enumerable membership is authoritative regardless of scan completeness. This is verified live on the FXS fixture — see [`test/fixtures/targets.json`](test/fixtures/targets.json). Separately, this only recovers roles that were *granted* via an event; a role wired only through a constructor default with no emission is invisible.
- **The proof engine covers exactly one archetype.** `ripcord prove` simulates only `CODE_CHANGE → drain` on an EIP-1967 **transparent** proxy via `ProxyAdmin.upgrade(address,address)` — the path validated live end-to-end. UUPS (`upgradeToAndCall` on the proxy), beacon, and legacy-zos upgrade paths return `produced: false` with a stated reason rather than a guessed simulation. Deliberate depth-over-breadth, not an oversight. Two further caveats on the ones it does run: the drained dollar figure counts only the curated major-token holdings (a **floor**, see above), and because anvil impersonation ignores signatures, a proof whose resolved controller is a **Safe** impersonates the Safe address directly — demonstrating "this Safe *can*, if its signers collude," not "one key can." The PAID demo impersonates a plain EOA, so that caveat doesn't apply there.
- **Timelock detection reads the delay but does not yet resolve who can shorten it.** Day 3 classifies OZ `TimelockController` (`getMinDelay()`) and Compound/Bravo (`delay()`+`admin()`) timelocks and records the delay; a timelock-shaped contract with no readable delay accessor is reported as "delay undetermined," never ignored. `adminCanShortenDelay` is a **flag only** — the presence of `updateDelay`/`setDelay` in the timelock's own bytecode (i.e. the delay is mutable at all). *Who* can reach that path and under what constraint is the day-4 Exit Window question, surfaced today, not solved.
- **The dependency graph's token list is curated, not discovered.** `src/chain/majorTokens.ts` checks balances against 6 hand-verified mainnet tokens (USDC/USDT/DAI/WETH/WBTC/stETH). A target holding a large position in any other token produces no dependency finding for it — Ripcord does not run an indexer or a balance-discovery service, by design.
- **Oracle dependency detection only tries three getter names** (`oracle()`, `priceOracle()`, `priceFeed()`) directly against the target. A protocol exposing its oracle under a different name, or only reachable through an intermediate contract, produces no oracle finding.
- **Dependency-graph depth is exactly one level, on purpose.** A token a target holds is scanned for its own authority/capabilities; that token's *own* dependencies (if it wraps or is backed by something else) are not followed. Deliberate, not an oversight — see the day-2 brief.
- **No Exit Window metric yet, and no monitoring.** The Exit Window metric (delay vs. time-to-exit) is day-4 scope; live monitoring is day-6. Fork simulation landed on day 3 — see [Proving it](#proving-it-the-fork-simulation).

## What's next

- **Day 4** — the Exit Clock: the Exit Window metric itself — upgrade/admin-change delay (using the day-3 timelock delay and the `adminCanShortenDelay` flag as inputs) minus who can bypass or shorten it, versus real time-to-exit (unstaking periods, withdrawal cooldowns, queues, liquidity depth).
- **Day 5** — calibration against 10-15 real protocols, README/report polish.
- **Day 6 (optional)** — Watchtower: live monitoring of timelock queues, alerting when a rule change is actually queued.

## Development

```sh
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest — pure-logic unit tests, no network required
pnpm ripcord scan  <address> --block <n> --chain <id> [--no-cache] [--cache-dir <dir>]
pnpm ripcord prove <address> --block <n> --chain <id> [--artifact-dir <dir>]
```

`prove` additionally requires the [`anvil`](https://book.getfoundry.sh/) binary on PATH (Foundry); `src/fork/preflight.ts` fails loud with install instructions if it's missing, and a `prove` run that can't reach its archetype falls back to `produced: false` rather than erroring. The fork simulation itself is not exercised in CI (it needs a real RPC and a fork); its pure-logic parts — the drainer bytecode assembler and the proof engine's honesty-rail gates — are covered by network-free unit tests (`test/drainer.test.ts`, `test/proofEngine.test.ts`).

`pnpm test` runs in CI without any RPC access. It covers derived constants (asserted against the EIP-1967 reference values), bytecode pattern matching, the dispatcher's reachability-limited selector extraction (hand-built bytecode fixtures for every dispatch shape, plus real mainnet bytecode saved under `test/fixtures/bytecode/` for WETH9/USDC/WBTC/Aave's `PoolAddressesProvider`, each checked against an independently-sourced full ABI), guard-probe revert parsing (real captured mainnet revert bytes plus viem-encoded synthetic OZ v5 custom errors), the adaptive `getLogs` chunking / partial-reconstruction logic (a fake provider with a simulated range limit), the cleared-registry disclosure gate (both directions), the cache's provider-independent key, and capability/proxy-resolution wiring — all against network-free fakes. End-to-end verification against the **six** pinned fixtures in [`test/fixtures/targets.json`](test/fixtures/targets.json) (including FXS, which exercises the OpenZeppelin AccessControl path) requires a real RPC URL and was run manually during development; every observed result is recorded in that file alongside each target. Each scan prints the active provider (`provider: <name> (<host>)`) to stderr — host only, never the key.

## Security

- `.env` and `.cache/` are gitignored from the first commit; `.env.example` ships placeholder values only.
- [gitleaks](https://github.com/gitleaks/gitleaks) runs in CI on every push (see [`.github/workflows/ci.yml`](.github/workflows/ci.yml)).
- Ripcord never signs anything, never holds a private key, and never requests an approval. The only secret it ever touches is an RPC URL — and it is never logged: every scan prints the provider by **host only** (`eth-mainnet.g.alchemy.com`), never the full URL that carries the key.

## What was built during this hackathon

Everything in this repository — first commit dated 2026-08-31, day 1 of a 7-day solo build. See `git log` for the incremental history: repo hygiene and CI first, then derived constants, the cached chain access layer, the report schema, each detector, orchestration, the CLI, and finally verified fixtures and two bugs (a Solidity-metadata false positive and a silent "clean-looking" unknown-authority case) found and fixed by actually running the tool against live mainnet data rather than only unit tests.
# ripcord
