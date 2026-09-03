# Ripcord — technical reference

The detail behind [the README](../README.md): how each engine works, what a
report contains, what the calibration run established, the trust assumptions, the
disclosure policy, and the full limitations list.

The README is the short version and the entry point. This is the document to read
if you want to argue with the tool, which is the intended relationship.

---

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
pnpm ripcord prove 0xc3d688B66703497DAA19211EEdff47f25384cdc3 --block 25800000
```

```
✓ PROOF PRODUCED (sandbox fork — no mainnet tx sent)
   In simulation on a fork at block 25800000, the resolved upgrade authority
   0x6d903f6003cca6255D85CcA4D3B5E5146dC33925 CAN move $540,604,938.71 of the tokens
   this contract holds, in one upgrade path. This authority is subject to a
   proven-binding 172800s notice period, which the fork skips by impersonation —
   in reality the operation would be publicly visible for that long before it could execute.
   impersonated: proxyAdmin:0x1ec63b58… → owner:0x6d903f60… (depth 2, confidence medium)
   - USDC: moved 39744687928433 ($39,740,146.30) via Chainlink USDC/USD
   - WETH: moved 61284532057431493222830 ($142,923,579.33) via Chainlink ETH/USD (WETH is 1:1 wrapped ETH)
   - WBTC: moved 486599463253 ($357,941,213.07) via Chainlink BTC/USD (WBTC is 1:1 wrapped BTC)
   reproduce: pnpm ripcord prove 0xc3d688B66703497DAA19211EEdff47f25384cdc3 --block 25800000 --chain 1
```

The human-readable call trace is written to `.ripcord/proofs/<target>-<block>/trace.txt` (captured via `cast run`), the exact tree of `ProxyAdmin.upgrade → delegatecall drainer → USDC.transfer / WETH.transfer / WBTC.transfer` with the `Transfer` events. The **reproduce command** is the whole thing, deterministic against the pinned block — a judge runs that one line to replay it. Run twice on two independent forks it produces the same total **to the cent**.

Read the notice sentence carefully, because it is the honesty rail that matters most here. This is a proven-binding **2-day** timelock, and the fork skips the queue by impersonating the controller directly. The proof says so, in its own headline, and the `172800s` figure is read from the **same exit-window route the verdict uses** — so the proof cannot advertise a capability as more immediate than the verdict says it is. Without that, this section would read as "$540M can be taken from Compound," which is false: it can be *proposed*, in public, two days ahead.

Non-negotiable honesty rules, because auditors will (and should) probe them:

- **Sandbox only.** Everything runs on an ephemeral local anvil fork. No mainnet transaction is ever sent, no private key is used or held, no approval is requested.
- **Capability, not intent.** Every string says what the authority *can* do — never "will," "malicious," or "rug." The impersonated address is a legitimate admin exercising a legitimate power; the point is that the power exists, and how much notice you get before it is used.
- **A missing proof is honest; a fabricated one is disqualifying.** If the archetype doesn't apply — a non-transparent proxy, an authority that didn't resolve to an impersonable account, or a target holding none of the priced tokens — `prove` returns `produced: false` with a stated reason and falls back to the static finding. It never invents a trace. Verified live: Wasabi's UUPS proxy and WETH9 both return an explicit not-produced reason, and so does PAID's proxy at `0x1614f18f…`, which holds none of the priced major tokens — its report carries `produced: false` with exactly that sentence, which is why the PAID case in this README is made with a `scan` and not a proof.

The dollar figure is a **floor**, not a ceiling: it counts only the curated major-token holdings the [dependency graph](#what-a-report-contains) knows to look for, priced from Chainlink — value in unlisted tokens, LP positions, or staked principal is invisible to it. See [Limitations](#limitations).

### Testing whether the exit can be closed

`ripcord restrict` is a superset of `prove`: after building the same pinned
report and attempting the drain proof, it runs a second ephemeral fork pass. The
current implementation recognises one interface, Compound III / Comet
base-asset supply, and one registered restriction candidate: the
`pauseGuardian()` calling `pause(false,false,true,false,false)`.

The control is a funded supplier whose `withdraw(baseToken, amount)` succeeds.
The fork is snapshotted, the guardian is impersonated at its own address, the
withdraw-pause flag is set, and the identical withdrawal is retried. On Comet the
second withdrawal reverts, so the result is a fork-confirmed direct restrictor and
a zero-notice route. The guardian is a 5-of-9 Safe; impersonating the Safe address
demonstrates what that Safe can do if its signers collude, not what one key can do.

This is deliberately not general privileged-function discovery. Coverage in the
day-7 block means the candidates registered for the matched exit archetype, not
every unmatched selector in the contract. A future clean result is named
`no_direct_restriction_found`, not `can_exit_in_time`, and is scoped to those
registered candidates. The current calibration emits no such result: its only
`restrict` target is Comet, where the restrictor is found. Exit-action
mis-identification, untested arguments and indirect/economic restrictions remain
explicit ceiling items on every evaluation.

---

## The Exit Window

This is the metric the rest of the tool exists to compute.

```
EXIT WINDOW    how long between a rule change becoming possible and it taking
               effect — the timelock delay, MINUS everyone who can bypass or
               shorten it.
TIME TO EXIT   how long you actually need to get out: cooldowns, withdrawal
               queues, two-step unstakes, and whether the exit is open at all.
VERDICT        if TIME TO EXIT >= EXIT WINDOW you cannot finish leaving before
               the rules can change. You are structurally trapped while every
               checklist shows green.
