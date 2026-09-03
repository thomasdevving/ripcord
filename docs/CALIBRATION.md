# Ripcord — day-5 calibration

**26 mainnet protocols, chain 1, all pinned to block 25800000. Zero infrastructure errors.**

This document exists because a tool that flags everything is worthless, and a
tool that reassures you is dangerous. The only way to tell which one Ripcord is
is to run it against real protocols whose answers are independently checkable,
and then write down where it was wrong — including, especially, the places it
was wrong in the direction that flatters it.

Everything below sits on a cache that was deleted at the start of the day and
rebuilt cold. That is not a formality; see [Task 0](#0-the-determinism-gate).

---

## Contents

- [0. The determinism gate](#0-the-determinism-gate)
- [1. The set, and why these 26](#1-the-set-and-why-these-26)
- [2. Results at a glance](#2-results-at-a-glance)
- [3. The error Ripcord was making, and the fix](#3-the-error-ripcord-was-making-and-the-fix)
- [4. Per-protocol accounting](#4-per-protocol-accounting)
- [5. The rolePrivilege gate, both directions](#5-the-roleprivilege-gate-both-directions)
- [6. The disclosure gate's false-alarm rate](#6-the-disclosure-gates-false-alarm-rate)
- [7. Every tuning change made today](#7-every-tuning-change-made-today)
- [8. What this set does NOT establish](#8-what-this-set-does-not-establish)
- [9. The last false-clean vector: enumeration completeness](#9-the-last-false-clean-vector-enumeration-completeness)
- [10. The semantic cache audit (day 6)](#10-the-semantic-cache-audit-day-6)
- [11. Aave: a bounded answer, documented rather than bought](#11-aave-a-bounded-answer-documented-rather-than-bought)
- [12. The one blocker that looked like a real finding](#12-the-one-blocker-that-looked-like-a-real-finding)
- [13. The flagship green result that was wrong](#13-the-flagship-green-result-that-was-wrong)
- [14. Day 7: the fork differential](#14-day-7-the-fork-differential)

---

## 0. The determinism gate

Day 4 found that an infrastructure failure on `eth_call` had been cached as a
contract revert (KNOWN EDGE #14), and Ripcord reads a revert on `owner()` as
"this contract has no owner." A cache written before that fix could therefore
hold a network timeout that reads, permanently, as a false-clean result. Writing
calibration numbers on top of such a cache would risk publishing precisely the
failure class this tool exists to catch.

So, before any number in this document was recorded:

| Leg | What ran | Result |
|---|---|---|
| 1 | 8 fixtures, warm (pre-existing cache) | baseline captured |
| 2 | `.cache/` deleted, 8 fixtures re-run **cold** | **8/8 byte-identical to leg 1** |
| 3 | 8 fixtures re-run warm on the rebuilt cache | **8/8 byte-identical to leg 2** |

Zero reads changed from `reverted` to a value, so the old cache held no #14
poisoning. After the day's rule changes were made, the whole 26-protocol set was
re-run and re-verified:

| Leg | What ran | Result |
|---|---|---|
| 4 | 26 reports on the final ruleset, twice | **24/26 byte-identical** |
| 5 | the 2 remaining | differ **only** by `proof: {…}` vs `proof: null` — one run used `prove`, the other `scan` |
| 6 | Compound Comet `prove` run twice, independently | **byte-identical, including `totalUsd`** |

Re-run again after the enumeration-completeness fix (§9), this time with a full
cache wipe:

| Leg | What ran | Result |
|---|---|---|
| 7 | `.cache/` deleted, all 26 re-scanned **cold** | **24/26 byte-identical to warm**; the 2 are the same `prove`-vs-`scan` pair |
| 8 | cold build vs the final build | differs on **exactly 2** reports — the only two the post-cold gap-dedup touched, and only in `verdict.missing[]` |

Leg 8 is the honest accounting for a sequencing detail: one cosmetic fix (gap
deduplication) landed *after* the cold run, so the cold gate was measured on a
build one commit behind. Rather than assert the property transfers, the diff was
taken: the dedup is provably the only delta, and it is pure composition
downstream of every read, with no cache interaction.

Re-run once more on day 6, on the final code (fail-closed read classification,
structural gap dedup, schema 0.10.0), with a full cache wipe first:

| Leg | What ran | Result |
|---|---|---|
| 9 | `.cache/` deleted, all 26 re-scanned **cold** (48.5 min) | 26 reports, **0 errors** |
| 10 | all 26 re-run **warm** on the rebuilt cache (1.0 min) | **26/26 byte-identical** |
| 11 | day-6 reports vs the day-5 set, compared semantically | **0 of 26 differ** — no verdict, window, publishability, enumeration, `missing[]` or `unknowns[]` change |
| 12 | day-6 reports vs day-5, compared structurally | exactly **3 field paths added**, none removed: `enumeration.gaps[].site.{kind,id}` and `exitWindow.assessment.citedGapSites[]` |

Legs 9–10 are the strongest determinism result the project has recorded: day 5
managed 24/26 with two differing by `proof` present-vs-null, an artefact of
running `scan` and `prove` in different passes. The run is now driven from
`calibration/run-manifest.json`, which pins each target's mode, so the same
command produces the same set every time — **26/26**.

Legs 11–12 are the acceptance check for the day-6 changes, and they say the two
things that needed saying: the inverted read classifier changed **no result**
(every genuine revert in the set is still recognised as one), and the structural
dedup tighten changed **no `missing[]` content** — its entire effect is to make
the suppression key on identity instead of prose.

### One live catch, worth recording

The first cold pass produced a single `errors[]` entry, on stETH:

```
authorityIndirection: eth_call(0xae7ab9…) failed without any positive sign of a
contract revert — treated as an infrastructure failure, not as "this function
reverted"
```

Re-probing all 14 indirection getters against stETH afterwards classified every
one of them as a **revert**, correctly — so the failure was a genuine transient
infrastructure blip during the run, not a misclassification. Under the day-5
code that call would have been recorded, and permanently cached, as a revert:
`markers: []`, rendered as "checked, found none", on an Aragon contract whose
authority *is* an ACL. Instead the stage failed loudly,
`authorityIndirection` came back `null` — which CLAUDE.md defines as "cannot
rule out delegated authority", never as "none" — and a re-run produced a clean
report.

That is the day-6 fix catching, on its first outing, exactly the class of thing
it was built for. The re-run's report (0 errors, 14 getters probed, 0 markers) is
the one committed.

Leg 6 is worth stating separately: two independent ephemeral anvil forks
produced the same $540,604,938.71 to the cent, so the proof engine is
reproducible and not merely repeatable.

Reproduce any of it with `node scripts/compare-reports.mjs <dirA> <dirB>`, which
normalises `generatedAt` — the only intentionally non-deterministic field — and
diffs everything else byte-for-byte.

---

## 1. The set, and why these 26

Eight are the day 1–4 verification fixtures (`test/fixtures/targets.json`).
Eighteen are new (`calibration/targets.json`). Every address was verified live
at the pinned block before it entered the set — `identity` on each entry records
the exact read that established it (`scripts/identify.ts`, `scripts/identify2.ts`).
Nothing was taken from memory.

The eighteen were not chosen to make Ripcord look good. Four were chosen
specifically because their authority lives somewhere Ripcord does not model, so
that a wrong answer there would be **false-clean** rather than a visible false
alarm:

| Deliberate trap | Why it is a trap |
|---|---|
| **DAI** | Authority is the MakerDAO `wards` mapping. No `owner()`, no AccessControl. |
| **MKR** | `owner()` reads the **zero address** — the exact shape of "ownership renounced". It is not: DSChief holds power through `authority`. |
| **Balancer Vault** | Every permission lives in a separate `TimelockAuthorizer` reached via `getAuthorizer()`. No owner, no roles, no proxy. |
| **stETH** | An Aragon `AppProxyUpgradeable` behind Lido's Kernel/ACL — upgradeable through neither EIP-1967 nor Ownable nor AccessControl. |

Three more (Aave v3 ACLManager, Lido Withdrawal Queue, Ethena Minting) were added
**after** the first run, when it turned out the original fifteen contained *zero*
OpenZeppelin AccessControl contracts — so the day-4 `rolePrivilege` gate was never
exercised and its false-negative rate could not have been measured. That is a
coverage fix, not result-shopping: they were picked for having many roles, before
their reports existed.

---

## 2. Results at a glance

| Verdict | Count | Protocols |
|---|---|---|
| `immutable_within_checks` | 2 | WETH9, wstETH |
| `can_exit_in_time` | **0** | none — see [§13](#13-the-flagship-green-result-that-was-wrong) |
| `no_notice` | 7 | USDC, cbETH, FXS, Morpho Blue, PAID ×2, **Compound Comet cUSDCv3** |
| `trapped` | 1 | Ethena sUSDe |
| `undetermined` | 16 | DAI, MKR, Balancer, rETH, stETH, USDT, Curve 3pool, Compound cDAI, Compound Unitroller, Aave PoolAddressesProvider, Aave ACLManager, Lido Withdrawal Queue, Wasabi, Uniswap v3 Factory, **Ethena USDe, Ethena Minting** |

The last two moved there after calibration, and they are the subject of [§9](#9-the-last-false-clean-vector-enumeration-completeness).

**26 reports · 0 errors · 22 publishable · 4 blocked by the disclosure gate.**

The headline number for a security audience is this one:

> **False-clean results after day 5: 0 of 26.**
> Ripcord's remaining error mode is *under-determination* — it says "I could not
> establish this" on 16 of 26 protocols — not false confidence.

That trade is deliberate and it is the right way round. An under-determination is
visible, arguable, and appears in the report where someone can dispute it. A
false clean bill is invisible by construction.

---

## 3. The error Ripcord was making, and the fix

Calibration found exactly one optimism-direction bug, and it was in the last
layer anyone would think to look at.

### What was wrong

The exit-window assessment had a status called `no_rule_change_route_found`, and
the verdict rendered it as:

> "**No exit-window risk was identified**: no upgrade path, owner, role or
> attributed privileged capability was found…"

That sentence treats **the absence of a found route as the absence of a route**.
Those are two different claims, and collapsing them let "unknown is never safe" —
the rule the whole project is built on — leak back in at the very end, where it
is hardest to see. The caveats were present and the confidence was `medium`, but
the sentence a human reads first said *no risk*.

It fired on three contracts and was substantively wrong on two:

| Contract | Ripcord said | Reality |
|---|---|---|
| Balancer Vault | no risk identified | `getAuthorizer()` → a TimelockAuthorizer holding **every** permission over the Vault |
| rETH | no risk identified | callers checked against a RocketStorage registry; `mint` is privileged |
| wstETH | no risk identified | **correct** — genuinely no authority |

**2 of 3 wrong, in the one direction that matters.**

### The fix: an epistemic split, not a rewording

Rewording the sentence would have fixed the symptom. The status itself was the
bug, so it was split into two epistemically different outcomes and the **default
was inverted**:

- **`immutable_within_checks`** — a *positive* claim, which must be **earned**.
  It carries a `basis[]` of the reads that earned it, and `caveats[]` naming its
  bound.
- **`undetermined`** — everything else, reached by falling through. "Clean" is
  now a claim requiring evidence; "I don't know" is the safe default.

A contract only reaches `immutable_within_checks` when **all** of these hold:

1. `proxy.pattern === "not_a_proxy"` — no DELEGATECALL in the runtime bytecode,
   so the code cannot be replaced. *(bytecode evidence, the strongest available)*
2. the dispatcher was decoded, so the function set was actually enumerated;
3. no authority-indirection marker resolved *(new — see below)*;
4. no capability finding **and** no entry needing manual verification;
5. `owner()`, `pendingOwner()` and AccessControl all came back empty.

Miss any one and the report says `undetermined` and names which check failed.

### The cheap detection win that came with it

`src/detect/authorityIndirection.ts` detects the **existence** of an authority
indirection without resolving it — 14 zero-argument getters (`getAuthorizer()`,
`authority()`, `acl()`, `admin()`, `governor()`, …), each counting only when it
returns a **non-zero address**. Ripcord never calls into what it finds. The mere
presence forces `undetermined`.

It fired on 7 of 26, and every hit is correct and useful:

| Protocol | Marker | Points at |
|---|---|---|
| Balancer Vault | `getAuthorizer()` | TimelockAuthorizer `0x6048A8c6…` |
| **MKR** | `authority()` | DSChief/pause `0x6eEB68B2…` — the false-clean trap, caught |
| Aave PoolAddressesProvider | `getACLManager()` | `0xc2aaCf65…` — which is another target in this very set |
| Compound cDAI | `admin()` | Compound Timelock `0x6d903f60…` |
| Compound Unitroller | `admin()` | Compound Timelock |
| Compound Comet | `governor()` | Compound Timelock |
| cbETH | `admin()` | `0xEeE4Ac8A…` |

### Result

Both false-cleans are gone; the true negative survived.

- Balancer Vault → `undetermined`, naming the authorizer it refuses to follow.
- rETH → `undetermined` (via a different route, below).
- wstETH → still `immutable_within_checks` — and its basis was independently
  confirmed by deriving **all 21** of its selectors: ERC20 + permit +
  wrap/unwrap/getters, not one privileged function.

rETH was fixed by a second finding rather than by the marker, and this is worth
saying plainly because it is a residual limitation: **rETH exposes no indirection
getter at all.** Its registry is bespoke. It was caught only because
`mint(uint256,address)` was missing from the taxonomy — adding it produced a
capability whose guard probe returned Rocket Pool's `"Invalid or outdated
contract"`. Had rETH lacked a privileged function in the taxonomy, the inverted
default would still have held it at `undetermined`, but the marker probe would
not have explained *why*. **A bespoke registry that exposes no getter remains
invisible**, and `immutable_within_checks` is bounded accordingly, in the status
name and in every rendered page.

---

## 4. Per-protocol accounting

Verdict correctness judged against the on-chain reality, not against what would
be convenient. "Direction" says which way an error leans.

### Correct, and confidently so — a determined verdict, and the right one (10)

| Protocol | Verdict | Why it is right |
|---|---|---|
| WETH9 | `immutable_within_checks` | No admin of any kind. The honest control case. |
| wstETH | `immutable_within_checks` | All 21 selectors derived and checked; none privileged. |
| Ethena sUSDe | `trapped` | 1-day cooldown vs 1-day notice — an exact dead heat, margin 0. |
| USDC | `no_notice` | Upgradeable proxy, admin is a plain EOA, no delay anywhere. |
| cbETH | `no_notice` | Same shape, single custodian. |
| FXS | `no_notice` | `DEFAULT_ADMIN_ROLE` → a 3-of-5 Safe. A threshold is not a delay. |
| Morpho Blue | `no_notice` | Immutable code, live owner → Safe. Narrow power, zero notice. |
| PAID proxy 1 (`0x1614f18f…`) | `no_notice` | Two zero-notice routes, both terminating at plain EOAs — **and** `paused()` reads **true** at the pinned block, so the exit is not slow, it is shut. |
| PAID proxy 2 (`0x8c8687fc…`) | `no_notice` | Two zero-notice routes, same shape. `paused()` reads **false** here; its `blockable` is `undetermined`. Disclosure-blocked, so no published page. |
| Compound Comet cUSDCv3 | `no_notice` | Its upgrade path is protected by a proven-binding 2-day timelock, but the day-7 fork differential demonstrates a separate zero-notice route: the 5-of-9 pause-guardian Safe closes withdrawals and the baseline exit then reverts. |

### Correct, and the desired answer, on the four deliberate traps (4)

| Protocol | Verdict | Note |
|---|---|---|
| DAI | `undetermined` | `wards` is unmodelled; a privileged capability was detected but no holder attributed. Never a clean bill. |
| MKR | `undetermined` | `owner() == 0x0` was **not** read as "renounced". `authority()` marker names DSChief. |
| Balancer Vault | `undetermined` | Names `getAuthorizer()` and refuses to follow it. |
| stETH | `undetermined` | Aragon proxy detected as `pattern: unknown`; the isProxy branch forces undetermined. |

### Correct but under-determined — Ripcord knows less than an auditor would (12)

These are **false negatives in usefulness, not in safety**. Each says "I could
not establish this" about something a human can establish.

| Protocol | Layer that fell short | Direction |
|---|---|---|
| Compound cDAI | Compound's delegator pattern (`admin()` + `implementation()` as plain getters) is not an authority route Ripcord resolves — though the marker now **names** the 2-day Timelock. An auditor would say "healthy". | conservative |
| Compound Unitroller | Same. | conservative |
| USDT | `owner()` resolves to a contract whose own authority terminates `no_authority_found`. An auditor would say "zero notice, owner can pause and blacklist". | conservative |
| Curve 3pool | Vyper: `dispatcherRecognized: false`, 0 selectors recovered. Ripcord correctly refuses every downstream claim. | conservative |
| Aave PoolAddressesProvider | KNOWN EDGE #17 — the delay lives in the PayloadsController, keyed by access level. | conservative |
| Aave v3 ACLManager | Role reconstruction starved by the provider's 9-block `eth_getLogs` cap (below). | conservative |
| Lido Withdrawal Queue | `proxyAdmin` terminates at a contract with no resolvable authority. It *did* correctly detect the real two-step exit path (`requestWithdrawals → claimWithdrawals`) as an **unmeasured** leg. | conservative |
| rETH | Caught only via a taxonomy addition; the bespoke registry itself is undetectable. | conservative |
| Wasabi | Access control is a custom error Ripcord cannot identify; correctly blocked from publication. | conservative |
| **Ethena USDe** | Its single route terminates at a `TimelockController` whose OWN roles were only partially enumerated, so the completeness witness is withheld and `binding` degrades to `not_proven_binding`. Before [§9](#9-the-last-false-clean-vector-enumeration-completeness) this read `can_exit_in_time`. | conservative |
| **Ethena Minting** | Its own role scan covered 6,750 of 5.66M blocks. Same degradation, one layer shallower. Before §9 this read `can_exit_in_time`. | conservative |
| **Uniswap v3 Factory** | Same rule: 7 unevaluated selectors beside a timelock owner. No kill switch is known here; the point is that Ripcord cannot rule one out. | conservative |

**The groups sum to 26**: 10 determined-and-correct + 4 deliberate traps + 12
under-determined. All 16 `undetermined` verdicts are the 4 traps plus the 12
above; every figure in this section is re-derivable with
`node scripts/summarize.mjs calibration/reports`.

### False positives (alarm where there is none): 0

No protocol was reported as `no_notice` or `trapped` that is not, in fact,
subject to a zero-notice authority or a genuine dead heat.

### False cleans: 0

After the day-5 fix. Before it: 2 (Balancer, rETH).

---

## 5. The rolePrivilege gate, both directions

The day-4 gate (KNOWN EDGE #18) requires real evidence before an AccessControl
role route counts as authority: it must be `DEFAULT_ADMIN_ROLE`, administer
another role, or have a capability guard attributed to its hash. Anything else is
`unverified` and contributes `undetermined` rather than a proven zero notice.

The two failure directions are **not symmetric**, and only one of them is
dangerous:

- marking a benign role as privileged = a false alarm. Visible, arguable.
- marking a genuinely privileged role as `unverified` = **real power silently
  disappearing from the report**. Invisible by construction.

So every `unverified` route in the set was hand-verified against on-chain
reality.

### The verification

Three routes across the set are `unverified`, all on Ethena sUSDe, all the role
`0x0a4af4bc…`.

**Step 1 — identify the role by derivation, not recognition.**
`keccak256("FULL_RESTRICTED_STAKER_ROLE")` = `0x0a4af4bcc1942295207d9f047442ebdae6170a6e324850f758b14cf99b65c3bd`. Match.

**Step 2 — establish what it does behaviourally.** Rather than reading source, a
raw `eth_call` of `transfer(0x…dEaD, 0)` at the pinned block, from each of the
three role holders and from one unrelated address:

```
from 0x8ED543D0…  -> REVERT 0xf50a3b52   (OperationNotAllowed())
from 0x8188af46…  -> REVERT 0xf50a3b52
from 0x1AdF6f82…  -> REVERT 0xf50a3b52
from 0x30bf2465…  -> OK     0x…0001      (an unrelated address CAN transfer)
```

The three role holders **cannot even move their own tokens**, while an unrelated
address can. The role does not grant power — it *removes* it. They are
blacklisted users. The gate's `unverified` is not merely correct here, it
understates the case.

### The number

> **rolePrivilege gate false-negative rate: 0 of 3 (0%).**
> 3 `unverified` routes checked by hand; 0 turned out to confer any privilege.
> In the positive direction: 1 route (`DEFAULT_ADMIN_ROLE` on FXS → a 3-of-5
> Safe) was marked `verified`, and is genuinely privileged. 0 false positives.

**And the honest caveat, which matters more than the number.** The denominator is
3, and it is small for a reason worth stating: on this provider the gate barely
gets any input at all.

The Alchemy key in use caps `eth_getLogs` at **9 blocks**. Role-hash discovery is
an event replay, so on a deep-history contract the ~1500-request budget covers
only a recent window — for Aave's ACLManager, blocks 25793250–25800000 out of a
history starting far earlier. All three AccessControl targets added specifically
to exercise this gate came back with **only `DEFAULT_ADMIN_ROLE`**:

| Contract | Roles reconstructed | Reconstruction label |
|---|---|---|
| Aave v3 ACLManager | 1 (`DEFAULT_ADMIN_ROLE`, 0 members) | `complete: false`, confidence **low** |
| Lido Withdrawal Queue | 1 (`DEFAULT_ADMIN_ROLE`, 1 member) | `complete: false`, confidence **medium** (Enumerable membership authoritative) |
| Ethena Minting | 1 (`DEFAULT_ADMIN_ROLE`, 0 members) | `complete: false`, confidence **low** |

Aave's ACLManager provably has more: `POOL_ADMIN_ROLE()` and
`FLASH_BORROWER_ROLE()` both resolve on-chain and match
`keccak256("POOL_ADMIN")` / `keccak256("FLASH_BORROWER")` by derivation. Ripcord
found neither. **At least 2 known roles were missed on that one contract.**

This is a *reconstruction*-layer limitation, not a gate limitation, and it is
correctly labelled — every one of those reports carries `complete: false`, a
lowered confidence, and the exact covered block window, and the rendered pages
show that label and window rather than hiding it. But it means the gate's 0/3
should be read as "0 of the 3 it was actually given", and a larger `eth_getLogs`
range is the single highest-value infrastructure change available to this
project.

---

## 6. The disclosure gate's false-alarm rate

The gate blocks publication when a capability probe sees no recognised auth
revert, because probing cannot distinguish "guarded by a scheme Ripcord doesn't
know" from "not guarded at all" — and publishing the second reading would be a
vulnerability claim about a live contract.

All 30 blockers across the 26 pre-change reports were decoded and
hand-classified. (Every one was read out of the report's own `probes[]`
evidence — `node scripts/manual-verification-audit.mjs <dir>` reproduces the
table.)

| Class | Count | Meaning |
|---|---|---|
| **Demonstrably guarded**, in a dialect Ripcord could not read | **22** | The contract said so in its own revert string |
| Probe rejected **before** any auth check could run | 4 | Ripcord's own zero-valued argument coming back |
| Unrecognised custom error | 3 | Genuinely undetermined — correctly still blocking |
| **Call executed with no revert at all** | 1 | PAID proxy 2's `mint`. Resolved on day 6 as a no-op stub — see [§12](#12-the-one-blocker-that-looked-like-a-real-finding) |

> **Genuinely unguarded privileged functions found: 0 of 30.**
> **Gate false-alarm rate: 26 of 30 (87%)** — that is, 26 blockers carried no
> unguarded reading at all, once the revert was actually read.

The 22 were contracts stating plainly that a guard had fired:

```
"Blacklistable: caller is not the blacklister"      Circle FiatToken (USDC, cbETH)
"Pausable: caller is not the pauser"                Circle FiatToken
"FiatToken: caller is not a minter"                 Circle FiatToken
"Rescuable: caller is not the rescuer"              Circle FiatToken
"Dai/not-authorized"                                Maker ds-auth
"AccessControl: sender must be an admin to grant"   OpenZeppelin v3
"AccessControl: can only renounce roles for self"   OpenZeppelin v3/v4
"not owner"                                         Morpho Blue
"You are not an owner or the governance timelock"   Frax
"Only frax pools can mint new FRAX"                 Frax
"Invalid or outdated contract"                      Rocket Pool
OnlyMinter()                                        Ethena (custom error, 0x9cdc2ed5)
```

The self-renounce string is worth a note of its own: `"AccessControl: can only
renounce roles for self"` is an *authorisation* check — it establishes that the
caller may only act on itself, which means the function confers no power over
anyone else. It accounted for 3 of the 22 on its own (Aave ACLManager, Lido
Withdrawal Queue, FXS).

Recognising these is the *same evidence class* as the four shapes day 2 already
knew: the contract itself is the witness. So `src/detect/guardDialects.ts` now
knows them — **13 dialect entries, 9 authorisation families and 4 pre-auth
families** — and the manual-verification list fell from **30 entries to 9**, of
which only **4 still block**. Publishable reports went from **13 of 26 to 22 of
26**.

**The boundary that makes this safe.** The dictionary may only ever move a
**recognised** revert toward "guarded". There is deliberately no rule anywhere
that reads "we did not recognise it, so assume it is guarded" — that inference is
how a tool builds a false-clean result. Unrecognised stays unrecognised and keeps
blocking. Every pattern is anchored (`^…$`), never a substring test, so an
unrelated message cannot embed a guard phrase; `test/guardDialects.test.ts` pins
that boundary with more cases than it pins coverage.

A recognised dialect yields `guarded_unknown_holder`, **never** `attributed` —
these dialects name no holder, so no holder is claimed.

**This is an in-sample number, and it should be read as one.** The dialects were
found by reading this set's reverts. The claim is "the dictionary knows these 13
dialect entries", never "Ripcord recognises guards in general". A
protocol using an unlisted dialect still blocks, correctly — Wasabi still does.

### Which reports remain blocked, and why that is right

| Report | Blocker | Assessment |
|---|---|---|
| Wasabi | `upgradeToAndCall` → `0xf07e038f` carrying the caller | Auth-*shaped* to a human, unidentified to the tool. A 210-candidate signature scan failed to name it. Correctly blocked. |
| PAID proxy 2 | `mint(address,uint256)` → **the call SUCCEEDS**, no revert at all | The strongest-looking observation in the set, and the reason the gate exists. Investigated to state level on day 6 (§12): it is a **no-op stub** — it succeeds for any caller *including the owner* and changes nothing. Not a vulnerability, and not a privileged function either. Correctly blocked while unresolved. |
| Ethena sUSDe | `renounceRole` → `OperationNotAllowed()` (`0xf50a3b52`) | Ethena appears to disable the function outright — but that cannot be *proven* from a probe, because the identical error is also what its blacklist enforcement returns (confirmed while verifying the restricted-staker role in §5). Correctly blocked. |
| Ethena Minting | `renounceRole` → `0x6317a0fa` | An unidentified custom error; a 210-candidate signature scan did not name it. Correctly blocked. |

**The gate was not softened to unblock a demo target.** sUSDe is the dead-heat
showcase and it remains unpublishable; its page is not in `site/`. The
cleared-registry was likewise **not** extended to cover a target's own findings —
CLAUDE.md's rule that the published set is filtered on `disclosure.publishable`,
"never on someone's per-protocol judgement under time pressure", was applied as
written.

---

## 7. Every tuning change made today

Each change removes a *demonstrable* error, with the evidence that demonstrated
it. `schemaVersion 0.7.0 → 0.8.0`, `rulesetVersion 0.6.0 → 0.7.0`.

| # | Change | Evidence that forced it | Direction |
|---|---|---|---|
| 1 | Split `no_rule_change_route_found` into `immutable_within_checks` (positive, earned) and `undetermined` (the default) | Balancer + rETH read as "no risk identified" | toward caution |
| 2 | New `src/detect/authorityIndirection.ts`: 14 getters, non-zero address required, never followed | Balancer's `getAuthorizer()`; MKR's `authority()` | toward caution |
| 3 | Verdict statement for the positive status now leads with the **basis**, and its caveats populate `verdict.missing[]` | The old sentence opened "No exit-window risk was identified" | toward caution |
| 4 | New `src/detect/guardDialects.ts`: 13 anchored, versioned dialect entries, each with live provenance | 22 of 30 blockers were demonstrably guarded | toward accuracy; cannot create a guard |
| 5 | Split the manual-verification reason into `no_auth_revert_observed` (blocks) and `reverted_before_auth_check` (does not) | 4 blockers were Ripcord's own zero-valued arguments coming back | narrows the gate to what it is for |
| 6 | Added `mint(uint256,address)` to the taxonomy | rETH's privileged minter was invisible | toward caution |
| 7 | Marked that entry `nameMatchSpecificity: "generic"` | The **same selector** is ERC-4626's public `mint(shares, receiver)`; sUSDe returned `InvalidAmount()` | prevents a new false alarm |
| 8 | Classified `InvalidAmount()` as pre-auth | Read live on sUSDe at the pinned block | narrows the gate |

Tests: **179 passing**, up from 154. The new ones are weighted toward *boundaries*
rather than coverage — that an unrecognised revert stays unrecognised, that a
null indirection check is treated as "could not rule out" rather than "none",
that an undecodable dispatcher cannot support an immutability claim.

---

## 8. What this set does NOT establish

- **26 protocols is not a statistical sample.** It is a deliberately-chosen
  spread including four adversarial cases. Treat every rate here as a
  description of this set.
- **The dialect numbers are in-sample** (§6). The 87% false-alarm figure
  describes the blockers *this set* produced; a protocol with an unlisted
  dialect still blocks, as Wasabi still does.
- **The rolePrivilege denominator is 3**, and small because the provider starved
  the role reconstruction (§5).
- **One chain, one block.** Everything is mainnet at 25800000.
- **Liquidity depth is still not modelled at all**, so every time-to-exit is a
  floor. For a position large relative to available liquidity the real figure is
  longer, never shorter.
- **16 of 26 are `undetermined`.** That is honest, and it is also a lot. The
  named causes are: custom authority schemes (5), Compound's delegator pattern
  (2), provider-starved role reconstruction (2), an unresolvable contract owner
  (1), Vyper (1), Aave's governance shape (1), a custom access-control error (1).
  Each is a concrete, addressable gap rather than a mystery.
- **`immutable_within_checks` is bounded by its own name.** It means no route was
  found *within the checks listed in its `basis`*. A bespoke registry exposing no
  getter — Rocket Pool's shape — is invisible to all of them.


---

## 9. The last false-clean vector: enumeration completeness

Calibration closed one optimism-direction bug (§3). Auditing what remained found
a second, of the same family but a layer lower, and it was live on two of the 26.

### The concern

The exit window is the **minimum** notice across all authority routes. That
arithmetic is only sound over a route set that was **fully seen**. Role
enumeration goes partial routinely — a provider that caps `eth_getLogs` turns the
event replay into a bounded recent window (§5) — and the reconstruction is
correctly labelled partial when it does. The open question was whether that label
*propagated*: if an un-enumerated role holds a zero-notice power, the minimum is a
minimum of the wrong set, and the verdict comes out reassuring about a protocol
nobody can leave in time.

### The trace

`reconstruction.complete` was written by `accessControl.ts` and read by **nothing
downstream**. `build.ts` forwarded only `.roles` — the bare array — to capability
detection, to authority resolution, and to `analyseExitWindow`. The flag reached
the report as a **display field**; the verdict could not act on it. One seam,
three consumers.

### Two live instances, and why the second one matters more

| Protocol | What the report said | What was actually enumerated |
|---|---|---|
| **Ethena Minting** | [was] `can_exit_in_time`, window `binding` at confidence **high**, `missing: []` | its own scan covered **6,750 of 5.66M blocks** and recovered only `DEFAULT_ADMIN_ROLE` (0 members) |
| **Ethena USDe** | [was] `can_exit_in_time`, window `binding`, `missing: []` | **not an AccessControl contract at all** — the partial scan is on its **depth-1 TimelockController** |

The second is the one that shaped the fix. A target-only completeness check calls
Ethena USDe complete and closes only the shallow leak. But its single authority
route terminates at a `TimelockController` whose own roles were partially
enumerated — and a timelock's `PROPOSER` / `EXECUTOR` / `TIMELOCK_ADMIN` holders
are precisely what "this delay is binding" rests on. The witness therefore had to
be an **aggregate over every route at every depth**, not a flag on the target.

`missing: []` on both is the sharpest tell: each report positively asserted that
nothing was missing while its own reconstruction block said the role set might be
incomplete. Internally self-contradicting, quite apart from the false-clean.

### The fix

Four parts, none of them a runtime check that can be forgotten:

1. **Fail-closed derivation** (`src/report/enumeration.ts`). `complete` is a
   *positive* claim — true only where every site positively said so. A missing
   reconstruction, an `undefined` flag, a stage that threw, a contract whose
   deployment block could not be found: all incomplete. Strict `=== true`
   throughout, never `!== false`. Reading an absent flag as "complete" would
   launder a failed read into a fact — the exact bug class being closed, rebuilt
   inside its own fix, in the one place nobody would look again.
2. **Aggregation over everything the verdict rests on**: the target, every
   authority node at any depth (`AuthorityNode` gained `accessControlDetected` +
   `roleEnumeration` — two fields, so "positively not AccessControl" is never
   confused with "we failed to enumerate"), every dependency token, and the
   stages themselves. A failed stage is read from `errors[]`, never from the
   fallback value that replaced it.
3. **Structural enforcement.** `binding` and `immutable_within_checks` now carry
   `enumeration: { complete: z.literal(true) }` and are *unconstructable*
   without it — zod and `tsc` refuse, the same technique `GuardStatus` uses to
   stop a capability claiming an unevidenced holder. `binding` degrades to
   `not_proven_binding`, which keeps the observed figure and already means
   "binding-ness **or another route** is unresolved"; `immutable_within_checks`
   degrades to `undetermined`.
4. **Caution-only, preserved.** `no_notice` and `trapped` are untouched: unseen
   routes can only *add* ways to change the rules, and an extra route can only
   *lower* the minimum. An incomplete enumeration can never make a bad finding
   safer. `not_proven_binding` can still reach `trapped`.

Plus: `composeVerdict` appends every gap to `missing[]` on **every** branch, so
no report can ever again claim `missing: []` while contradicting itself.

### Result

| | Before | After |
|---|---|---|
| Verdicts changed | — | **2**, both `can_exit_in_time` → `undetermined` |
| Moved from a bad finding toward reassurance | — | **0** |
| Enumerate completely | not tracked | 20 of 26 |
| Reassuring verdicts remaining | 6 | 4 — Comet, Uniswap v3 Factory, WETH9, wstETH, **all with a complete witness** |

Nothing was over-capped: every reassuring verdict that survived did so on a
positively complete enumeration, and both demo protocols (Compound Comet, PAID)
are unaffected.

### Guarded three ways, so the class cannot return

- **Simulated-cap unit tests.** The provider cap is faked, so the regression
  guard is deterministic and does not rot when an endpoint changes. Includes the
  control — identical routes, identical delay, only the witness differs — which
  is what proves the gate is doing the work.
- **Fail-closed derivation tests**, weighted toward the non-answers rather than
  the clean case, including an `undefined` completeness flag that should never
  occur and is handled safely regardless.
- **Gap deduplication by SITE**, so a gap the assessment already named is not
  restated in slightly different words. Found by reading the output of the fix on
  the very report it exists to communicate.
- **A report-level invariant** in `scripts/verify-pages.mjs`, run in CI over
  every report: no reassuring verdict or window on any incomplete enumeration
  anywhere, and no empty `missing[]` beside an incomplete reconstruction. It
  derives incompleteness **independently** of `enumeration.ts`, so a bug in the
  derivation cannot hide itself, and it cross-checks the two derivations against
  each other. This is the report analogue of the byte-identity determinism gate:
  it makes the whole class impossible rather than pinning one instance.

**Ripcord's "0 false-clean" property is now robust to enumeration gaps, not
merely true of the reports that happened to enumerate completely.**

---

## 10. The semantic cache audit (day 6)

Four defects had entered the project through one seam — the cache boundary — so
day 6 opened by auditing it deliberately rather than waiting for a fifth. It
found one, and it was live.

### The two failure modes, and why only one was already covered

| Mode | What goes wrong | Caught by |
|---|---|---|
| **Structural** | a cache miss and a hit differ in type or shape, so behaviour depends on whether someone ran the scan before | the determinism gate: cold report must be byte-identical to warm (§0) |
| **Semantic** | a read that FAILED is stored, and read back, as an "absent fact" | **nothing** — until this audit |

The second is the more dangerous, and the determinism gate is structurally
incapable of catching it: a consistently-wrong report is byte-identical cold and
warm. That is precisely why it survived five days.

### The finding

`PinnedChain.call` and `probeCall` asked: *does this failure look transient?* If
not, the failure was recorded — and permanently **cached** — as
`reverted: true`. That is fail-**open**, and it matters because roughly twenty
detectors downstream read a revert as a fact about the *contract*:

```
owner() reverted              -> this contract has no owner
DEFAULT_ADMIN_ROLE() reverted -> this is not an AccessControl contract
balanceOf() reverted          -> the target holds none of this token
```

Three realistic infrastructure failures were reproduced against a live endpoint
(`scripts/audit-error-shapes.ts`). **None of them matched a single transient
pattern**, so all three were being laundered into an absence of authority:

| Failure | What the node actually returns |
|---|---|
| bad or expired API key | `-32600` · `"Must be authenticated!"` |
| unreachable endpoint | *(no code)* · `"fetch failed"` / `"bad port"` |
| block not available | `-32001` · `"block not found: 0x…"` |

The third is the one to dwell on. **Every Ripcord read is pinned to a historical
block**, so a non-archive endpoint fails in exactly that way — and would have
produced a complete, schema-valid, confidently *clean* report in which every
contract has no owner, no roles and no capabilities. Reached through the cache
rather than through a detector, byte-identical cold and warm, and permanent once
written.

### The fix: inversion, not a longer pattern list

Adding those three strings to the transient list would have fixed three cases
and left the class open, because the residual is unbounded — it is every failure
mode of every provider nobody has met yet. So the question was **inverted to
fail-closed**: a result is a revert only when something *positively* says so;
everything else is infrastructure and throws.

The four positive signals were derived from live observation rather than memory,
the same rule the project applies to slots, selectors and guard dialects:

1. raw revert bytes anywhere in the cause chain;
2. viem's `ExecutionRevertedError` in the chain;
3. an RPC error carrying EIP-1474 code `3`;
4. the node's own `execution reverted` message.

Every genuine revert observed carries **2, 3 and 4 together** — including the
ones with no revert data at all (KNOWN EDGE #4's USDT case) and custom-error
reverts (sUSDe's `OperationNotAllowed()`). That is what makes a tight classifier
safe for this set rather than merely better in theory. Deliberately excluded:
viem's regex also matches `"gas required exceeds allowance"`, which is a gas
configuration problem, not a contract decision.

The cost runs the right way. A genuine revert phrased in some way all four
signals miss now becomes a loud `errors[]` entry instead of a silent absence —
visible, arguable, and blocking a reassuring verdict through the enumeration
witness.

### The rest of the sweep

Every path where a read can fail or return nothing was walked, and each either
got a fix or a comment explaining why the conflation is impossible there.

| Path | Verdict | Action |
|---|---|---|
| `owner()` / `pendingOwner()` reverts | safe — explicit `address: null` **with** the reason and evidence attached | regression test added |
| role scan fails at the target | safe — throws, lands in `errors[]`, enumeration witness withheld | regression test added |
| role scan fails at **recursion depth ≥ 1** | safe — the `.catch(() => null)` removed in the consolidation pass is still gone | regression test added, because this is the seam that broke before |
| `getRoleMemberCount` reverts mid-enumeration | **fixed** — was `members: []` silently, on a contract already *positively* established as Enumerable; a role that vanishes is a route that vanishes | now records an unknown |
| `getRoleAdmin` reverts | safe — `null` costs the role its privilege evidence, pushing it to `unverified`, which *blocks* a binding window rather than enabling one | comment added |
| capability probe fails | safe — throws; a probe returning nothing interpretable is `inconclusive`, never "no capability" | covered |
| timelock delay read fails | safe — both paths lead to zero credited notice (route modelled immediate, or `cannot_determine`) | comment added |
| dependency `balanceOf` reverts | **fixed** — was `continue`, reporting the target as holding nothing; also removed that token's own capabilities from the report and could flip the disclosure gate | now records an unknown |
| oracle getter undecodable | **fixed** — silent `continue` | now records an unknown |
| pause getter undecodable | **fixed** — `currentlyBlocked` stayed null, i.e. "not paused"; on PAID that is the single most consequential fact in the report | now records an unmeasured leg |
| beacon `implementation()` undecodable | safe — proxy-ness comes from the storage slot; capabilities.ts already raises an explicit unknown | comment added |
| proof cannot run | safe — `produced: false` always carries a `failureReason`; the trace-artefact `catch` only nulls the artefact | covered |

**Result: 24 new tests** (`test/readFailures.test.ts`), including the wiring
end-to-end through a stub JSON-RPC server which asserts that a failed read is
**not written to the cache at all** — the property that made this class of bug
permanent rather than transient.

### The structural dedup tighten

Folded into the same pass. The verdict's enumeration-gap deduplication was
matching each gap's `where` string as a **substring** of every `missing[]`
entry. That behaves on the current 26 by an accident of wording: `where` for the
target is the bare word `"target"`, so any unrelated sentence mentioning a target
would have suppressed a real enumeration gap — under-reporting what was not seen,
which is the failure this subsystem exists to prevent, arrived at through a
cosmetic tidy-up.

Gaps now carry a structural `site: { kind, id }`, the exit-window assessment
publishes the canonical **keys** of the sites it already narrated
(`citedGapSites`), and the verdict dedups on key equality. A suppression can now
only ever collapse the two representations of the *same* site.

**Effect on the 26: none.** Verdicts, statuses and `missing[]` contents are
unchanged; the diff is the two added schema fields. `schemaVersion 0.9.0 →
0.10.0`, `rulesetVersion 0.8.0 → 0.9.0`.

---

## 11. Aave: a bounded answer, documented rather than bought

Day 6 planned to spend a paid endpoint on making Aave's `ACLManager` enumerate
fully, turning an `undetermined` into a complete report. That run was
**deliberately not made**, and the reasoning is worth recording because it is a
judgement about what the tool is for.

Aave-as-`undetermined` is not the tool failing. It is the tool doing exactly what
[§9](#9-the-last-false-clean-vector-enumeration-completeness) was built to make
it do: refusing to issue a verdict over a half-enumerated power structure.
Spending money to erase that would have removed the clearest live demonstration
of the project's own thesis, on a marquee protocol.

So the coverage gap is documented precisely instead, with every figure
independently checkable:

| Fact | Value | How established |
|---|---|---|
| Roles provably present | **5** — `POOL_ADMIN`, `FLASH_BORROWER`, `EMERGENCY_ADMIN`, `RISK_ADMIN`, `BRIDGE` | each getter resolves at the pinned block; each hash matches `keccak256(preimage)` **by derivation** |
| Roles Ripcord recovered | **1** — `DEFAULT_ADMIN_ROLE`, 0 members | `authority.accessControl.roles` |
| `AccessControlEnumerable`? | **No** — `getRoleMemberCount` reverts | membership is reachable *only* by event replay |
| History | 9,508,883 blocks (16,291,117 → 25,800,000) | deployment block by binary search over `getCode` |
| Provider range | **9 blocks** | probed live at startup |
| History covered | 6,750 blocks = **0.071%** | `reconstruction.scannedFrom/ToBlock` |
| Range needed | **≥ 12,696 blocks** | `history ÷ (budget/2 − 1)`, budget 1500 |

Note this corrects a figure quoted earlier in the project: the "~19k blocks"
requirement is **FXS's** number (14.3M-block history). ACLManager specifically
needs ≥ 12,696.

So Ripcord knows *which* roles exist and cannot learn *who holds them* at this
range. It labels the reconstruction `complete: false, confidence: low` with the
exact covered window; the label propagates into the enumeration witness; the
witness is withheld; the reassuring assessment variants become structurally
unconstructable; the verdict falls through to `undetermined`.

**What would fix it:** an endpoint with an `eth_getLogs` range ≥ ~12,700 blocks,
or a raised `MAX_LOG_REQUESTS`. Nothing in the ruleset changes — this is
coverage, not detection. It is deliberately *not* fixed by teaching Ripcord an
Aave-shaped shortcut, which would trade an honest bound for a fragile guess.

**Logged as future work, deliberately not done:** a block-explorer log source
with a topic filter over the full range sidesteps the cap entirely and is free.
It is a new ingestion source that touches the pinned-and-cached determinism model
every reproducibility claim rests on — post-hackathon work, not a lock-down-day
change.

---

## 12. The one blocker that looked like a real finding

Before publishing the 26 reports, each of the four the disclosure gate blocks was
re-examined — the point of a gate being that something eventually has to look at
what it caught. Three were unrecognised custom errors. The fourth was not what
the write-up had said it was.

### What the earlier classification got wrong

§6 recorded PAID proxy 2's `mint(address,uint256)` blocker as *"empty revert
payload — KNOWN EDGE #4, provider-dependent"*, i.e. the weakest and least
interesting class: a provider declining to return revert bytes.

That was wrong, and the error was in the audit script rather than in Ripcord.
`probeCall` records `rawValue = revertData ?? "reverted"` when a call reverts,
and `result ?? "0x"` when it does not — so the literal `"0x"` in the evidence can
**only** be produced by a call that ran to completion. The script mapped `"0x"`
to "(no revert data returned)". The result was that the single strongest
observation in the entire calibration set — *a privileged-looking function
executing successfully for three unrelated addresses on a live token* — had been
filed as a provider quirk.

### What is actually there

Re-probed live at the pinned block, then executed as a real transaction on an
ephemeral fork:

```
eth_call  mint(unrelated, 1000e18) from 3 unrelated addresses -> SUCCEEDS, no revert
eth_call  garbage selector 0xdeadbeef                         -> REVERTS
          (so there is no permissive fallback; the call really is dispatched)

fork tx   mint(recipient, 12345e18) from an unrelated sender  -> status success
                                                    Δ totalSupply = 0, Δ balance = 0
fork tx   mint(recipient, 12345e18) from the OWNER itself     -> status success
                                                    Δ totalSupply = 0, Δ balance = 0
```

`mint` on this contract is a **no-op stub**. It is reachable by anyone, returns
successfully, and changes no state for any caller — including the owner. On a
token with a 594,717,455 supply that is not paused, and one whose deployment was
drained through an unguarded mint in March 2021, a neutered `mint` is the
expected shape of the remediation.

**So: not a vulnerability, and not a privileged function either.** It confers no
power on anyone. The headline result is unchanged and is now better evidenced
than before — the one candidate that looked most like a counterexample was
followed to the state level and cleared:

> **Genuinely unguarded privileged functions found across 26 protocols: 0.**
> No responsible-disclosure obligation was triggered, because there is nothing
> to disclose.

### Why this is the gate working, not the gate failing

The sequence is exactly what the disclosure policy is built for:

1. The probe saw no auth-shaped revert, so the "unguarded" reading could not be
   ruled out.
2. `disclosure.publishable` went **false** and the report was withheld — no page
   was ever rendered for it.
3. A human investigated the specific claim.
4. It resolved as harmless, and *nothing had been published in the meantime*.

Had it resolved the other way, the gate would have held a live vulnerability
claim off a public site. That is the whole design, and this is the first time it
has been exercised on something that genuinely warranted the look.

### The residual, logged and not fixed today

`no_auth_revert_observed` currently covers two epistemically different
observations: *"the call reverted and we could not read it"* and *"the call
executed and returned"*. The second is a much stronger signal — it is one step
from "unguarded" — and it deserves its own reason code
(`executed_without_revert`) beside day 5's split. Both block publication today,
so the gate's **behaviour** is already correct and nothing unsafe follows from
the conflation; only the reporting is coarser than the evidence.

Adding a schema reason code is a detection change, which day 6 is closed to, so
it is recorded here as the next thing to build rather than slipped in on a
lock-down day. `scripts/manual-verification-audit.mjs` now reports the two
distinctly (`EXECUTED` vs a revert class), so the evidence is at least no longer
mislabelled while the schema catches up.

---

## 13. The flagship green result that was wrong

Ripcord's best demo result was `compound-comet-cusdcv3`: a proven-binding 2-day
timelock against an instant exit, `can_exit_in_time`, and a $540M fork proof
beside it. It was found to be a false-clean while scoping an unrelated feature,
and was moved to `undetermined` by the capability-surface rule. Day 7 then
converted the manually discovered path into shipped fork evidence, so the current
report is the decided `no_notice`; §14 records that second step.

### What was there

```
pauseGuardian()                        → 0xbbf3f142…   (a contract, getThreshold() = 5)
stranger  pause(_,_,withdraw=true,_,_) → tx REVERTED    (it is guarded)
GUARDIAN  pause(_,_,withdraw=true,_,_) → tx SUCCESS
                                         isWithdrawPaused: false → TRUE
```

A 5-of-N Safe can shut Comet withdrawals **instantly, with no notice**, while the
report said *"You can exit before the rules CAN change… leaving takes 0s."*
Leaving takes 0s only while the door is open.

### Why no detector was at fault

Every layer was individually honest. `capabilities` extracted
`pause(bool,bool,bool,bool,bool)` and listed it in `unmatchedSelectors`.
`timeToExit.blockable` read `not_observed` and said so in its own note:
*"unmatched selectors were not evaluated for privilege."*

The defect was structural. **`blockable` is computed from taxonomy-MATCHED
findings, so an unmatched selector is invisible to it by construction**, however
privileged it is — and the composition layer turned that silence into
reassurance. Same shape as [§3](#3-the-error-ripcord-was-making-and-the-fix): the
data was right, the sentence a human reads first was wrong.

### Why the obvious patch was rejected

Adding `pause` to the taxonomy was traced through the shipped code path before
being adopted, and it **does not fix this**: the probe returns `Unauthorized()`
(`0x82b42900`), which — being an unrecognised dialect — routes the capability to
`needsManualVerification` and would have removed Comet's page entirely. Even with
a dialect entry it lands as *unattributed*, which makes `blockable`
`undetermined`, which produces no suffix and **no status change**. Comet stays
green. A point-patch on the name would also have left the next kill switch —
`freeze`, `halt`, `setWithdrawalsEnabled` — invisible in exactly the same way.

### The general rule

> A reassuring assessment may not stand while a **privileged party exists** and
> the **privileged surface was not fully evaluated**.

"Fully evaluated" is a positive claim, like everything else in
`report/enumeration.ts`: the dispatcher must have been decoded **and** every
selector it recovered must have been classified. One resolved implementation
address is not enough.

**The discriminator is who could call one, and it was measured before it was
written.** All 26 reports have unmatched selectors, so "any unmatched selector
withholds the witness" would have deleted every reassuring verdict in the set —
including WETH9's, earned by deriving all 11 of its selectors and confirming none
is privileged. What makes an unevaluated selector dangerous is that somebody
holds privilege over the contract. WETH9 and wstETH have no owner, no
pendingOwner, no proxy admin, no role members and no indirection marker: there is
nobody for an unevaluated selector to be privileged *for*, so theirs are inert
and their true negatives survive.

### Day-6 predictions registered before the capability-surface fix

| | Predicted | Actual |
|---|---|---|
| Verdicts changed | Comet, Uniswap v3 Factory | **exactly those 2** |
| Moved toward reassurance | 0 | **0** |
| WETH9 / wstETH | survive | **survived** |
| Distribution at the end of day 6 | 2 / 0 / 6 / 1 / 17 | **immutable 2 · can_exit 0 · no_notice 6 · trapped 1 · undetermined 17** |

Twelve further reports had `enumeration.complete` flip to `false` with **no
verdict change** — the caution-only property holding: an incomplete enumeration
can never make a bad finding safer.

The predictions are now a CI gate. `scripts/verify-pages.mjs` fails the build if
`compound-comet-cusdcv3`, `compound-cdai` or `compound-unitroller` is ever
reassuring again, and the independent derivation in that script grew the same
capability-surface dimension — derived separately from `enumeration.ts`, so a bug
in one cannot hide in the other.

### What the verdict could say then, and what changed on day 7

At the end of day 6, the fork test above was how the kill switch was **found**,
but it was not shipped machinery. The report could establish only that a
privileged party existed over 67 unevaluated selectors, so `undetermined` was the
honest output; Ripcord did not claim something supported only by a manual
investigation. Day 7 shipped that exact baseline/mutation differential. The
current report can therefore assert the demonstrated restrictor and returns
`no_notice`; the remaining 66 unmatched selectors stay named as an enumeration
gap rather than disappearing.

### The cost, stated plainly

**`can_exit_in_time` no longer occurs anywhere in the set.** It is not currently
establishable for any contract that has both a privileged party and an
unevaluated surface, which is every contract here that has an owner at all. That
is a real loss of expressiveness and the honest way to restore it is to evaluate
the unmatched selectors — which needs their signatures, i.e. a block-explorer ABI
source, deliberately not built during the event because it breaks the
pinned-and-cached determinism model.

What survives is worth being clear about too: **the $540M proof is untouched and
still true.** The Compound timelock genuinely imposes 2 days of notice on rule
changes, and the proof engine still demonstrates the scale of what that authority
controls. What changed is only the exit claim — from *"you can get out in time"*
to *"2 days of notice on rule changes, but a 5-of-N guardian can close the exit
with none."* That is a sharper finding than the green box was, and Ripcord's
distinction between *notice on a rule change* and *the exit itself being
closable* is the thing no checklist makes.

---

## 14. Day 7: the fork differential

Every layer up to day 6 REASONS about whether a privileged party can close a
holder's exit. Day 7 TESTS one bounded archetype. On a sandbox anvil fork pinned
to the report block the engine identifies the exit action, establishes a real
baseline exit, then evaluates the restriction candidates registered for that
matched archetype. This pass has one: Comet's `pauseGuardian()` setting the
withdraw-pause flag. If the exit then fails, the function is a DIRECT
exit-restrictor, demonstrated rather than inferred. It does not discover or
execute every privileged function in the target; coverage is coverage of the
registered candidate set.

### The epistemic ceiling, stated before anything was built

You cannot prove a protocol is safe to exit. The absence of ANY restriction path
over an open space — arguments, call sequences, oracle/liquidity manipulation —
is not provable by testing, for anyone. So the engine's positive outcome is NOT
the retired `can_exit_in_time` and never claims safety. It is the deliberately
weaker `no_direct_restriction_found`, and its report copy always carries the
scope: *evaluated N guarded functions on a fork; none directly blocked a baseline
withdrawal; not a guarantee — argument space and indirect/economic restrictions
were not exhausted.* Three ceiling items ship verbatim on every evaluation:
exit-action mis-identification, un-exhausted argument space, and indirect/
economic restrictions (oracle, liquidity, fee/rate, sequences).

The riskiest new false-clean is testing against the wrong exit function, so
identification is weakest-link: `no_direct_restriction_found` is unreachable
unless the exit action was confidently identified AND a baseline established.
Anything less is `exit_action_unconfident` / `baseline_unestablished`, both of
which keep the verdict `undetermined` — the differential is refused, not guessed.

### Predictions registered before the code (outcome-neutrality), and the result

| Prediction | Result |
|---|---|
| Comet → a fork-confirmed DECIDED restriction, non-reassuring | ✅ `undetermined` → `no_notice`, `exitRestriction.outcome=restrictor_found`, `confirmationMethod=fork_confirmed` |
| The true negatives (WETH9, wstETH) survive unchanged | ✅ both remain `immutable_within_checks` |
| No protocol currently `no_notice`/`trapped` moves toward reassurance | ✅ 0 moved toward reassurance |
| The new tier may fire nowhere and must not be forced for a showcase | ✅ fires nowhere; not forced or claimed as a calibrated result |

**Exactly one verdict changed: Comet, `undetermined` → `no_notice` — a move
toward caution, from the tool's own fork evidence.** The predictions are enforced
in `scripts/verify-pages.mjs` (`DAY7_FLAGSHIP`, `DAY7_TRUE_NEGATIVES`, and
structural invariants on every `exitRestriction` block), so they cannot be
quietly tuned toward afterwards. Break-tested: flipping Comet's verdict, or
stripping its `fork_confirmed`, each fails the build.

### The flagship, transaction by transaction

This is the historical receipt-based experiment. Current rules require full
position recovery and stricter causal checks; see [FORK_VALIDATION.md](FORK_VALIDATION.md).
The historical Safe impersonation also bypasses signatures, guards and modules,
so it assumes controller authorization succeeds. These records are not a fresh
validation of the current rules.

On the fork at block 25800000, for Comet cUSDCv3 (`0xc3d688B6…`):

1. **Baseline (the control).** Fund a holder 100k USDC from a whale, `supply`
   50k, then `withdraw(USDC, 10k)` → **succeeds**. The exit works.
2. **Snapshot, then the mutation.** Impersonate `pauseGuardian()` =
   `0xbbf3f142…` (a **5-of-9 Safe**), call `pause(false,false,true,false,false)`
   → succeeds; `isWithdrawPaused()` reads **true**.
3. **Re-run the exit.** The identical `withdraw(USDC, 10k)` → **reverts.**
4. Revert the snapshot; the candidate is isolated.

The auth is real, not a wildcard: an unrelated address's `pause` reverts
`Unauthorized()` and a garbage selector reverts, so the guardian's call genuinely
dispatches. The guardian is impersonated at its Safe address, so the finding is
"this Safe CAN close the exit if its signers collude," not "one key can."

Comet now carries TWO routes with two different notices, and the window is the
MINIMUM: the upgrade path is timelocked (`ProxyAdmin → Compound Timelock`,
172800s proven binding — the same route the day-3 proof drains **$540,604,938.71**
through), while the withdraw-pause is instant. So the verdict is `no_notice`, and
the statement reads *open now but closable — you can be trapped at any moment, not
already trapped.* That distinction — notice on a rule change versus the exit
itself being closable — is the thing no checklist makes, and day 7 demonstrates
it rather than asserting it.

### Scope of this pass: one archetype, validated end to end

Like the proof engine (one upgrade archetype, done properly), the fork
differential ships **one exit archetype and one registered restriction candidate
— Compound III / Comet base-withdrawal versus its withdraw-pause guardian —
validated live end to end**, with the interface table
(`src/fork/exitActions.ts`) built so a new interface is data, not a rewrite. The
confirmation direction (finding a restrictor) is caution-only and safe to run
broadly; the natural neighbours (ERC-4626 `redeem`/`withdraw`, a Lido
withdrawal-queue claim behind `PAUSE_ROLE`, a pausable/blacklistable ERC20
`transfer`) are the immediate next step, each requiring its own baseline
mechanics and a live validation before it is trusted — deliberately not rushed
under the timebox, because testing against a mis-identified exit is the one
false-clean this layer exists to refuse.

No calibration report exercises the clean direction: Comet finds its restrictor,
and every other report is a plain `scan`/`prove`. The repository therefore makes
an empirical claim about the demonstrated Comet restriction, not about the
general reliability of `no_direct_restriction_found`. Before that tier is relied
upon on additional interfaces, the registered-candidate surface itself still
needs complete tested/excluded/unresolved accounting and a live negative control.
Candidate execution and aggregate enumeration now fail closed in schema
0.13.0 / ruleset 0.12.0: `inconclusive` or `not_evaluated`, or any incomplete
enumeration site, produces `evaluation_inconclusive`; `composeVerdict` repeats
the gates independently. This closes the live fall-through without claiming
that the broader candidate registry is complete.

### Determinism

The fork evaluation is deterministic at the pinned block: fixed sandbox holder,
fixed whale, fixed amounts and arguments, deterministic nonces → deterministic
results. Two independent `restrict` runs of Comet are byte-identical apart from
`generatedAt`. The schema 0.13.0 / ruleset 0.12.0 rerun preserves Comet's
fork-confirmed restriction; its incomplete selector-surface enumeration is
recorded as a clean-outcome blocker but cannot weaken that finding.