```

**A raw timelock delay is not an exit window.** Reporting a comforting "2 days" that an admin can cut to zero is the most damaging thing this tool could do, so every rule below leans the same way: a delay is worth nothing until positive evidence says otherwise.

**The window is a property of a route, not of a protocol.** Every depth-1 authority — `proxyAdmin`, `owner`, each AccessControl role — is its own path to changing the rules, with its own notice period, and the protocol's window is the **minimum** across them. A two-day timelock on the upgrade path is worth nothing beside an un-delayed role that can reprice your collateral. `exitWindow.routes[]` shows each one, with the capability categories it is known to reach.

**A multisig is not a delay.** A 3-of-11 Safe raises how many parties must agree and adds *exactly zero* notice. The exit window measures time, so a Safe- or EOA-terminated route is `immediate` — `noticeSeconds: "0"`. The threshold is real and reported, as the different (collusion) property it is.

**Binding-ness is established by probing, not by reading names.** A contract exposing `getMinDelay()` is not thereby a real timelock. What makes a delay binding is that its own mutator can be reached *only through the timelock itself*, so shortening the delay is subject to the current delay. Ripcord probes `updateDelay`/`setDelay` from three unrelated addresses at the pinned block and reads the revert — the same technique day 2 uses for guards:

| revert observed | conclusion |
| --- | --- |
| `TimelockController: caller must be timelock` (OZ v4) | `proven_binding` |
| `Timelock::setDelay: Call must come from Timelock.` (Compound) | `proven_binding` |
| `TimelockUnauthorizedCaller(address)` (OZ v5 custom error) | `proven_binding` |
| an Ownable/AccessControl-shaped revert | `shortenable` — a role holder can change the delay directly |
| no mutator in the timelock's own dispatcher | `proven_binding` — the delay is immutable through its interface |
| anything else, or no interpretable revert | `cannot_determine` — **never** credited as binding |

Each detected timelock is also checked for being *itself* behind a proxy: a delay enforced by replaceable code binds only as strongly as the authority over that code.

**An unproven delay can never appear as a window — the schema enforces it.** `exitWindow.assessment` is a discriminated union in which only the `binding` variant *has* a `windowSeconds` field. A delay that could not be verified carries its raw value in `not_proven_binding.nominalDelaySeconds`; zod rejects any shape that would put it where a window goes. Same technique as `GuardStatus`, applied to the metric itself.

**"None found" and "not checked" are different answers.** `exitWindow.bypasses[]` lists concrete ways the window could be shorter than nominal, and `exitWindow.checksPerformed[]` records every check that ran — including the ones Ripcord deliberately does *not* make (governance proposal paths, Safe modules), with `performed: false` and a note on why that gap does not make a reported delay optimistic. An empty `bypasses[]` beside a populated `checksPerformed[]` is a claim; on its own it would be a silence pretending to be one.

**Role membership is not authority.** Found live on Ethena's sUSDe: three plain EOAs hold `FULL_RESTRICTED_STAKER_ROLE` — they are *blacklisted users*, and the first run of this metric reported them as three zero-notice authority routes. OpenZeppelin roles are used as markers (restricted-staker, KYC, whitelist) at least as often as permissions, so a role route now has to earn its place in the arithmetic: it must be `DEFAULT_ADMIN_ROLE`, administer another role, or have a capability guard attributed to its exact role hash. Anything else is `rolePrivilege: "unverified"` and contributes `undetermined` rather than a proven zero. That direction is safe because an unverified route *also* blocks the assessment from reaching `binding` — it can turn a false alarm into an honest "not established," never a real risk into a clean bill.

### Time to exit

Modelled as a **lower bound with its gaps named**, never a precise-looking value.

- **Cooldowns and claim windows** are read from a versioned table of accessor signatures (selectors derived by viem, matched exactly). Measured waiting legs are *summed* — these mechanisms are sequential (request, wait, claim). A **claim window is a deadline, not a delay**: it is recorded with its real duration but adds nothing to the total, because it constrains *when* you must act, not how long you wait.
- **Two-step exits** are detected structurally, from request/claim selector *pairs* in the dispatcher. One with no readable duration is a leg of **unknown** length — which makes the whole time-to-exit "at least X, possibly more," and is strictly more useful than guessing or ignoring it.
- **A mutable cooldown is not a protocol constant.** Where a cooldown's own setter is present, the leg records `mutableBy`. sUSDe reads `cooldownDuration() = 86400` with `setCooldownDuration` in the dispatcher and `MAX_COOLDOWN_DURATION()` of 90 days: reporting "1 day" without that context would be true and misleading at once.
- **Exit blockability.** A pause getter reading true at the pinned block makes time-to-exit *unbounded*, not merely long. Separately, an `ACCESS_RESTRICTION` capability attributed to a holder means the exit can be closed — reported as capability, never prediction. Kept on this side of the metric deliberately: a pause does not shorten the notice before a rule change, it removes the exit, and those are different failures.
- **Liquidity depth is not modelled.** Estimating whether a position could actually be sold needs pool discovery and depth integration across venues — an indexer, which Ripcord does not have. `liquidity.modelled` is a literal `false` in the schema, so a fabricated number cannot be expressed. The consequence, stated wherever the metric is quoted: for a position large relative to available liquidity the real time-to-exit is **longer** than reported, never shorter.

`tight` is what lets the verdict make a two-sided comparison, and it is deliberately hard to earn: a readable dispatcher, every detected leg measured, and nothing currently blocking. An unmeasured leg doesn't merely lower confidence, it removes `tight` — a number that hides a gap is worse than an admitted gap.

### The verdict

`verdict` is data, with every input and its confidence attached — not a sentence bolted onto the end of a report.

| status | meaning |
| --- | --- |
| `trapped` | `timeToExit >= exitWindow`. You cannot finish leaving before the rules can change. |
| `no_notice` | A zero-notice route exists, so the comparison **collapses** rather than being computed — there is nothing to be faster than. |
| `can_exit_in_time` | Both sides determined and tight, and you have slack. Retained in the schema, but occurs nowhere in the current calibration set after the completeness fixes. |
| `immutable_within_checks` | Positive evidence establishes no rule-change route within Ripcord's bounded checks. Carries the basis and caveats that earned it. |
| `no_direct_restriction_found` | A baseline fork exit succeeded and none of the matched archetype's registered candidates directly closed it. Deliberately weaker than “can exit in time”, scoped, and never a safety guarantee; occurs nowhere in the current calibration set. |
| `undetermined` | Either side is unresolved; `missing[]` names exactly what. |

Two rules worth arguing with, so they are stated plainly. **`>=`, not `>`:** if leaving takes exactly as long as the notice you are guaranteed, you finish exiting at the instant the change becomes effective — that is a dead heat, not an escape, and `marginSeconds` is published so it reads as one. **Uncertainty may push the verdict toward caution and never away from it:** a non-tight exit bound can still yield `trapped` (a floor above the window can only grow) but can never yield `can_exit_in_time` (an unmeasured leg could exceed the whole margin).

Everything stays capability, not intent: *"you cannot exit before the rules CAN change,"* never *"will."*

### What it says about the eight fixtures

| target | verdict | why |
| --- | --- | --- |
| WETH9 | `immutable_within_checks` | Positive checks establish no proxy, owner, role, capability or authority-indirection handle. The claim remains explicitly bounded by its caveats. |
| Compound Comet cUSDCv3 | `no_notice` | The upgrade path is timelocked (ProxyAdmin → Compound Timelock, `delay() = 172800`, **proven binding**), and the day-3 proof moves **$540,604,938.71** through it — but that is not the whole story. The day-7 fork differential **demonstrated** a second route with ZERO notice: the `pauseGuardian()` (a 5-of-9 Safe) flips `isWithdrawPaused` and a baseline withdraw that succeeded before then reverts. The window is the MINIMUM notice across routes, so Comet is `no_notice` — open now, closable at any moment. See [CALIBRATION §14](CALIBRATION.md#14-day-7-the-fork-differential). |
| Ethena sUSDe | `trapped` (margin **0**) | Owner is an OZ TimelockController with a proven-binding `getMinDelay() = 86400`; `cooldownDuration() = 86400`. An exact dead heat — you become free to move at the moment the change lands. |
| PAID (both proxies) | `no_notice` | `proxyAdmin` resolves to a single EOA with zero delay. On the live token, `paused()` also reads **true** at this block: the exit is not slow, it is shut. |
| Frax FXS | `no_notice` | `DEFAULT_ADMIN_ROLE` → a 3-of-5 Safe. A real collusion barrier, and no time barrier at all. |
| Aave PoolAddressesProvider | `undetermined` | The chain ends at Aave's PayloadsController, which holds delays keyed by access level — a custom shape Ripcord does not recognise. No Aave-specific detector was added; over-fitting to one protocol's governance is worse than an honest "undetermined." |
| Wasabi PerpManager | `undetermined` | A confirmed UUPS proxy whose upgrade authority does not resolve. Something can change this code and Ripcord cannot say who or how fast. |

Full reasoning per fixture, including exactly what was read live, is in [`test/fixtures/targets.json`](../test/fixtures/targets.json).

---

## What a report contains

- `target` — address, whether it has code, bytecode size and hash.
- `proxy` — pattern (`eip1967_transparent` / `eip1967_uups` / `eip1967_beacon` / `eip1167_minimal_proxy` / `legacy_zos_unstructured` / `not_a_proxy` / `unknown`), the implementation/admin/beacon addresses if applicable, the raw slot values, and evidence for every read.
- `authority` — `owner()`/`pendingOwner()` results, and AccessControl role membership (enumerated live via `AccessControlEnumerable` getters, or reconstructed by replaying `RoleGranted`/`RoleRevoked` events when that extension isn't present). When roles come from an event scan, `authority.accessControl.reconstruction` states how complete that scan was: `complete` (true/false), a `confidence` on the shared high/medium/low certainty scale, the provider's probed `maxLogRange`, and the exact `scannedFromBlock`/`scannedToBlock` — so a partial reconstruction on a range-limited provider is visible, not silent.
- `powerHolders` — every address that turned up holding some capability, classified as `eoa` / `safe` / `contract`, with the Safe's threshold and owners read directly if it is one, and a list of which capabilities route through it.
- `capabilities` — every privileged function Ripcord's dispatcher-based selector extraction found (`scannedAddress` — the *implementation*, for a proxy) that matches the versioned taxonomy (`CODE_CHANGE` / `FUND_MOVEMENT` / `SUPPLY` / `ACCESS_RESTRICTION` / `ECONOMIC` / `AUTHORITY_CHANGE`), grouped by the power it grants, not by name. `findings[]` carries a `guard` — `attributed` (a real probe found an OZ Ownable/AccessControl-shaped revert and mapped it to a known holder), `guarded_unknown_holder` (auth-shaped revert, holder unmapped), or `inconclusive` (nothing interpretable) — never omitted, never a false attribution. Probes are always sent to `probedAddress` (the target/proxy), never to the implementation, so the storage the revert reflects is the storage the named holder actually sits in. A capability where probing observed no auth-shaped revert from any of three unrelated probe addresses is never a normal finding: it moves to `needsManualVerification[]`, which can say "no guard was detected" but never "this is unguarded" — see [Disclosure policy](#disclosure-policy). Since day 5 that array carries two distinct `reason`s: `no_auth_revert_observed` (nothing recognisable came back — **blocks** publication) and `reverted_before_auth_check` (the contract demonstrably rejected the probe on a state or argument precondition, so no auth check ran — reported, but does **not** block, because a fact about Ripcord's own zero-valued probe supports no vulnerability reading).
- `authorityIndirection` — day-5 markers: zero-argument getters (`getAuthorizer()`, `authority()`, `admin()`, …) that resolve to a non-zero address, meaning authority is held by some *other* contract. Ripcord records the handle and deliberately does **not** follow it; the only effect is that the exit window may no longer claim `immutable_within_checks`. `gettersProbed` is listed so an empty `markers` means "checked, found none."
- `authorityResolution` — the day-3 recursion. Each direct power holder that is a contract is followed into *its* own authority until it terminates, producing a `roots[]` tree and a flattened `paths[]` projection you can read as a chain: `proxyAdmin → ProxyAdmin contract → EOA 0x…`. Every path carries its `effectiveController` (the address the proof engine would impersonate), a per-hop `depth`, and a `confidence` that degrades with depth (`high` at depth 1, `medium` at 2, `low` at 3) — an effective controller three hops away is never asserted with a direct owner's certainty. Every leaf states an explicit `terminationReason` (`eoa`/`safe`/`timelock`/`max_depth`/`cycle`/`no_authority_found`); a contract that resolves to a timelock records the delay (`getMinDelay()`/`delay()`), and cycles (A owns B owns A — seen live on Aave governance) are recorded in `cyclesDetected`, never looped on.
- `proof` — null unless you ran `ripcord prove` or `ripcord restrict` (which includes the proof pass). When present it is the fork-simulation result: `produced: true` with a dollar-denominated `deltas[]`/`totalUsd` when funds actually moved, or `produced: false` with a `failureReason` when the archetype didn't apply — never a fabricated result. Since day 4 it also carries `noticeSeconds`/`noticeNote`, sourced from the matching exit-window route: anvil impersonation executes *as* the controller and therefore skips any timelock queue, so a proof driven from a timelocked authority states the notice period it skipped rather than reading as an instant drain. See [Proving it](#proving-it-the-fork-simulation).
- `exitRestriction` — null on a plain `scan`/`prove`, present after `ripcord restrict`. It records the identified exit action, baseline, the matched archetype's registered candidates and bounded arguments, coverage, restrictors, fork block, sandbox statement and the three ceiling items. A fork-confirmed restrictor adds a labelled exit-window route; a future clean outcome is scoped only to the registered candidates evaluated. See [Testing whether the exit can be closed](#testing-whether-the-exit-can-be-closed).
  `evaluationGaps[]` is the fail-closed bridge between execution and composition: an `inconclusive`/`not_evaluated` candidate or any incomplete aggregate-enumeration site forces `evaluation_inconclusive`. A demonstrated restrictor remains valid despite such gaps because unseen candidates can only add more restrictors; in the clean direction every gap blocks the claim. The report schema rejects a clean outcome unless every recorded candidate is `no_effect`, candidate counts agree, the baseline and exit action are established, and no evaluation gap exists. `composeVerdict` repeats those checks independently and additionally requires `enumeration.complete=true`.
  Every executed leg also retains a fork-only transaction witness: sender, target, full calldata and selector, value, gas limit, transaction hash, receipt status/block/hash/index, gas used and (for a reverted transaction, when the node exposes it) raw revert data. The rendered page shows the compact transaction chain; the JSON keeps the complete witness. Fork hashes are explicitly not presented as mainnet hashes.
- `exitWindow` — the day-4 metric. `assessment` is a discriminated union (`binding` / `no_notice` / `not_proven_binding` / `immutable_within_checks` / `undetermined`) in which **only** `binding` carries `windowSeconds`, and only `immutable_within_checks` — a *positive* claim that must be earned — carries the `basis[]` of reads that earned it. Everything that cannot be established falls through to `undetermined`; see [Calibration](#calibration-day-5) for the bug that made this split necessary. `routes[]` lists every authority route with its notice period, `rolePrivilege`, and the capability categories it reaches; `bypasses[]` lists concrete ways the window could be shorter; `checksPerformed[]` records what was and was not checked, so an empty bypass list means "checked, found none" rather than "never looked." See [The Exit Window](#the-exit-window).
- `timeToExit` — cooldowns, claim windows and two-step exit shapes as a **lower bound** (`atLeastSeconds`) plus `tight`, with `unmeasuredLegs[]` naming every gap, `blockable` saying whether the exit can be closed (and by whom), and `liquidity.modelled` a literal `false`.
- `verdict` — the composed judgement: `status`, a capability-not-intent `statement`, both sides, `marginSeconds`, a weakest-link `confidence`, `missing[]` naming what is absent when it degrades, and `inputs[]` carrying every input with its own confidence and source.
- `dependencies` — one level deep. `tokens[]`: major ERC20s (a curated list, not full discovery — see Limitations) the target holds a nonzero balance of, each re-scanned for its own proxy/authority/capabilities. `oracles[]`: addresses returned by a short list of common oracle-getter probes, with authority detection run on each.
- `unknowns` — always present. Anything Ripcord could not determine, and why. **Never empty just because everything looked fine** — an upgradeable proxy with no identified authority produces an explicit unknowns entry precisely because "nothing found" must never read as "nothing to find."
- `errors` — always present. Any RPC read that actually failed (as opposed to a contract-level revert, which is a normal, evidence-carrying result, not an error).

Every finding, everywhere in the schema, carries an `evidence[]` array: the kind of read (`storage_slot` / `call` / `log` / `bytecode`), its exact parameters, the raw value the node returned, and the block it was read at. A finding without evidence is a rumour.

---

## Calibration (day 5)

A tool that flags everything is worthless; a tool that reassures you is
dangerous. **26 mainnet protocols**, all pinned to block 25800000, were scanned
to find out which one Ripcord is. Full write-up with per-protocol accounting:
**[`docs/CALIBRATION.md`](CALIBRATION.md)**. The reports themselves are
committed under [`calibration/reports/`](../calibration/reports/), so every number
below can be re-derived without an RPC key.

| | |
|---|---|
| Protocols scanned | **26** (8 verification fixtures + 18 new) |
| Infrastructure errors | **0** |
| **False-clean results** | **0 of 26** — and now provably robust to enumeration gaps |
| False alarms (`no_notice`/`trapped` where there is none) | **0 of 26** |
| `undetermined` | 16 of 26 — the deliberate trade |
| `no_notice` (incl. day-7 fork-confirmed) | 7 of 26 — Comet is the fork-confirmed one |
| Publishable under the disclosure gate | 22 of 26 |

**The one optimism-direction bug calibration found**, and it was in the last
layer anyone would audit: the exit-window status `no_rule_change_route_found`
treated *the absence of a found route* as *the absence of a route*, and the
verdict rendered it as "**No exit-window risk was identified**". It fired on
three contracts and was substantively wrong on two — Balancer Vault (every
permission lives in a separate `TimelockAuthorizer` behind `getAuthorizer()`) and
rETH (a RocketStorage registry). The data layer was honest the whole time; one
sentence in the composition layer was not.

It was fixed as an **epistemic split, not a rewording**. The status became
`immutable_within_checks` — a positive claim that must be *earned*, carrying the
`basis[]` of reads that earned it — and the default was **inverted** so that
everything else falls through to `undetermined`. "Clean" now requires evidence;
"I don't know" is what you get for free. Both false-cleans are gone and the true
negative (wstETH) survived.

Four of the eighteen new targets were chosen *specifically* because a wrong
answer on them would be false-clean rather than a visible false alarm — DAI
(`wards`), MKR (`owner()` reads the **zero address** while DSChief holds real
power), Balancer Vault, and stETH. All four now come back `undetermined`, and
MKR's report names the `authority()` handle it refuses to follow.

**The second bug, found by auditing what remained**, was the same family one
layer lower — and it was live on two protocols. Role enumeration goes partial
whenever the provider caps `eth_getLogs`, and that partiality was *labelled*
correctly but **propagated nowhere**: `reconstruction.complete` was written and
then read by nothing, so the exit window computed its **minimum notice over only
the routes it happened to see**. Ethena Minting reported `can_exit_in_time` on a
scan covering 6,750 of 5.66M blocks; Ethena USDe reported the same while not
being an AccessControl contract at all — its partial scan sits on the **depth-1
timelock** whose `PROPOSER`/`TIMELOCK_ADMIN` holders are exactly what "the delay
is binding" rests on. Both said `missing: []` while doing it.

The witness is therefore an **aggregate over every route at every depth**, derived
**fail-closed** (a missing flag, an `undefined`, a failed stage: all incomplete —
because reading an absent flag as "complete" would rebuild the very bug inside its
own fix), and the reassuring variants are **structurally unconstructable** without
it: `binding` and `immutable_within_checks` carry `enumeration: { complete: true }`
as a zod literal. Direction stays caution-only — `no_notice` and `trapped` are
never softened, since unseen routes can only *lower* the minimum notice. Two
verdicts changed, zero moved toward reassurance, and every reassuring verdict at
that stage carried a complete witness. The later privileged-surface rule reduced
the current set to the two `immutable_within_checks` controls; both still carry
that witness. Full account:
[`docs/CALIBRATION.md` §9](CALIBRATION.md).

Two measured gate rates, both hand-verified:

- **`rolePrivilege` gate false-negative rate: 0 of 3.** Every `unverified` role
  route was checked behaviourally, not by reading source: sUSDe's three
  `FULL_RESTRICTED_STAKER_ROLE` holders cannot even `transfer` (all three revert
  `OperationNotAllowed()`) while an unrelated address can — the role *removes*
  power. The denominator is 3 for an honest reason, stated in the write-up.
- **Disclosure gate: 0 of 30 blockers were genuinely unguarded.** 22 were
  contracts stating plainly, in their own revert string, that a guard had fired —
  in a dialect Ripcord could not read. Those dialects are now in a versioned,
  anchored dictionary, and manual-verification entries fell from 30 to 9.
  Unrecognised still blocks: Wasabi's custom error still does, correctly.

### The Aave case: what a bounded answer looks like

This is the clearest worked example of Ripcord refusing to guess, so it is
written out in full rather than left as a limitation bullet.

**Aave v3's `ACLManager`** (`0xc2aaCf6553D20d1e9d78E365AAba8032af9c85b0`) is the
contract that holds Aave's permission roles. Ripcord reports it as
`undetermined`. That is the correct answer *on this endpoint*, and here is
exactly why, with every figure independently checkable:

| Fact | Value | How it was established |
|---|---|---|
| Roles provably present on-chain | **5** — `POOL_ADMIN`, `FLASH_BORROWER`, `EMERGENCY_ADMIN`, `RISK_ADMIN`, `BRIDGE` | each getter resolves at the pinned block, and each returned hash matches `keccak256(preimage)` **by derivation**, not by recognition |
| Roles Ripcord recovered | **1** — `DEFAULT_ADMIN_ROLE`, 0 members | `authority.accessControl.roles` |
| Is it `AccessControlEnumerable`? | **No** — `getRoleMemberCount` reverts | so membership is reachable *only* by replaying `RoleGranted`/`RoleRevoked` |
| Contract history | 9,508,883 blocks (16,291,117 → 25,800,000) | deployment block found by binary search over `getCode` |
| Provider `eth_getLogs` range | **9 blocks** | probed live at startup (`rpcPreflight.probeMaxLogRange`) |
| History actually covered | 6,750 blocks = **0.071%** | `reconstruction.scannedFromBlock`/`scannedToBlock` |
| Range needed to enumerate fully | **≥ 12,696 blocks** | `history ÷ (budget/2 − 1)`, budget = 1500 requests |

So Ripcord knows *which* roles exist — it can derive them — and cannot learn
*who holds them* at this range. It labels the reconstruction
`complete: false, confidence: low` with the exact covered window, that label
propagates into the enumeration witness, the witness is withheld, and the two
reassuring assessment variants become **structurally unconstructable**. The
verdict falls through to `undetermined`.

**That is the entire thesis, visible on a marquee protocol.** Ripcord is not
failing here; it is doing the thing the enumeration-completeness work exists to
make it do — refusing to publish a verdict over a half-enumerated power
structure. A tool willing to say "no exit-window risk identified" about Aave
because it only found one empty role would be worse than useless.

Reproduce it, and see the same labels:

```sh
pnpm ripcord scan 0xc2aaCf6553D20d1e9d78E365AAba8032af9c85b0 --block 25800000 --chain 1
```

**What would fix it:** an endpoint whose `eth_getLogs` range is ≥ ~12,700 blocks
(or a raised `MAX_LOG_REQUESTS` in `src/detect/accessControl.ts`). Nothing about
the ruleset changes — this is coverage, not detection. It is deliberately *not*
fixed by teaching Ripcord an Aave-shaped shortcut, which would be over-fitting to
one protocol's governance and would trade an honest bound for a fragile guess.

**Logged as future work, deliberately not done today:** the same logs are freely
available through a block-explorer API with a topic filter over the full range,
which sidesteps the `eth_getLogs` cap entirely. That is a *new ingestion source*,
and it touches the pinned-and-cached determinism model that every reproducibility
claim in this README rests on. It is post-hackathon work, not a day-6 change.

---

## The rendered report

One pinned JSON report in, one static HTML page out. **No backend, no live
scanning, no network access at render time or view time, and no JavaScript on
the page at all** beyond native `<details>` for the collapsible sections.

```sh
pnpm render        # calibration/reports/*.json -> site/*.html (publishable only)
pnpm verify:pages  # prove the pages match the JSON
```

The honesty rule for the visual layer is that every discipline the schema
enforces must survive into the design — a renderer that paints uncertainty green
would undo the whole project in one stylesheet. So it is **enforced, not
promised**: every headline figure is read through a `FigureLog` that records the
JSON path it came from, and `scripts/verify-pages.mjs` re-derives all of them
from the source report, plus seven structural properties:

- no network-capable construct appears in any page;
- an `undetermined` verdict never wears the healthy tone;
- an unproven delay always says "not proven binding", never a confident window;
- a partial role reconstruction shows its label **and** its exact covered blocks;
- a positively-established no-route result is never rendered as "NOT ESTABLISHED";
- a halted exit never renders as a duration;
- only publishable reports get a page at all.

It also enforces one invariant across **every** report, not just the published
ones: no reassuring verdict or window may sit on an incomplete role enumeration
anywhere in the report — target, authority path at any depth, or dependency graph
— and no report may claim `missing: []` beside an incomplete reconstruction. It
derives incompleteness independently of the code that produces it, so a bug in
the derivation cannot hide itself. That is the report analogue of the
byte-identity determinism gate: it makes a whole failure class impossible rather
than pinning one instance of it.

Current status: **22 pages, 75 figures machine-checked, 26 reports checked for
the enumeration invariant, 0 failures.**

The two-bar hero has **four** states rather than three, and the distinction is
the point: `known` (solid), `unproven` (hatched at its nominal length),
`unknown` (full hatch — deliberately no length to read off it), and `none` (a
flat tint: nothing to *measure*, because no route was found to exist). Drawing
"we found nothing" the same as "there is nothing" would put the day-5
conflation straight back into the stylesheet.

The pair to read side by side is **Compound Comet** and **PAID**: the same
engine, opposite verdicts. Comet's authority can move **$540,604,938.71** — proven
on a fork, not asserted — but only after a **proven-binding two-day notice**, and
that notice figure is read from the same exit-window route the verdict uses, so
the proof and the verdict can never quote different delays. PAID's authority
holds far less, has **zero** notice, and the token's `paused()` reads **true** at
the pinned block: the exit is not slow, it is shut.

---

## Trust assumptions

- **You trust the RPC to tell the truth.** Ripcord does not run its own node or cross-check against a second provider. If the RPC lies about a storage slot or a call result, Ripcord reports the lie, with evidence, faithfully. Pin `--block` to a specific number and use an RPC provider you trust for the chain in question.
- **You trust Ripcord's pattern coverage.** Day 1 recognizes EIP-1967 (transparent/UUPS/beacon), EIP-1167 minimal proxies, and legacy zeppelinos unstructured storage. Anything else — a custom proxy, a diamond (EIP-2535), a non-standard access-control scheme — is either misclassified as `not_a_proxy` (if it has no delegatecall Ripcord's scanner can find) or explicitly flagged `unknown` (if it does). See Limitations below for exactly where this breaks down today, verified against real contracts, not hypothesized.
- **Guard probing depends on the RPC returning revert data.** Ripcord attributes a capability's guard by making a real `eth_call` and parsing the raw revert bytes; whether a provider returns those bytes on a reverted call is provider-dependent. Observed live during day-2 development: probing USDT against a public mainnet RPC returned no revert data on any of three probes, so its `pause()`/`unpause()`/`transferOwnership(address)` guards all came back `inconclusive` on that run — not because USDT lacks guards, but because that specific provider didn't hand back the bytes needed to see them. A different provider can produce a different (more attributed) result for the identical, deterministic on-chain state.
- **A read that fails is never reported as an absence.** This is the property day 6's semantic audit exists to guarantee, and it is worth stating as a trust assumption because it used to be false. Roughly twenty detectors read a revert as a fact about the *contract* — `owner()` reverted therefore no owner, `DEFAULT_ADMIN_ROLE()` reverted therefore not AccessControl, `balanceOf()` reverted therefore nothing held — so the classification of "revert vs. infrastructure failure" at the RPC boundary decides whether a broken endpoint produces an error or a **confident clean report**. That classification is now **fail-closed**: a result is a revert only when something positively says so (raw revert bytes, viem's `ExecutionRevertedError`, RPC error code 3, or the node's own `execution reverted` message), and everything else raises a `ChainReadError` that lands in `errors[]` and withholds the enumeration witness. The four positive signals were derived from live observation, not from memory — `npx tsx scripts/audit-error-shapes.ts` reproduces the evidence, and `test/readFailures.test.ts` pins the exact shapes so CI needs no network.

- **The cache is trusted once written.** Every RPC read is pinned to a historical block and cached to disk forever (a historical block's contents never change), which is what makes a rerun network-free. A cache miss is normalized to exactly the shape a later hit returns, so a **cold run and a warm run are byte-identical** — verified on day 4 by wiping `.cache/` and re-running all eight fixtures, which reproduced every report byte for byte (`generatedAt` aside). That equivalence is not decorative: it is what makes "delete the cache and check for yourself" a meaningful instruction rather than a hopeful one. If you believe an RPC provider fed Ripcord bad data, delete `.cache/` and rerun with a provider you trust — don't edit cache files by hand, since nothing checks them for tampering.

---

## Disclosure policy

Ripcord's findings split into two branches with different disclosure rules.

**Admin capability findings are published freely** — everything in `powerHolders`, `capabilities.findings`, and the dependency graph. Executing any of these paths requires the admin key (or an attributed role) itself, so publishing the finding grants no capability to anyone who doesn't already hold it. It only ever demonstrates something on a fork with impersonation of a key nobody but the admin holds. The admin already knows their own key exists and what it can do. And there is no patch to withhold time for: an admin's ability to call a function it holds the key to is inherent design, not a vulnerability. Day 5's calibration run against 26 live protocols publishes this class of finding without restriction.

**Actual vulnerabilities are not published, and are not what `needsManualVerification` claims to have found.** An unprotected initializer, a genuinely unguarded privileged function reachable by *any* caller, or anything else where a non-privileged party could seize control, is a different category entirely — and Ripcord's probing methodology is deliberately incapable of asserting it exists. `needsManualVerification` entries are an honest "no guard was detected by probing," not "no guard exists": a custom access-control scheme, a revert triggered by an unrelated state check before the auth check runs, or an RPC provider that silently drops revert data can all produce the exact same observation as a genuinely missing guard (see KNOWN EDGES in `CLAUDE.md`).

Because that distinction is easy to lose under time pressure, it is enforced as a rule rather than a judgement call, and the rule is checked by the tool rather than by whoever is running it:

> **Ripcord does not publish a report carrying a blocking `needsManualVerification` entry** (`reason: "no_auth_revert_observed"`) — at the target or anywhere in its dependency graph. Such a report stays local until the entry is either cleared by a human as a design property, or disclosed to the project. The published calibration set consists exclusively of reports where that field is empty.

Every report carries a `disclosure` block computed from exactly that rule (`publishable`, `reason`, and `blockedBy` naming each entry), and the CLI prints a loud `DO NOT PUBLISH THIS REPORT` warning to stderr when it trips. Day 5's calibration set is filtered on `disclosure.publishable`, so nothing gets published because someone eyeballed it and thought it looked fine.

Where an entry does turn out to be a real, exploitable vulnerability rather than a design property: do not publish it, do not commit it to this repository's fixtures or examples, make one contact attempt through the project's published security channel (or a platform such as Immunefi if they run one), document that the attempt was made, and leave it there. Standard responsible disclosure, and the documented attempt is what makes it verifiable that we followed it.

### What calibration actually found, and why no disclosure was owed

Stated plainly, because it is the question a security reviewer asks first:

> **Across 26 mainnet protocols, Ripcord found zero genuinely unguarded
> privileged functions.** All 30 entries that tripped the publication gate were
> decoded and hand-classified: 22 were contracts stating in their own revert
> string that a guard had fired, in a dialect Ripcord could not yet read; 4 were
> Ripcord's own zero-valued probe arguments being rejected by a state or
> argument precondition before any auth check ran; 4 were genuinely
> undetermined — an unrecognised custom error or no revert data at all.

So **no responsible-disclosure obligation was triggered**, because nothing was
found that could be disclosed: not one finding where a non-privileged party
could seize control. Every blocker was either a guard we could not read or a
fact about our own probe. `node scripts/manual-verification-audit.mjs
calibration/reports` reproduces the classification from the reports' own
`probes[]` evidence.

The single strongest-looking observation in the set — PAID proxy 2's
`mint(address,uint256)` executing successfully for three unrelated addresses on a
live token — was followed all the way to the state level before publication: a
real fork transaction from an unrelated sender, and from the owner, succeeds and
changes **nothing** (Δ supply 0, Δ balance 0). It is a no-op stub, not an open
mint. That investigation is written up in
[CALIBRATION §12](CALIBRATION.md#12-the-one-blocker-that-looked-like-a-real-finding),
and it is the disclosure gate's first real exercise: the probe could not rule out
"unguarded", so publication was withheld, no page was ever rendered, and only
then did a human resolve it.

The gate was **not** softened to unblock anything. Reports that still carry a
blocking entry — including Ethena's sUSDe, which is the dead-heat showcase and
the single most useful page in the set — remain unpublished, and their pages are
not in `site/`. The published set is filtered on `disclosure.publishable`
computed by the tool, never on a per-protocol judgement made under time
pressure.

### Why the unpublishable reports are still in this repository

`calibration/reports/` contains **all 26** JSON reports, including the four whose
`disclosure.publishable` is `false`. That looks like a contradiction — the gate
says "do not publish", the repository publishes — so it is worth stating exactly
what the flag governs, because the distinction is the whole point.

**The flag governs whether a rendered verdict PAGE is produced, not whether the
raw evidence exists.** A page is a readable judgement about a named protocol,
written for a non-specialist, and that is what must not go out while a capability
is unresolved. `site/` therefore contains 22 pages, not 26, and
`scripts/verify-pages.mjs` **fails the build** if an unpublishable report ever
acquires one. The JSON is the reproducibility substrate: without it,
`compare-reports.mjs` cannot run over the full set, the determinism gate covers
only part of the calibration, and "check our numbers yourself" stops being true.

Three properties make shipping the raw reports safe, and all three are checkable
rather than asserted:

1. **The blocked reports assert nothing.** Every blocking entry carries the
   sentence *"this does not prove the function is unguarded"* in its own `note`.
   The report's positive claim is "no guard was recognised by probing", which is
   a statement about Ripcord's coverage — the opposite of a vulnerability claim.
   `verdict.status` on all four is `no_notice`, `trapped` or `undetermined`;
   none is reassuring, and none names an exploit.
2. **Nothing in them is undisclosed.** Every blocker was decoded and
   hand-classified (§6), and the one that looked strongest was followed to the
   state level and cleared (§12). Calibration found **zero** genuinely unguarded
   privileged functions, so there is no finding being sat on.
3. **Everything in them is public and re-derivable.** They contain contract
   addresses, storage slots, role hashes, revert payloads and block numbers —
   all readable by anyone with an RPC endpoint. Ripcord discovers no private
   information; its contribution is reading public facts systematically.

The rule that actually protects anyone is the one the tool enforces: **a report
that cannot rule out an unguarded capability does not get a page.** That rule is
in the schema, printed loudly by the CLI, and checked in CI — never left to
whoever is running it under time pressure.

### Cleared dependency registry

Taken literally, the gate above blocks essentially every protocol on earth — because almost all of them hold USDC, and USDC's blacklist/pause/mint are exactly the powerful, probe-resistant capabilities the gate is built to catch. But those are not latent vulnerabilities: they are the loudly-documented, audited design of a centrally-issued stablecoin. Circle *can* freeze a USDC balance; that is the defining, publicly-known property of the asset, not something Ripcord discovered.

So Ripcord keeps a small, **versioned** cleared registry ([`src/chain/clearedRegistry.ts`](../src/chain/clearedRegistry.ts)) recording, per `(token, capability)`, that a capability is documented design — with a one-line justification and a source. A cleared capability **on that specific token** is recorded in `disclosure.cleared` (with the registry version the report used) and does not force `publishable: false`. Everything else still blocks: the same signature on a *different* token, an *undocumented* signature on a cleared token, and — always — the **target's own** capabilities, which the registry never clears. The clearing is auditable and reversible, never a silent allowlist: `disclosure.cleared` names exactly what was waved through, on which token, and why. It doubles as a standalone artefact — a curated statement of who can freeze or mint the major assets.

---

## Limitations

- **Recursion resolves owner-of-owner, but only to depth 3 and only through standard authority.** Day 3 follows a contract power holder into its own `owner()`/AccessControl/`proxyAdmin` (this is what surfaces PAID's `ProxyAdmin → EOA` chain), but it stops at max depth 3 (a longer legitimate chain terminates as `max_depth`, explicit, never silently truncated) and it can only follow *standard* authority — a contract controlled through a custom scheme with no `owner()`/AccessControl/`proxyAdmin` terminates as `no_authority_found` at whatever depth it's reached, honestly short of the true controller (the same class as Wasabi's unrecognised access control). Cycles are detected and recorded rather than looped on.
- **The DELEGATECALL "unknown" proxy-pattern heuristic is a linear byte scan, not control-flow analysis** (day 1). It correctly skips PUSH-immediate data and Solidity's trailing CBOR metadata blob, but it has no notion of reachability. A factory contract that deploys a proxy via `new SomeProxy(...)` embeds that proxy's full initcode — including its real `DELEGATECALL` — inside its own bytecode, and this scanner cannot tell "code this contract would execute" from "code embedded as another contract's creation bytecode." Demonstrated live: Aave's `PoolAddressesProvider`, not itself upgradeable, comes back `pattern: "unknown"` for exactly this reason. Reported as uncertain, not as a false "not a proxy" — the correct failure mode, but worth knowing about before reading too much into a lone `unknown`. (Day 2's dispatcher-based selector extraction, below, does not have this problem — it uses reachability analysis specifically to avoid it — but this older proxy-pattern heuristic is unrelated code and still has it.)
- **Capability selector extraction uses reachability analysis, not a linear scan** (day 2), specifically to avoid the problem above: a minimal static walk follows only real JUMP/JUMPI targets from offset 0, so a CODECOPY'd child contract's embedded creation bytecode is structurally unreachable rather than misread as the parent's own dispatch branches. Verified against the same Aave fixture: the child proxy's admin selectors do not appear. Still: if bytecode doesn't match a recognized Solidity dispatcher shape at all (Vyper, hand-written assembly, an unusual compiler), extraction returns `recognized: false` rather than guessing.
- **Ripcord does not report whether a contract has a fallback or `receive()` function.** An early heuristic for this was removed rather than shipped: it returned "has a fallback" for every real contract tested, including ones that have none — a flag with no evidence behind it. Proving a fallback body exists, as opposed to the compiler's default revert stub, needs the control-flow analysis that is deliberately out of scope. Selector extraction walks past these guards correctly; it just doesn't report on them.
- **Capability taxonomy matching only recognizes selectors on its own curated table.** A selector not in `src/detect/taxonomy.ts` is unclassified, not "no privileged capability" — Ripcord does not do reverse-lookup against an external 4byte-style selector database (that would be a live, non-deterministic dependency, inconsistent with pinned-block reproducibility). The report is explicit about the size of this gap rather than hiding it: `selectorsExtracted` always equals `findings + needsManualVerification + unmatchedSelectors`, and the unmatched ones are listed. Scanning USDC today extracts 55 selectors and classifies 7 of them — the other 48 are named in `unmatchedSelectors` so you can see exactly what the taxonomy didn't cover.
- **Guard attribution is by probing, not proof.** Ripcord calls each detected capability's selector with zero-valued arguments from three deterministic, protocol-unrelated addresses and parses the revert for a recognized OpenZeppelin Ownable/AccessControl shape. A recognized auth-shaped revert is real, strong evidence. The absence of one is not proof of absence: the call may revert for an unrelated reason before ever reaching an auth check (observed live: PAID Network's `unpause()` reverts with `"Pausable: not paused"`, telling us nothing about its guard), the contract may use a custom scheme Ripcord doesn't recognize (observed live: USDC's `"FiatToken: caller is not a minter"`), or the RPC provider may not return revert data at all (observed live: USDT against a public RPC). All three produce the same `needsManualVerification` outcome — genuinely different situations that probing alone cannot distinguish. See [Disclosure policy](#disclosure-policy).
- **AccessControl role discovery depends on the provider's `eth_getLogs` range, and degrades to a *labelled partial* on a small one.** Non-enumerable role membership is reconstructed by replaying `RoleGranted`/`RoleRevoked` from the contract's deployment block (found by binary search over `getCode`, not an indexer). Ripcord probes the provider's real getLogs block-range at startup and chunks to it; if covering the full history would exceed a request budget (1500 requests), it scans the most recent affordable window and marks `authority.accessControl.reconstruction.complete = false` with a lowered `confidence` and the exact block window it *did* cover — never a silent truncation, never a false "no roles." **Completeness is a function of range × budget vs. history depth, not just "is the provider paid."** The scan is `complete: true` only when the provider's probed range covers the contract's whole deployment-to-pinned history within the budget — roughly `range ≳ history / 750`. A deep-history contract can therefore be an honest labelled partial even on a paid provider: FXS (~14.3M-block history) needs a ~19k-block range, larger than Infura's 10k or Alchemy PAYG's 2k, so under the default budget it reconstructs as `complete: false / medium` on every provider tested (blastapi and Alchemy free tier are both capped at ~9 blocks; verified live — see [`test/fixtures/targets.json`](../test/fixtures/targets.json)). Raising `MAX_LOG_REQUESTS` or using an unbounded-range provider is what flips it to `complete: true`. **Enumerable membership is authoritative regardless of scan completeness** — a partial scan only risks missing a role that was never touched in the covered window, never the membership of a role it did find. Separately, this only recovers roles that were *granted* via an event; a role wired only through a constructor default with no emission is invisible.
- **The proof engine covers exactly one archetype.** `ripcord prove` simulates only `CODE_CHANGE → drain` on an EIP-1967 **transparent** proxy via `ProxyAdmin.upgrade(address,address)` — the path validated live end-to-end. UUPS (`upgradeToAndCall` on the proxy), beacon, and legacy-zos upgrade paths return `produced: false` with a stated reason rather than a guessed simulation. Deliberate depth-over-breadth, not an oversight. Two further caveats on the ones it does run: the drained dollar figure counts only the curated major-token holdings (a **floor**, see above), and because anvil impersonation ignores signatures, a proof whose resolved controller is a **Safe** impersonates the Safe address directly — demonstrating "this Safe *can*, if its signers collude," not "one key can." The PAID demo impersonates a plain EOA, so that caveat doesn't apply there.
- **The exit-restriction differential covers one interface and one registered candidate.** `ripcord restrict` currently recognises Compound III / Comet base-asset supply and tests its `pauseGuardian()` with the withdraw-pause argument. It does not discover or execute every privileged function in the contract: `coverage` is coverage of the candidates registered for that matched archetype. The only calibration target run in this mode is Comet, and it finds the restrictor; `no_direct_restriction_found` occurs nowhere in the set. Extending the clean direction requires a complete candidate registry, strict handling of inconclusive candidates and live validation per interface before that tier should be relied upon.
- **Whether a delay is binding is decided by exact-string revert matching, and one of the three recognized forms has not been seen live.** `proven_binding` requires the canonical OZ v4 or Compound self-call-gate phrase (both read from mainnet before the code was written) or OZ v5's `TimelockUnauthorizedCaller(address)` custom error — the last of which is derived via viem and asserted in tests, but no OZ v5 timelock appeared among the calibration targets, so it is derivation-correct rather than live-verified. Matching is tight on purpose; the only flexibility is the contract-name prefix Compound forks vary. A well-built custom timelock whose self-call gate is phrased differently degrades to `cannot_determine` — never credited as binding, which is the safe direction, but it does mean Ripcord can *understate* a good timelock.
- **A protocol whose delay lives off the executor is not detected.** Verified live on Aave: the Governance v3 `Executor` that owns Aave v3's `PoolAddressesProvider` exposes four selectors and no delay accessor at all — the delay sits in the PayloadsController, keyed by governance access level. Ripcord classifies timelocks by delay accessor, so the whole chain terminates as `max_depth` and the window is `undetermined`. No Aave-shaped detector was added; over-fitting to one protocol's governance is worse than an honest non-answer.
- **The exit window counts every authority route and takes the minimum, which is deliberately blunt.** An un-delayed `MINTER_ROLE` holder drives the protocol window to zero even where the upgrade path is perfectly timelocked — a rule change that dilutes you with no notice is still a rule change. Per-route `categories` show which power each route carries but do not weight the arithmetic, and an empty `categories` means "nothing was attributed to this holder," never "harmless."
- **A privileged role whose guard probe was inconclusive can be under-reported.** The `rolePrivilege` gate (added after the sUSDe false positive above) requires evidence before a role route enters the window arithmetic, so a genuinely privileged role Ripcord couldn't attribute becomes `unverified` and contributes `undetermined` instead of a proven zero. Acceptable only because of a structural property: an unverified route *also* prevents the assessment from reaching `binding`, so the gate can never turn a real risk into a clean bill. `powerHolders` still lists every role member regardless.
- **Time-to-exit reads a curated, finite table of exit mechanisms.** ~12 cooldown accessors and ~5 two-step request/claim selector pairs. A protocol whose exit delay is exposed under another name, or stored per-user rather than as a global constant, yields `no_mechanism_detected` — reported at medium confidence with the caveat attached, never as proof of instant exit. A block-denominated accessor on a chain with no seconds-per-block constant becomes an *unmeasured* leg rather than a converted guess.
- **Liquidity depth is not modelled at all**, by decision — see [Time to exit](#time-to-exit). For a position large relative to available liquidity the real time-to-exit is longer than reported.
- **The dependency graph's token list is curated, not discovered.** `src/chain/majorTokens.ts` checks balances against 6 hand-verified mainnet tokens (USDC/USDT/DAI/WETH/WBTC/stETH). A target holding a large position in any other token produces no dependency finding for it — Ripcord does not run an indexer or a balance-discovery service, by design.
- **Oracle dependency detection only tries three getter names** (`oracle()`, `priceOracle()`, `priceFeed()`) directly against the target. A protocol exposing its oracle under a different name, or only reachable through an intermediate contract, produces no oracle finding.
- **Dependency-graph depth is exactly one level, on purpose.** A token a target holds is scanned for its own authority/capabilities; that token's *own* dependencies (if it wraps or is backed by something else) are not followed. Deliberate, not an oversight — see the day-2 brief.
- **A bespoke authority registry exposing no getter is still invisible** (day 5). The indirection markers catch a delegated-authority *handle* only when a zero-argument getter returns a non-zero address. Rocket Pool's rETH exposes none — its RocketStorage check is entirely internal — so nothing explains *why* it is undetermined; the inverted default holds it there regardless, which is the safe outcome, but this is exactly the bound that `immutable_within_checks` carries in its name and its `caveats[]`.
- **The guard-dialect dictionary is in-sample and must be described that way.** Its 13 entries were found by reading the calibration set's own reverts, so "22 of 30 blockers were demonstrably guarded" is a statement about *that set*. A protocol using an unlisted dialect still blocks — correctly. The safety property does not depend on coverage: an unrecognised revert never moves toward "guarded", by construction, and `test/guardDialects.test.ts` pins that boundary with more cases than it pins coverage.
- **`mint(uint256,address)` is one selector with two unrelated meanings.** It is Rocket Pool's privileged minter *and* ERC-4626's public `mint(shares, receiver)`. It is in the taxonomy marked `nameMatchSpecificity: "generic"`, and the probe tells the two apart on evidence (rETH's guard fires; sUSDe returns `InvalidAmount()`). Selectors are not names — worth re-checking for any future taxonomy addition.
- **Under-determination is now the dominant error mode.** 16 of 26 calibration protocols return `undetermined`, with named causes: custom authority schemes (5), provider-starved role enumeration (4), Compound's delegator pattern (2 — the marker names the Timelock but the route is not resolved), **an unevaluated privileged surface beside a privileged party (1 — Uniswap v3 Factory, see §13)**, an owner contract with no resolvable authority (1), Vyper's unrecognised dispatcher (1), Aave's governance shape (1), a custom access-control error (1). Against **0 false-clean results** this is the right way round, but it should be quoted honestly whenever coverage is described. (Compound III / Comet left this bucket on day 7: the fork differential turned its unevaluated `pause` into a fork-confirmed zero-notice restrictor, so it is now `no_notice` — see §14.)
- **The fail-closed revert classifier can, in principle, over-report.** Since day 6 an `eth_call` failure is treated as a contract revert only when positively identified as one; anything else becomes a loud `errors[]` entry. If some provider ever phrases a genuine revert in a way all four signals miss, Ripcord will report an infrastructure error where a revert occurred — visible, arguable, and blocking a reassuring verdict rather than enabling one. That is the deliberate direction: the alternative, which is what shipped for the first five days, was that an unrecognised *infrastructure* failure became a silent, permanently-cached "this contract has no owner." All three revert shapes present in the calibration set (`Error(string)`, custom errors, and reverts carrying no data at all) were confirmed live to be recognised before the change landed, and WETH9 — the true-negative control — cold-scans byte-identically under it.
- **No live monitoring.** Watchtower (alerting when a rule change is actually queued) is day-6 scope. The Exit Window metric landed on day 4 — see [The Exit Window](#the-exit-window).

---

## What's next

- **Harden and broaden the fork differential** — make inconclusive candidates fail closed, bind a clean tier to complete enumeration, then add independently validated ERC-4626, Lido queue and pausable-token archetypes. The Comet restrictor path is demonstrated; the general clean path is not yet a calibrated claim.
- **Watchtower** — live monitoring of timelock queues, alerting when a rule change is actually *queued* rather than merely possible. The natural next thing to build: everything it needs (the routes, the delays, the binding determination) already exists.
- **A block-explorer log source**, to sidestep the `eth_getLogs` range cap entirely and fully enumerate deep-history role sets like Aave's. Deliberately not done during the event: it is a new ingestion source, and it touches the pinned-and-cached determinism model every reproducibility claim here rests on.
- **The single highest-value infrastructure change** is a large-range `eth_getLogs` endpoint. On the 9-block-capped provider used for calibration, role reconstruction returns almost nothing on deep-history contracts — Aave's ACLManager provably has `POOL_ADMIN` and `FLASH_BORROWER` roles that Ripcord did not recover. It is correctly labelled every time, but it is a coverage hole, not just a speed problem.
