# Ripcord

## Thesis

An audit answers "is there a bug." It does not answer "who holds the keys."
With an upgradeable proxy, the code an auditor reviewed is not necessarily the
code that runs tomorrow — an admin can swap the implementation, or otherwise
exercise legitimate on-chain power, without breaking any rule an audit
checked. Ripcord makes on-chain power structures legible: who holds privileged
capability over a contract, what that capability actually lets them do, and
(later) how fast they could use it versus how fast a user could leave. Every
fact is public and readable in advance; nobody automates reading it. The
audience is professional security auditors judging a hackathon demo — they
will actively try to break the tool's credibility, so overclaiming is the
single biggest risk to the project, worse than missing a case.

## Design philosophy — non-negotiable

1. **Evidence, not flags.** Every finding carries machine-readable evidence:
   the read performed, its parameters, the raw value, the block.
2. **Unknown is never safe.** Undeterminable means explicitly "unknown,"
   never "no issues found."
3. **Fail loud.** No silent catches, no empty defaults that resemble clean
   results.
4. **Capability, not intent.** Never claim anyone will do anything. Report
   what a privileged address is technically able to do. No "malicious,"
   "scam," "rug."
5. **Determinism.** Everything pinned to a block and reproducible.
6. **Narrow and working beats broad and flaky.**
7. **Weakest-link provenance** (added day 2). A finding inherits the
   confidence of its weakest input. If a capability is detected but its guard
   or holder can't be reliably determined, the output is "capability present,
   holder/guard unknown" — never omitted, never attributed to the last holder
   found by coincidence. Uncertainty propagates upward through every layer;
   it must never get laundered into false confidence in the report. This is
   encoded in the types, not left to caller discipline: a capability finding
   must be structurally incapable of claiming an attributed holder without
   the evidence to back it.

## Architecture

```
src/chain/
  client.ts       PinnedChain — the only way detectors touch the network.
                   Every read pinned to a block, cached to disk, returns an
                   Evidence{kind,params,rawValue,block}. Reverts are a normal
                   cached result (evidence-carrying); actual RPC failures
                   throw ChainReadError — "fail loud," caller decides
                   unknowns[] vs errors[].
  cache.ts        DiskCache, keyed by (chainId, blockNumber, method, params).
                   No invalidation — a historical block never changes, so a
                   cache hit is permanently valid. This is what makes a warm
                   rerun byte-identical and network-free.
  constants.ts    All storage slots (EIP-1967/1822/legacy-zos) and function
                   selectors, derived from preimages in code, not copied from
                   memory. test/constants.test.ts asserts derived == known-
                   good reference values.
  abi.ts          Minimal ABI fragments for encodeFunctionData/decodeFunctionResult.
  rpcPreflight.ts (consolidation) Provider preflight. describeProvider() names
                   the active provider from its URL HOST ONLY (never the full
                   URL, which carries the key) — printed by the CLI at the start
                   of every scan. probeMaxLogRange() binary-searches the
                   provider's real eth_getLogs block-range once (memoized per
                   ChainReader, log-free probe address), the input to
                   accessControl.ts's adaptive chunking. The KNOWN EDGE #7 fix.
  priceFeeds.ts   (day 3) Chainlink feed map for the 6 majors, used by the proof
                   engine to price a drained-balance delta; unreadable feed ->
                   usd:null with the reason, never a silent $0.
  clearedRegistry.ts (consolidation) Versioned (`clearedRegistryVersion`)
                   registry of DEPENDENCY capabilities that are documented design
                   not vulnerabilities (USDC blacklist/pause/mint, etc.), each
                   with a justification + source. assessDisclosure clears such
                   dependency entries out of the publication gate (recording them
                   in `disclosure.cleared` with the version) so a report isn't
                   blocked merely for HOLDING USDC; the target's own findings and
                   any uncleared/other-token capability still block. Never a
                   silent allowlist — every clear is recorded and versioned.

src/detect/
  bytecode.ts     Dependency-free bytecode helpers: EIP-1167 clone matcher,
                   Solidity CBOR-metadata-trailer stripper, containsOpcode
                   (linear scan respecting PUSH1..PUSH32 immediate lengths).
  proxy.ts        Proxy pattern detection (see classification order in file
                   header). Resolves one hop through a beacon's implementation().
  ownership.ts    owner()/pendingOwner() (Ownable-style).
  accessControl.ts OpenZeppelin AccessControl detection: Enumerable getters
                   when available, else reconstructed by replaying
                   RoleGranted/RoleRevoked from deployment block. Chunked to the
                   provider's PROBED getLogs range (rpcPreflight.probeMaxLogRange),
                   not a fixed constant (KNOWN EDGE #7 fix); if the full history
                   exceeds the ~1500-request budget it degrades to a LABELLED
                   partial (`reconstruction.complete=false` + lowered confidence
                   + exact covered window), never a silent truncation. See edges
                   2, 7, 13.
  deployment.ts   Binary search over getCode to find a contract's deployment
                   block (bounds the AccessControl event scan). No indexer.
  accounts.ts     Classifies an address that holds power: eoa (no code) /
                   safe (getOwners()+getThreshold() both resolve, reads
                   threshold/owners/version) / contract (stops there — no
                   deeper classification claimed, not yet recursive).
                   Also exports collectPowerHolders(), shared by build.ts and
                   dependencies.ts: dedupes every address found via owner/
                   pendingOwner/proxyAdmin/AccessControl roles/attributed
                   capability guards, classifies each once.
  dispatcher.ts   (day 2) Dispatcher-based selector extraction. A minimal
                   static-reachability walk (BFS from offset 0, following
                   only JUMP/JUMPI targets pushed by a literal PUSH
                   immediately beforehand, landing on a real JUMPDEST; a
                   block ends at its first terminator with no fallthrough
                   past it) — NOT a naive linear walk like bytecode.ts's
                   containsOpcode. This is what makes CODECOPY'd child-
                   contract creation bytecode (embedded via `new Foo(...)`)
                   structurally unreachable rather than accidentally decoded
                   as this contract's own dispatch branches — see KNOWN
                   EDGES #1 and its regression tests. Confirms the CALLDATALOAD
                   selector-load shape exists (modern SHR, old DIV in either
                   push-order, see KNOWN EDGES) before trusting any
                   comparisons; collects PUSH4 values compared via EQ as
                   selectors, counts GT/LT binary-search pivots separately
                   without treating them as selectors (verified empirically:
                   solc's binary search always terminates each leaf in a
                   real EQ check, so pivots are redundant, never load-bearing,
                   for selector recovery). Returns `recognized: false` (never
                   a guess) when no selector-load shape is found at all.
  taxonomy.ts     (day 2) Versioned DATA table: full function signature ->
                   {category, confidence}. Categories: CODE_CHANGE,
                   FUND_MOVEMENT, SUPPLY, ACCESS_RESTRICTION, ECONOMIC,
                   AUTHORITY_CHANGE. Selectors are computed from signatures
                   via viem, never hand-copied. `confidence: "low"` marks
                   generically-named signatures (sweep, skim, emergency*)
                   where a match is exact but the name's real-world meaning
                   varies by project; `"high"` marks standard/widely-adopted
                   ones. Bump `taxonomyVersion` (and report.rulesetVersion)
                   whenever this table changes.
  guardProbe.ts   (day 2) Guard attribution BY PROBING, not static analysis.
                   For a capability's known signature, performs a real
                   eth_call at the pinned block with zero-valued args from
                   three deterministic (hash-derived, never random) probe
                   addresses unrelated to the protocol, and parses the
                   revert: OZ v4 Ownable/AccessControl Error(string)
                   messages, or OZ v5 OwnableUnauthorizedAccount /
                   AccessControlUnauthorizedAccount custom errors — all four
                   selectors derived via viem, asserted in tests, never
                   hardcoded. One recognized auth-shaped revert from any
                   probe is sufficient to classify `attributed` (holder maps
                   to a known day-1 owner/role) or `guarded_unknown_holder`
                   (auth-shaped but unmapped). No auth-shaped revert from ANY
                   of the three probes -> `no_auth_revert_observed`, which
                   capabilities.ts routes OUT of normal findings into
                   needsManualVerification — never asserted as "unguarded."
  capabilities.ts (day 2) Orchestrates dispatcher + taxonomy + guardProbe for
                   one address. TWO addresses are in play and conflating them
                   is a real bug (fixed after day 2, regression-tested):
                     scannedAddress — BYTECODE source. The implementation for
                       a confirmed proxy, but the TARGET's own bytecode when
                       `proxy.pattern === "unknown"` (day-1's DELEGATECALL-
                       found-but-unclassified case) — see KNOWN EDGES #3a for
                       why those two isProxy-true cases differ.
                     probedAddress  — guard-probe eth_call TARGET. Always the
                       target/proxy, never the implementation: a delegatecall
                       through the proxy runs the implementation's code
                       against the PROXY's storage (where owner/role state
                       lives), whereas calling the implementation directly
                       runs it against the implementation's own, usually
                       uninitialized, storage. Verified live on PAID Network:
                       proxy owner() = 0x53bc21D3…, implementation owner() =
                       address(0), yet BOTH revert "Ownable: caller is not
                       the owner" — so probing the implementation and naming
                       the proxy's owner would be an attribution the evidence
                       doesn't support. Same reasoning as the day-1
                       ownership.ts/accessControl.ts invariant.
                   Both are recorded on every finding.
  authority.ts    (day 3) Recursive authority resolution + timelock detection.
                   For every depth-1 power holder that is a contract, recurses
                   into ITS authority (ownership/AccessControl/proxyAdmin) until
                   termination — EOA, Safe (record threshold+owners, do NOT
                   recurse into signers), timelock (record delay), max depth 3,
                   cycle, or no-authority-found. Every leaf states WHY it
                   stopped; an empty `children` is never read as "clean" (same
                   discipline as unknowns[]). Weakest-link provenance applied to
                   DEPTH: confidence degrades high->medium->low as depth grows,
                   and the report shows the full path + effective controller.
                   Cycle detection is on the root-to-here path (a diamond that
                   legitimately re-reaches one contract is fine; only a true
                   cycle back onto the current path is cut and recorded as a
                   finding — verified live on Aave governance's Executor<->
                   Governance mutual ownership). Produces an authority PATH per
                   root ("upgrade -> ProxyAdmin -> EOA 0x…"), the exact input
                   the proof engine impersonates from. detectTimelock classifies
                   by delay accessor: OZ TimelockController (getMinDelay()),
                   Compound/Bravo (delay()+admin()), or role-only "delay
                   undetermined" fallback — selectors derived in constants.ts
                   (TIMELOCK_SELECTORS), asserted in tests. adminCanShortenDelay
                   is a day-3 FLAG only: presence of updateDelay/setDelay in the
                   timelock's own bytecode (the delay is not immutable); WHO can
                   reach it under WHAT constraint is day-4 Exit Window work.

  guardDialects.ts (day 5) Versioned (`guardDialectsVersion`) dictionary of guard
                   revert DIALECTS, built from calibration. Day 2 recognised four
                   shapes (OZ v4/v5 Ownable+AccessControl); across 26 real reports
                   that produced 30 "no auth revert observed" results of which ZERO
                   were genuinely unguarded and 22 were contracts stating plainly,
                   in their own revert string, that a guard had fired (Circle
                   FiatToken "caller is not the blacklister", Maker ds-auth
                   "Dai/not-authorized", OZ v3 "sender must be an admin to grant",
                   Morpho "not owner", Rocket Pool "Invalid or outdated contract",
                   Ethena OnlyMinter()). 13 entries: 9 auth families → `guarded_
                   unknown_holder` (NEVER `attributed` — these dialects name no
                   holder), 4 pre-auth families → the new `reverted_before_auth_
                   check`. THE HARD BOUNDARY: it may only ever move a RECOGNISED
                   revert toward "guarded"; there is deliberately no rule reading
                   "we didn't recognise it, so assume guarded" — that inference is
                   how false-clean gets built. Unrecognised stays unrecognised and
                   keeps blocking. Every pattern is ANCHORED (^…$), never a
                   substring, so an unrelated message cannot embed a guard phrase;
                   every entry records where it was read live. In-sample by
                   construction, and the docs say so.
  authorityIndirection.ts (day 5) Detects the EXISTENCE of an authority
                   indirection without resolving it: 14 zero-arg getters
                   (getAuthorizer/authority/acl/admin/governor/…), each counting
                   only when it returns a NON-ZERO ADDRESS. Ripcord never calls
                   into what it finds. Its only effect is subtractive — a marker
                   prevents the exit window from claiming `immutable_within_checks`
                   — so a false positive costs a lost clean claim and nothing else.
                   `gettersProbed` is recorded so an empty `markers` means "checked,
                   found none". Fired on 7 of 26: Balancer's getAuthorizer() (the
                   false-clean that forced this module), MKR's authority() (owner()
                   reads 0x0 — the shape of "renounced" — while DSChief holds real
                   power), Compound cDAI/Unitroller/Comet's admin()/governor()
                   naming the Timelock, Aave's getACLManager().

  exitWindow.ts   (day 4, THE METRIC) The exit window = notice before a rule
                   change takes effect, MINUS every way it can be cut. Models it
                   per ROUTE (each depth-1 authority is its own path to changing
                   the rules) and takes the MINIMUM: a 2-day timelock on the
                   upgrade path is worth nothing beside an un-delayed role. A
                   Safe is NOT a delay — it raises how many parties must agree
                   and adds zero notice, so a Safe/EOA-terminated route is
                   `immediate` (noticeSeconds 0). Binding-ness is decided BY
                   PROBE, like day-2 guards: probe updateDelay/setDelay from
                   unrelated addresses and read the revert. A self-call gate
                   ("caller must be timelock" / "Call must come from Timelock.",
                   both read live before this was written; plus OZ v5's
                   TimelockUnauthorizedCaller custom error, derived) proves the
                   delay binds itself → `proven_binding`. An Ownable/AccessControl
                   gate → `shortenable`. Anything else → `cannot_determine`,
                   NEVER credited as binding. Also checks whether the timelock is
                   itself behind a proxy. The assessment is a zod discriminated
                   union in which ONLY the `binding` variant has `windowSeconds`,
                   so an unproven delay is structurally incapable of appearing as
                   a window (same technique GuardStatus uses). `checksPerformed[]`
                   records every check that RAN, so an empty `bypasses[]` means
                   "checked, found none" rather than "never looked"; checks
                   Ripcord deliberately skips are listed with `performed:false`.
  timeToExit.ts   (day 4) How long a holder actually needs to leave, as a LOWER
                   BOUND with its gaps named. Versioned tables of cooldown/claim
                   accessors (selectors derived via viem, matched exactly) and
                   two-step request→claim selector PAIRS; current pause state read
                   at the pinned block; exit-blockability composed from day-2
                   ACCESS_RESTRICTION findings attributed to a holder. Measured
                   waiting legs SUM (they are sequential); a claim window is a
                   deadline, not a delay, and adds zero. `tight` is deliberately
                   hard to earn — a readable dispatcher, every detected leg
                   measured, nothing currently blocking — and only a tight bound
                   lets the verdict make a two-sided comparison. Records
                   `mutableBy` when a cooldown's own setter exists (sUSDe reads
                   86400s with setCooldownDuration present and a 90-day max), so
                   a time-to-exit the authority can raise is never reported as a
                   protocol constant. Liquidity depth is `modelled: false` with
                   the reason — a literal false in the schema, so a made-up
                   number cannot be expressed.

  dependencies.ts (day 2) One-level-deep dependency graph. Checks target
                   balances against the curated MAJOR_TOKENS list
                   (chain/majorTokens.ts); for each nonzero holding, reruns
                   proxy+ownership+accessControl+capabilities against the
                   TOKEN. Separately probes a short list of common oracle-
                   getter names on the target and, for any that resolve to a
                   contract, runs owner/AccessControl authority detection
                   (not full capability detection — deliberately shallower,
                   one hop past the one-hop mandate) on it. Depth is exactly
                   one level, on purpose.

src/fork/
  preflight.ts    Fails loud with install instructions if the `anvil` binary
                   isn't usable — the proof engine's only external dependency.
  anvil.ts        (day 3) Ephemeral anvil mainnet-fork lifecycle pinned to the
                   report block, driven via viem (createTestClient +
                   public/wallet actions). spawn -> wait-for-ready (hard
                   timeout, fails loud with anvil's stderr) -> use -> stop
                   (SIGTERM then a SIGKILL backstop, always torn down). Exposes
                   an impersonated-sender eth_sendTransaction helper with a
                   mandatory gas cap — we are executing adversarial-shaped
                   logic. NEVER touches mainnet; the fork is the only surface.
  drainer.ts      (day 3) Hand-assembled EVM bytecode for a minimal
                   "sweep these ERC20s to one recipient" implementation, plus
                   its constructor initcode. Assembled in TS (no solc, no
                   Solidity source) so it stays auditable inline and the
                   codebase stays one language. Deliberately the smallest thing
                   that makes the CODE_CHANGE capability concrete — not a
                   general exploit, only ever deployed to an ephemeral fork.
  proofEngine.ts  (day 3, THE PILLAR) Turns a static CODE_CHANGE claim into an
                   EXECUTED, reproducible demonstration. ONE archetype:
                   CODE_CHANGE->drain on an EIP-1967 TRANSPARENT proxy via
                   ProxyAdmin.upgrade(address,address). Impersonates the
                   RESOLVED controller from authority.ts's path (the terminal
                   EOA one hop past the ProxyAdmin — NOT the proxy's nominal
                   owner), deploys the drainer, executes the admin's own
                   upgrade, triggers it, measures the target's MAJOR_TOKENS
                   holdings leaving, prices the delta from Chainlink feeds
                   (priceFeeds.ts). Honesty rails are load-bearing and tested:
                   sandbox only (no mainnet tx / no key / no approval, stated in
                   output); capability-not-intent in every string; FAIL LOUD to
                   produced=false with a stated reason for any non-transparent
                   pattern, unresolved authority, or no holdings — never a
                   fabricated trace. Emits a reproduce command + a `cast run`
                   call-trace artifact. `ripcord prove <addr> --block` runs it.
  exitActions.ts  (day 7) Versioned (`exitActionsVersion`) exit-action
                   identification table + base-token whales for fork funding.
                   The riskiest new false-clean is testing against the wrong exit
                   function, so an interface is matched only when a FINGERPRINT of
                   characteristic selectors is ALL present (partial ≠ match), and
                   the positive verdict inherits the match's confidence. Selectors
                   are pinned and asserted against viem derivation in tests. ONE interface this pass:
                   compound-comet-base (supply+baseToken+isWithdrawPaused ⇒ exit is
                   withdraw(address,uint256)) — built so a neighbour is data.
  exitRestriction.ts (day 7, THE FORK DIFFERENTIAL) Stops REASONING about exit
                   restriction and TESTS it. On a fork: identify the exit action,
                   establish a BASELINE exit (fund a holder from a whale, supply,
                   withdraw — must succeed), then for each candidate registered by
                   the matched archetype: snapshot → impersonate its guarding party →
                   call with the exit-restricting argument → re-run the exit; exit now
                   fails ⇒ a DIRECT restrictor, demonstrated. Revert BETWEEN candidates
                   so each is isolated. This pass registers one Comet pause candidate; it
                   does not discover every privileged function in the target. The
                   epistemic ceiling is in the types: a clean run is NEVER
                   can_exit_in_time and never claims safety — it is the weaker
                   `no_direct_restriction_found`, unreachable unless the exit action
                   was confidently identified AND a baseline established (else
                   `exit_action_unconfident`/`baseline_unestablished` ⇒ undetermined).
                   A Safe-guarded restrictor is impersonated AT THE SAFE (the KNOWN
                   EDGE #9 collusion rail). Deterministic (fixed holder/whale/args/
                   nonces) ⇒ cold==warm. `ripcord restrict <addr> --block` runs it
                   (a SUPERSET of prove: it also runs the drain proof, so Comet
                   carries both its $540M timelocked upgrade AND its zero-notice
                   fork-confirmed pause in one report).

src/live/          (Mobula bounty) THE LIVE LAYER — deliberately OUTSIDE the
                   pinned path, and the only module tree that is. Nothing under
                   src/chain, src/detect, src/report, src/fork or src/cli.ts
                   imports it, at any depth, and scripts/verify-boundary.mjs
                   fails CI if that ever changes (transitive import walk; it
                   prints the offending chain). Rationale in docs/MOBULA.md.
  mobula.ts        Client for 3 REST endpoints: wallet/holdings (multi-chain,
                   fetchAllChains), token/price (batch, second quote +
                   liquidity), multi-metadata (names/logos). Returns a
                   discriminated MobulaResult rather than throwing — a vendor
                   outage is not a fact about the contract and must never take
                   down a page whose verdict does not depend on it. NOT routed
                   through PinnedChain: DiskCache is keyed by block and
                   justified by "a historical block never changes", which is
                   false for a price. Native assets arrive under the sentinel
                   0xeeee…eeee, which is THE SAME on every chain, so every
                   lookup is keyed by (chainId, address) — verified live on
                   cbETH, where an address-keyed map quoted ETH at BNB's price.
  exposure.ts      Composes the three into one LiveExposure. Identity is
                   (chainId, address); the vendor's name/symbol are stored as
                   `unverifiedSymbol`/`unverifiedName` because live wallet data
                   really does contain phishing lures as token names. Each
                   holding carries a `valuation` basis (endpoints_agree /
                   single_source / uncorroborated / implausible_vs_liquidity) —
                   weakest-link provenance applied to market data. The headline
                   is computed HERE, never adopted from the vendor's own
                   portfolio total, which read $11.8tn on one target. Withheld
                   holdings are itemised one bucket per REASON.
  logos.ts         Inlines logos as data: URIs at fetch time — verify-pages
                   forbids a remote src, and hotlinking would leak every page
                   view to the vendor.

src/report/
  applyExitRestriction.ts (day 7) PURE merge: takes a base report + a fork
                   exit-restriction result, injects a fork-confirmed restrictor as
                   a zero-notice exit-window ROUTE (so the min-notice arithmetic
                   collapses to no_notice), and RE-COMPOSES the verdict. Direction
                   is add-only: it never removes a route or softens a finding.
                   Unit-testable without a fork.
  verdict.ts      (day 4; day-7 tier) PURE composition of the two sides — no chain access,
                   so the rules an auditor will argue with are exhaustively
                   unit-testable. `timeToExit >= exitWindow` → trapped, using >=
                   because finishing your exit at the instant a change lands is
                   not leaving BEFORE it (the live sUSDe case: 86400s cooldown vs
                   an 86400s owner-timelock). `marginSeconds` is published so a
                   dead heat reads as one. A zero window returns `no_notice`
                   rather than `trapped`: the comparison COLLAPSES rather than
                   being computed, and the reason is what an auditor checks.
                   Uncertainty may push the verdict toward caution and never
                   away: a non-tight exit bound can still yield `trapped` (a
                   floor above the window can only grow) but never
                   `can_exit_in_time`.
  schema.ts       Zod schema for the report. Source of truth for the shape
                   of everything below.
  build.ts        Orchestrates all detectors into one Report, validates
                   against reportSchema before returning (a report failing
                   its own schema is a Ripcord bug, not a target problem).
                   Each stage wrapped in runStage() — an exception becomes an
                   errors[] entry plus a safe fallback value, never a crash.

src/cli.ts        `ripcord scan <address> --block <n> --chain <id>`. Prints
                   schema-valid JSON to stdout. Per-target failures live in
                   the report's errors[]; only usage errors / fatal setup
                   failures (bad RPC, bad args) exit non-zero. Also `ripcord prove`
                   (day 3 drain proof) and `ripcord restrict` (day 7 fork
                   differential; a superset that also runs the proof).
```

Data flow: `cli.ts` → `PinnedChain` (chain.ts+cache.ts) → `buildReport`
(build.ts) fans out to `detectProxy`, `detectOwnership`,
`detectAccessControl` in parallel where possible → collects power-holder
addresses from owner/pendingOwner/proxy.admin/role members → `classifyAccount`
per address → assembles + validates `Report` against `reportSchema`.

Important invariant: authority-related reads (owner, AccessControl roles)
always target the **proxy address**, never `proxy.implementation` — that's
where the real storage lives; the implementation's own storage is reached
only via delegatecall and is usually uninitialized.

## Report schema invariants

- `evidence[]` on every finding: `{kind: storage_slot|call|log|bytecode,
  params, rawValue, block}`. A finding without evidence is not a finding.
- `unknowns[]` — always present, never suppressed to look clean. Populated
  explicitly whenever detection is genuinely undetermined (e.g. a confirmed
  proxy with no identifiable upgrade authority). Empty only when truly
  nothing is unknown, not by omission.
- `errors[]` — always present. Only actual RPC/infra failures land here, not
  a normal contract-level revert (which is evidence, not an error).
- `rulesetVersion` / `schemaVersion` are pinned constants in schema.ts and
  must be bumped whenever the taxonomy/detection rules or schema shape
  change — this is what makes "pinned ruleset version" a real claim in the
  report rather than decoration. Both bumped to 0.2.0 on day 2, then 0.3.0
  when the guard-probe target was corrected (a detection-rule change) and
  `probedAddress` was added (a schema-shape change). Bumped to 0.5.0 /
  ruleset 0.4.0 on day 3 (recursive `authorityResolution` and the `proof`
  block added to the schema; timelock detection added to the ruleset). Bumped
  to schema 0.6.0 / ruleset 0.5.0 in the consolidation pass:
  `authority.accessControl.reconstruction` (partial-scan label) and
  `disclosure.cleared`/`clearedRegistryVersion` added to the schema; adaptive
  getLogs chunking and the cleared-dependency registry added to the ruleset;
  taxonomy `matchConfidence` renamed to `nameMatchSpecificity` with values
  `standard`/`generic` (a rename so it is never misread as a certainty score —
  the ONE certainty scale `high|medium|low` is used only where it means
  certainty: authority depth and role reconstruction).
- **`disclosure.cleared` + `clearedRegistryVersion` (consolidation).** The gate
  now records which DEPENDENCY capabilities were cleared as documented design
  (and under which registry version) rather than silently letting them pass —
  a clearing is as auditable as a block. The target's own findings are never
  cleared. See clearedRegistry.ts and README "Cleared dependency registry."
- **`reconstruction` on AccessControl (consolidation).** Role membership from a
  partial event scan carries `reconstruction.complete=false` and a lowered
  `confidence`, on the shared certainty scale, with the exact covered window —
  weakest-link provenance for the getLogs path, never a silent truncation.
- **`exitRestriction` block + `no_direct_restriction_found` verdict (day 7).**
  The report gains a nullable `exitRestriction` block (null in `scan` mode, never
  a claim that no restriction exists) carrying the fork differential: exit action,
  baseline, per-candidate results, coverage, `restrictionState`
  (`restrictable`/`already_shut`/`none_found`/`undetermined`) and
  `confirmationMethod` (`fork_confirmed`/`not_confirmed`). Exit-window ROUTES gain
  `confirmationMethod`(default `static`) + `restrictionState`(default null) so a
  reader can tell a delay we could not verify from a kill switch we watched fire.
  A new verdict status `no_direct_restriction_found` — the DELIBERATELY WEAKER
  positive tier, never `can_exit_in_time`, always carrying its scope sentence and
  the count N — is intended to require an identified exit action, an established
  baseline and complete evaluation of the matched archetype's registered candidates.
  It occurs nowhere in the current calibration set; candidate/enum fall-throughs
  now fail closed, while candidate-surface completeness and baseline causality
  remain bounded by KNOWN EDGE #38. schema 0.13.0 / ruleset 0.12.0.
- **Authority PATH, not just a terminal holder (day 3).** `authorityResolution`
  carries a recursive `authorityNode` tree per depth-1 power holder plus a
  flattened `paths[]` projection ("upgrade -> ProxyAdmin -> EOA"). Confidence
  degrades with depth (high@1 / medium@2 / low@3) — an effective controller
  reached through three hops is never asserted with a direct owner's certainty.
  Every leaf carries an explicit `terminationReason`
  (eoa/safe/timelock/max_depth/cycle/no_authority_found); "we stopped looking"
  is never left to be inferred from an empty `children`. Cycles are recorded
  in `cyclesDetected` and surfaced in `unknowns[]`, never looped on.
- **Proof is produced-or-honestly-absent (day 3).** `report.proof` is null when
  no proof was attempted; otherwise `attempted` is always true and `produced`
  is true ONLY when funds actually moved on the fork. `produced: false`
  ALWAYS carries a `failureReason` and never an intent claim. This is the same
  "unknown is never safe" rule applied to simulation: a missing proof is
  honest, a fabricated one is disqualifying.
- **The exit window is a discriminated union, so an unproven delay cannot be
  laundered into a number (day 4).** `exitWindowAssessmentSchema` is a zod
  discriminated union on `status` in which ONLY the `binding` variant has a
  `windowSeconds` field. A delay that exists but was not proven un-shortenable
  carries its raw value in `not_proven_binding.nominalDelaySeconds` — zod
  rejects any shape that would put it where a window goes. Same technique as
  `GuardStatus`, applied to the metric itself, and for the same reason: this is
  the single most dangerous place in the tool to be optimistic.
- **`checksPerformed[]` makes an empty `bypasses[]` mean something (day 4).**
  Without it, "no bypasses" is ambiguous between "we checked and found none"
  and "we never looked" — and the second presented as the first is exactly the
  false-clean result the project forbids. Every check records
  `performed`/`found`; the checks Ripcord deliberately does NOT make
  (governance proposal paths, Safe modules) are listed with `performed: false`
  and a note explaining why the gap does not make a reported delay optimistic.
- **`rolePrivilege` on every exit-window route (day 4).** AccessControl roles
  are used as markers as often as permissions, so a role route must earn its
  place in the window arithmetic with real evidence — see KNOWN EDGE #18 and
  the sUSDe fixture.
- **Time-to-exit is a LOWER BOUND with named gaps.** `atLeastSeconds` is always
  a floor; `tight` says whether that floor is believed to be the whole story
  and is deliberately hard to earn (readable dispatcher, every detected leg
  measured, nothing currently blocking). Unmeasured legs appear by name in
  `unmeasuredLegs[]` and are never treated as zero. `liquidity.modelled` is a
  literal `false`.
- **The verdict is data with its inputs attached, not prose (day 4).**
  `verdict.inputs[]` carries every input with its own confidence and source;
  `verdict.missing[]` names exactly what is absent whenever the verdict
  degrades. `marginSeconds` is published so a dead heat reads as a dead heat.
  `trapped` uses `timeToExit >= window`, not `>`.
- **The exit window's DEFAULT IS INVERTED, and "clean" must be earned (day 5).**
  The old `no_rule_change_route_found` treated the ABSENCE OF A FOUND ROUTE as
  the ABSENCE OF A ROUTE — two different claims — and let "unknown is never safe"
  leak back in at the last layer, where it is hardest to see. Calibration caught
  it: the status fired on three mainnet contracts and was substantively wrong on
  two (Balancer Vault, rETH), both of which delegate authority through an
  indirection Ripcord does not model, and a human read "No exit-window risk was
  identified" about fully-controllable contracts. It is now split in two:
  `immutable_within_checks` is a POSITIVE claim carrying the `basis[]` that
  earned it (no DELEGATECALL in the bytecode; dispatcher decoded; no indirection
  marker; no capability finding or manual-verification entry; owner/roles empty)
  plus `caveats[]` naming its bound; everything else falls through to
  `undetermined`. The verdict statement leads with the BASIS, never with
  reassurance, and its caveats populate `verdict.missing[]`. Result: 0 false-clean
  results across 26 protocols; the true negative (wstETH, all 21 selectors derived
  and checked) survived.
- **Two manual-verification reasons, because day 2's one carried two meanings
  (day 5).** `no_auth_revert_observed` (nothing recognisable came back — BLOCKS
  publication, since the unguarded reading cannot be ruled out) is now separate
  from `reverted_before_auth_check` (the contract demonstrably rejected the probe
  on a state/argument precondition, so no auth check ran — does NOT block, because
  a fact about OUR zero-valued probe supports no vulnerability reading). Neither
  ever asserts a guard exists; that claim lives in `guard.status` and requires a
  recognised auth revert. The entry stays visible either way — not blocking is not
  the same as not reporting.
- **`authorityIndirection` on every report (day 5).** Null means the check did not
  run, which is treated as "cannot rule out delegated authority", never as "none".
- **Enumeration completeness is a WITNESS the reassuring variants cannot exist
  without (KNOWN EDGE #30).** `report.enumeration` aggregates, fail-closed, over
  every site the verdict could rest on: the target's role scan, every authority
  node at any depth, every dependency token, and the stages themselves. Only the
  `binding` and `immutable_within_checks` variants carry
  `enumeration: {complete: z.literal(true)}`, so a window computed over a route
  set that may be missing entries is structurally unconstructable rather than
  merely discouraged. The direction is caution-only: `no_notice` and `trapped`
  are never softened by an incomplete enumeration, because unseen routes can only
  lower the minimum notice. And `verdict.missing[]` carries every gap on every
  branch, so no report can assert `missing: []` while one of its own
  reconstruction blocks says the role set may be incomplete.
- **Disclosure gate, enforced by the schema, not by discipline.** Every
  report carries a `disclosure` block: `publishable` is false whenever
  `needsManualVerification` is non-empty at the target OR anywhere in the
  dependency graph, with `blockedBy` naming each entry. The CLI prints a loud
  `DO NOT PUBLISH THIS REPORT` to stderr when it trips. The rule exists
  because probing cannot distinguish "guarded by an unrecognized scheme" from
  "not guarded at all," and the second reading is a vulnerability claim about
  a live contract. Day 5's published calibration set is filtered on
  `disclosure.publishable` — never on someone's per-protocol judgement under
  time pressure. See README "Disclosure policy."
- **Selector accounting.** `capabilities.selectorsExtracted` always equals
  `findings + needsManualVerification + unmatchedSelectors`. Every selector
  the dispatcher recovers is either classified or explicitly listed as
  unmatched — never silently dropped. This matters more than it looks: USDC
  exposes 55 selectors of which the day-2 taxonomy classifies 7, and without
  the count the report's "7 capabilities" would quietly read as "there are
  only 7." Unmatched means "not in Ripcord's taxonomy table," never "not
  privileged."
- **Weakest-link provenance, encoded in types (day 2).** `GuardStatus`
  (schema.ts) is a zod discriminated union on `status`: only the
  `"attributed"` variant carries a `holders` field; `"guarded_unknown_holder"`
  and `"inconclusive"` carry a `note` instead. A capability finding is
  structurally incapable of claiming an attributed holder without the
  evidence a real attribution requires — this isn't caller discipline, zod
  rejects any other shape. A capability with no auth-shaped revert observed
  from ANY probe is never in `findings` at all: it's routed to the separate
  `needsManualVerification[]` array, which can never claim "unguarded" (see
  guardProbe.ts) — only "no guard was detected."

## Conventions

- Detectors are pure functions of `(PinnedChain, target: Hex, ...) => Result`,
  no shared mutable state, each returning its own `unknowns`/evidence pieces
  for the orchestrator to merge.
- Every non-trivial function/module opens with a comment explaining *why*,
  not what — see existing files for the expected density and tone.
- No silent `catch {}`. A caught error either rethrows as `ChainReadError`,
  becomes an explicit `unknowns[]`/`errors[]` entry, or is a genuinely
  expected outcome (a revert) documented as such at the call site.
- Constants (slots, selectors, taxonomy tables) are derived in code from
  preimages/specs, not hand-copied, and asserted against independent
  reference values in tests.
- Tests: pure-logic unit tests only in CI (`pnpm test`, no network). Fixture
  verification against real mainnet targets (`test/fixtures/targets.json`) is
  run manually and every result recorded with exactly what was observed —
  not blind trust, a documented manual verification log.

## KNOWN EDGES (running list of documented limitations)

1. **Linear bytecode scan can't distinguish a contract's own code from an
   embedded child contract's bytecode.** `containsOpcode`/dispatcher walking
   is a linear walk (respecting PUSH-data lengths), not control-flow/
   reachability analysis. A factory that deploys a child via `new
   Foo(...)` embeds the child's full initcode — including its real
   DELEGATECALL/selectors — inside the parent's own runtime bytecode.
   Demonstrated live: Aave's `PoolAddressesProvider` (not itself upgradeable)
   comes back `proxy.pattern: "unknown"` because it embeds
   `InitializableImmutableAdminUpgradeabilityProxy`'s initcode. Day-2
   dispatcher-based selector extraction is exposed to the same root cause —
   see the day-2 regression test for a `new`-deploying contract.
2. **AccessControl's reconstruction has gaps (event scan; partly resolved,
   consolidation pass).** Non-enumerable role membership is reconstructed by
   replaying `RoleGranted`/`RoleRevoked` from a binary-searched deployment
   block. The scan is no longer a fixed 10k-block chunk: it probes the
   provider's real `eth_getLogs` range and chunks to it, and when the full
   history exceeds a request budget it degrades to a LABELLED partial (the new
   `authority.accessControl.reconstruction` block: `complete:false`, lowered
   `confidence`, and the exact covered window) — never a silent truncation
   (see edge 7, now resolved, and accessControl.ts). Remaining accepted
   limitation: on a small-range provider a long history is only partially
   scanned (recent window), so a role never touched in that window can be
   missed; Enumerable membership stays authoritative regardless. Also
   unchanged: this only recovers roles that were *granted* — a role wired only
   via a constructor-set default with no event emission (nonstandard) is
   invisible to it.
3a. **`proxy.pattern === "unknown"` is ambiguous for capability scanning too.**
   Discovered day 2: naively treating `isProxy:true, implementation:null`
   uniformly (as day 1's own logic does for the "confirmed proxy, unresolved
   implementation" case, e.g. a failed beacon call) would make capability
   detection skip the target's OWN bytecode entirely whenever `pattern`
   comes back `"unknown"` — silently losing real findings on exactly the
   fixture (Aave's PoolAddressesProvider) that the day-1 edge above already
   flags. Fixed in `capabilities.ts`: `"unknown"` falls back to scanning the
   target's own bytecode directly, with the ambiguity noted in `unknowns[]`
   rather than silently skipped. If the DELEGATECALL genuinely belongs to an
   unrecognized real proxy scheme (not an embedded child), the capabilities
   found may still belong to the wrong address — this is a best-effort
   fallback, not a resolution of edge 1 above.
3. **[RESOLVED day 3] Day 1 stopped at the immediate power holder.** A
   `type: "contract"` power holder (e.g. an OpenZeppelin `ProxyAdmin`) was not
   recursively resolved to *its* own owner. Day-3 recursion (authority.ts) now
   follows it — PAID's `ProxyAdmin → EOA` chain is exactly what surfaces. The
   residual limitation is edge 10: recursion follows only STANDARD authority
   (owner/AccessControl/proxyAdmin) and stops at max depth 3 or
   `no_authority_found` for custom schemes.

4. **Guard-probe revert data is provider-dependent.** `probeCall` (client.ts)
   extracts raw revert bytes from whatever the RPC node returns on a
   reverted `eth_call`; some providers don't surface revert data at all for
   some calls. Observed live: probing USDT (`0xdAC17F958D2ee523a2206206994597C13D831ec7`)
   for `pause()`/`unpause()`/`transferOwnership(address)` against a public
   mainnet RPC returned no revert data on any of the three probes, so all
   three guards report `inconclusive` rather than an attributed holder —
   correct behavior given what the provider returned, but the guard is
   genuinely undetermined only because of that provider's behavior, not
   because USDT lacks a guard. A different RPC provider might return
   revert data for the same call and produce an `attributed` result instead.
5. **The curated major-token list (dependency graph) is small and static.**
   `src/chain/majorTokens.ts` lists 6 mainnet tokens (USDC/USDT/DAI/WETH/
   WBTC/stETH), each individually verified live before being committed. A
   target holding a large position in any token NOT on this list produces
   no dependency finding for it — there is no balance-discovery/indexing,
   by design (see day-2 brief). Documented in README Limitations.
6. **Oracle dependency detection only tries three getter names** (`oracle()`,
   `priceOracle()`, `priceFeed()`) against the target directly. A protocol
   exposing its oracle under a different name, or only reachable through an
   intermediate contract, produces no oracle dependency finding.
7. **[RESOLVED, consolidation pass] The public RPC caps `eth_getLogs` at ~10
   blocks; the AccessControl event scan used a fixed 10k-block chunk that could
   never succeed on it.** Verified day 2 against blastapi (probed live this pass:
   max range = 9 blocks). The fix is now in: `rpcPreflight.probeMaxLogRange`
   binary-searches the provider's real range once, `accessControl.ts` chunks to
   it, and if the full history exceeds the request budget the scan degrades to a
   LABELLED partial reconstruction (edge 2) rather than erroring or silently
   truncating. Verified end-to-end on the new FXS fixture over blastapi: probed
   range 9, Enumerable membership authoritative, `reconstruction.complete=false`
   / `confidence:medium` with the exact covered window. IMPORTANT (verified live,
   corrects an earlier overclaim): completeness is `range × budget vs history`,
   NOT merely "is the provider paid." `complete:true` requires the probed range
   to cover the whole history within the 1500-request budget — roughly
   `range ≳ history/750`. FXS (~14.3M-block history) needs a ~19k-block range,
   larger than Infura's 10k or Alchemy PAYG's 2k, so it stays a labelled partial
   on every provider tested (both blastapi public and the provided Alchemy FREE
   key cap getLogs at ~9 blocks). Flipping to `complete:true` needs an
   unbounded-range provider or a raised `MAX_LOG_REQUESTS`. Enumerable
   membership is authoritative regardless. `.env.example` documents the provider
   requirement and every scan prints the active provider.
8. **No fallback/receive reporting.** An early attempt at this was removed:
   the `fallbackDetected` heuristic returned `true` for every real contract
   tested (WETH9, USDC, WBTC, Aave) including ones with no fallback at all —
   a constant-true flag, i.e. a flag with no evidence behind it, which rule 1
   forbids. Proving a fallback body exists (vs. the compiler's default revert
   stub) needs real CFG analysis, deliberately out of scope. `receive()`
   detection via the `CALLDATASIZE ISZERO` idiom did work, but was dead code
   (never surfaced in the report) and is misleading on its own — WETH9 accepts
   plain ETH through an old-style unnamed fallback, not a `receive()`, so
   "no receive" reads as "won't take your ETH" when the opposite is true.
   Both removed; dispatcher.ts still walks past these guards correctly (tested),
   it just doesn't report on them. Revisit for day 4 if the Exit Window metric
   needs ETH-acceptance as an input.

9. **The proof engine covers exactly ONE archetype, and its dollar figure is a
   floor (day 3).** Only CODE_CHANGE->drain on an EIP-1967 TRANSPARENT proxy via
   `ProxyAdmin.upgrade(address,address)` is simulated; UUPS
   (`upgradeToAndCall`), beacon, and legacy-zos upgrade paths return
   `produced:false` with a stated reason — deliberate depth-over-breadth (see
   Decided approaches #9), the transparent path being the one validated live
   end-to-end. Two caveats on what it does run: the drain measures only the
   curated MAJOR_TOKENS holdings (majorTokens.ts), so value in unlisted tokens,
   LP positions, or staked principal is invisible and the headline is a FLOOR,
   never a ceiling (Decided approaches #10); and because anvil impersonation
   ignores signatures, a Safe-terminated authority path is impersonated at the
   Safe ADDRESS directly, demonstrating "this Safe can if signers collude," not
   "one key can" (the PAID demo impersonates a plain EOA, so it doesn't apply
   there, but must be stated for any Safe-terminated path).
10. **Recursion resolves owner-of-owner but not arbitrary custom authority
    (day 3).** A contract power holder whose control is exposed only through a
    non-standard scheme (no owner()/AccessControl/proxyAdmin) terminates as
    `no_authority_found` at whatever depth it's reached — honest, but it means
    the path can stop short of the true controller when the mechanism is
    custom (the same class as Wasabi's unrecognised access control on day 1).
    Max depth is 3; a genuinely longer legitimate chain terminates as
    `max_depth` (explicit, never silently truncated) rather than resolving.
11. **Proof pricing depends on Chainlink feed availability at the pinned block.**
    `priceFeeds.ts` maps the 6 majors to Chainlink aggregators (WETH priced by
    ETH/USD, WBTC by BTC/USD — 1:1 wrap assumption, noted in the feed's
    `note`). A feed that can't be read yields `usd: null` for that delta with
    the reason in `priceSource` and drops `totalUsd` to null — a loud "price
    unavailable," never a silent $0 that would make a real drain look harmless.
12. **`adminCanShortenDelay` is a presence flag, not an answer (day 3).** It
    reports only whether `updateDelay`/`setDelay` exists in the timelock's own
    bytecode (the delay is mutable at all). WHO can reach that path and under
    what constraint (normally the current delay itself gates it) is day-4 Exit
    Window work, surfaced today as an open sub-finding, not resolved.
13. **[RESOLVED day 4] A capped provider made the role scan slow and
    single-transient-fragile (found live, consolidation pass).** On a small-range provider the partial
    scan still fires up to ~1500 getLogs requests (750 chunks × 2 events); on
    the Alchemy FREE key (10-block cap, per-request rate limit) a single
    transient/rate-limit failure among them raises a ChainReadError that — now
    correctly fail-loud (edge 3's catch fix) — aborts the whole accessControl
    stage into `errors[]`. This is honest (better than a silent wrong role set)
    but brittle: an AccessControl target on a capped+rate-limited provider may
    need a re-run (cached successes persist, so a retry resumes and usually
    completes). No transient-retry/backoff is built in yet — deferred, because
    distinguishing a transient 429 from a permanent failure reliably is real
    work and day-4 shouldn't wait on it. **FIXED ON DAY 4**, after this exact
    failure aborted the new sUSDe fixture's scan twice. The deferral rested on
    needing to classify transient-vs-permanent *reliably*; that requirement
    dissolves once the classification is made ASYMMETRIC instead of accurate
    (`withTransientRetry` in client.ts): a transient-looking error is retried a
    bounded number of times with backoff, anything else fails immediately as
    before, and after the last attempt the ORIGINAL error is rethrown unchanged.
    A misclassification in either direction therefore costs time, never
    correctness, and no result is ever softened into a default. Note the range
    rejection probeMaxLogRange binary-searches on does NOT match the transient
    patterns, so the preflight is not slowed. Residual: a capped provider is
    still SLOW (~1500 requests per non-Enumerable AccessControl contract) —
    day 5 still wants a large-range endpoint for speed, just no longer for
    correctness.
14. **[FIXED day 4, recorded because it was live for three days] An
    infrastructure failure on `eth_call` was cached as a REVERT.** `PinnedChain.call`
    and `probeCall` caught every error unconditionally and returned
    `reverted: true` — so a rate-limited or timed-out `owner()` was recorded,
    and then permanently CACHED, as "this function reverted," which is
    indistinguishable from a contract that genuinely has no owner. That is the
    exact false-clean result rule 3 forbids, reached through the cache rather
    than through a detector. Found on day 4 while adding transient retries.
    Both call sites now raise a ChainReadError when the failure looks
    infrastructural, so it lands in `errors[]` where infrastructure belongs; a
    genuine revert is untouched and still cached as evidence. Anyone with a
    cache populated before this fix should be aware it may contain reverts that
    were really network failures — delete `.cache/` if that matters for a
    specific claim.

15. **The exit window counts EVERY non-pendingOwner authority route, and takes
    the minimum (day 4).** This is deliberately blunt in the conservative
    direction: an un-delayed MINTER_ROLE holder drives the protocol window to
    zero even if the upgrade path is perfectly timelocked, because a rule change
    that dilutes you with no notice is a rule change. Per-route `categories`
    (cross-referenced from attributed capability findings, plus CODE_CHANGE for
    a transparent proxy's admin) let a reader see WHICH power each route
    carries, but they do not weight the arithmetic. `categories` is best-effort
    and often empty — an empty array means "nothing was attributed to this
    holder," never "this route is harmless."

16. **Self-call-gate recognition is exact-string matching, and one of the three
    forms has not been observed live (day 4).** `proven_binding` requires
    matching the canonical OZ v4 / Compound revert phrases (both read from
    mainnet before the code was written) or OZ v5's
    `TimelockUnauthorizedCaller(address)` custom error. The v5 selector is
    DERIVED via viem and asserted in tests, but no OZ v5 timelock appeared among
    the calibration targets at the pinned block, so it is derivation-correct
    rather than live-verified. The matching is tight on purpose: the only
    flexibility permitted is the contract-name prefix Compound forks vary
    (`Timelock::` → `XTimelock::`). A nonstandard timelock with an equivalent
    self-call gate phrased differently degrades to `cannot_determine` — it is
    never credited as binding, which is the safe direction, but it does mean
    Ripcord can understate a genuinely well-built custom timelock.

17. **Custom governance that holds the delay OFF the executor is not detected
    (day 4, verified live on Aave).** Aave Governance v3's `Executor`
    (0x5300A1a1…, the owner of Aave v3's PoolAddressesProvider) exposes exactly
    four selectors — `executeTransaction`/`owner`/`transferOwnership`/
    `renounceOwnership` — and NO delay accessor whatsoever; the delay lives in
    the PayloadsController, keyed by governance access level. Ripcord's
    timelock detection classifies by delay accessor, so the whole Aave chain
    terminates as `max_depth` and the window is `undetermined`. An Aave-shaped
    detector was deliberately NOT added: it would be over-fitting to one
    protocol's governance, and "undetermined, and here is the address we
    stopped at" is the honest output. The same will apply to any protocol whose
    delay is enforced by a contract other than the one holding the authority.

18. **AccessControl role membership does not establish privilege, and the
    day-4 gate that handles it can under-report (found live on sUSDe).**
    Three plain EOAs hold `FULL_RESTRICTED_STAKER_ROLE` on Ethena's sUSDe: they
    are BLACKLISTED USERS, and the first day-4 run reported them as three
    zero-notice authority routes. The `rolePrivilege` gate now requires real
    evidence (DEFAULT_ADMIN_ROLE, administers another role, or a capability
    guard attributed to the role hash) before a role route enters the window
    arithmetic. The residual limitation is the mirror image: a genuinely
    privileged role whose guard probe came back inconclusive is also
    `unverified`, so a real zero-notice route can be downgraded to
    `undetermined`. That is acceptable ONLY because of a structural property —
    an unverified route also blocks the assessment from ever reaching
    `binding` — so the gate can turn a false alarm into an honest "not
    established," never a real risk into a clean bill. Note this affects the
    EXIT WINDOW only; `powerHolders` still lists every role member, as it
    should.

19. **The cooldown/queue tables are curated and finite (day 4).**
    `timeToExit.ts` calls a versioned table of ~12 cooldown accessors and
    matches ~5 two-step request/claim selector pairs. A protocol whose exit
    delay is exposed under a name not in that table, or is stored per-user
    rather than as a global constant, produces `no_mechanism_detected` — which
    is reported at MEDIUM confidence with the caveat stated, never as proof of
    instant exit. A block-denominated accessor on a chain with no
    seconds-per-block constant yields an UNMEASURED leg rather than a converted
    guess.

20. **Liquidity depth is not modelled at all (day 4, by decision).** Whether a
    given position could actually be sold needs pool discovery and depth
    integration across venues — an indexer, which is out of scope for the same
    reason the major-token list is curated (edge 5). `timeToExit.liquidity` is
    `{ modelled: false, reason }`, and `modelled` is a zod literal `false` so
    the schema cannot express a fabricated number. Consequence to state
    whenever the metric is quoted: for a position large relative to available
    liquidity the real time-to-exit is LONGER than reported, never shorter.

21. **The proof engine still skips the queue; it now says so (day 4).** Anvil
    impersonation executes AS the resolved controller, so a proof driven from a
    timelocked authority demonstrates a capability that in reality requires N
    seconds of public notice first. Found on Comet, where the day-3 engine
    would have printed "CAN move $540,604,938.71" about a protocol with a
    2-day binding timelock. Not fixed by refusing such proofs (that would hide
    a real capability) but by attaching `noticeSeconds`/`noticeNote` to the
    Proof, sourced from the exit-window ROUTE so proof and verdict cannot quote
    different delays. The simulation itself is unchanged and still does not
    model the queue.

23. **[FIXED day 4, found by the mandated cold re-run] A cache MISS returned a
    different TYPE than a cache HIT.** `DiskCache.set` serializes bigints to
    strings because JSON has no bigint, but `wrap` handed back the raw fetched
    value on a miss — so the same pinned read produced `blockNumber: 12345n`
    cold and `blockNumber: "12345"` warm. Surfaced as a hard failure ("Do not
    know how to serialize a BigInt") on a cold scan of sUSDe, whose `getLogs`
    evidence embeds real viem log objects; it had never reproduced because
    every previous run was warm, and the one other log-scanning fixture (FXS)
    happens to cover a window containing no matching events, so its evidence
    arrays are empty and carry no bigint. The crash was the lucky part — the
    same defect silently made a COLD report differ from a WARM one in those
    evidence fields, quietly weakening the determinism guarantee the cache
    exists to provide. Fixed by normalizing on the miss path (`normalizeToCachedShape`):
    a freshly-fetched value is round-tripped through the identical
    serialization `set` uses, so miss and hit are indistinguishable BY
    CONSTRUCTION rather than by luck, including when caching is disabled so
    `--no-cache` cannot take a different code path either. Pinned by tests in
    test/cache.test.ts. **This is the FOURTH defect to enter through the cache
    boundary** (see #14 and the day-6 audit pass) and the first found before
    that audit ran — which is itself evidence the audit is correctly scoped.
    The general lesson, now stated explicitly: the cache boundary is where "a
    value from the network" and "a value from disk" must be
    INDISTINGUISHABLE — in type, in shape, and in meaning — and every place
    they are not is a bug waiting for a cold run.

24. **[FOUND AND FIXED day 5, by calibration — the one optimism-direction bug]
    `no_rule_change_route_found` conflated "no route was found" with "no route
    exists."** It fired on 3 of 26 mainnet contracts and was substantively wrong
    on 2: Balancer Vault (every permission lives in a separate TimelockAuthorizer
    reached via `getAuthorizer()`) and rETH (callers checked against a
    RocketStorage registry). Both read as "No exit-window risk was identified."
    Fixed by SPLITTING the status (see the schema invariant) and inverting the
    default so `undetermined` is what falling through produces. Recorded because
    the LOCATION is the lesson: the data layer was honest — caveats present,
    confidence `medium` — and the failure was in the composition layer, in one
    sentence, which is the last place anyone thinks to audit. Every future status
    that can be reached by NOT finding something should be read as a claim about
    the search, not about the contract.

25. **A bespoke authority registry that exposes NO getter is still invisible
    (day 5, residual).** `authorityIndirection.ts` catches a delegated-authority
    handle only when a zero-arg getter returns a non-zero address. Rocket Pool's
    rETH exposes none — its RocketStorage check is entirely internal — so the
    marker probe does not fire there. rETH was caught only because
    `mint(uint256,address)` was added to the taxonomy, producing a capability
    whose guard probe returned "Invalid or outdated contract". Had it lacked a
    taxonomy-known privileged function, the INVERTED DEFAULT would still have held
    it at `undetermined` (correct), but nothing would have explained why. This is
    exactly what `immutable_within_checks` is bounded by, and the bound is stated
    in the status name, in `caveats[]`, and on every rendered page.

26. **The guard-dialect dictionary is IN-SAMPLE, and must always be described
    that way (day 5).** Its 13 entries were found by reading the calibration set's
    own reverts, so "26 of 30 blockers were false alarms" is a statement about
    THIS set. A protocol using an unlisted dialect still blocks — Wasabi's
    `0xf07e038f` (a custom error carrying the caller; auth-SHAPED to a human, and
    a 210-candidate signature scan failed to name it) still does, correctly. The
    coverage claim is "the dictionary knows these 13 entries", never "Ripcord
    recognises guards in general." The safety property does not depend on
    coverage: unrecognised is conservative by construction.

27. **One selector, two unrelated meanings — `mint(uint256,address)` (day 5).**
    Added to the taxonomy because it is Rocket Pool's PRIVILEGED minter; it is
    ALSO ERC-4626's public `mint(uint256 shares, address receiver)`, which every
    vault exposes to everybody. Ripcord matched it on Ethena's sUSDe in the same
    run and got `InvalidAmount()` back — a zero-amount precondition, because there
    is no privilege there to find. Marked `nameMatchSpecificity: "generic"`, which
    is precisely what that field is for. The PROBE tells the two apart on evidence
    (rETH's guard fires, sUSDe's amount check fires), which is the argument for
    probing over reasoning from names. Any future taxonomy addition should be
    checked for this: selectors are not names.

28. **The role-privilege gate's false-negative rate rests on a denominator of 3,
    because the provider starves the input (day 5).** All 3 `unverified` routes in
    the set were hand-verified as genuinely non-privileged — behaviourally, not by
    reading source: sUSDe's three `FULL_RESTRICTED_STAKER_ROLE` holders cannot
    even `transfer` (all three revert `OperationNotAllowed()`) while an unrelated
    address can, so the role REMOVES power rather than granting it. 0/3 false
    negatives, 0 false positives. But the denominator is 3 because on a 9-block
    `eth_getLogs` provider the role reconstruction returns almost nothing: all
    three AccessControl targets added specifically to exercise the gate came back
    with only `DEFAULT_ADMIN_ROLE`. Aave's ACLManager provably has more
    (`POOL_ADMIN_ROLE()` and `FLASH_BORROWER_ROLE()` both resolve on-chain and
    match their keccak preimages by derivation) — at least 2 known roles missed on
    one contract. Correctly LABELLED every time (`complete:false`, lowered
    confidence, exact covered window, rendered on the page), but it means a
    large-range endpoint is now the single highest-value infrastructure change
    available to this project — for COVERAGE, not just speed.

29. **Under-determination is now the dominant error mode, and that is the
    deliberate trade (day 5; count updated day 7).** 16 of 26 protocols come back
    `undetermined` (17 until day 7, when Compound III / Comet's fork differential
    turned its unevaluated `pause` into a fork-confirmed zero-notice restrictor and
    moved it to `no_notice` — see edge #37). The
    named causes: custom authority schemes (5), Compound's delegator pattern
    (`admin()`+`implementation()` as plain getters, 2 — the marker now NAMES the
    Compound Timelock but the route is still not resolved), provider-starved role
    reconstruction (2), an owner contract with no resolvable authority (USDT, 1),
    Vyper's unrecognised dispatcher (Curve, 1), Aave's governance shape (edge 17,
    1), a custom access-control error (Wasabi, 1). Each is a concrete addressable
    gap, not a mystery. Against 0 false-clean results, this is the right way
    round — an under-determination is visible and arguable in the report; a false
    clean bill is invisible by construction — but it should be quoted honestly
    whenever the tool's coverage is described.

30. **[FOUND AND FIXED — the last plausible false-clean vector] Enumeration
    completeness was recorded and then read by NOTHING, so a partial role scan
    could not stop a reassuring verdict.** The exit window is the MINIMUM notice
    across authority routes. That arithmetic is sound only over a route set that
    was fully seen: an un-enumerated role holding a zero-notice power makes it a
    minimum of the WRONG SET, and the verdict comes out reassuring about a
    protocol nobody can leave in time. `reconstruction.complete` was written by
    accessControl.ts and consumed by no downstream layer — build.ts forwarded
    only `.roles` to capabilities, to authority resolution and to
    analyseExitWindow, so the flag reached the report as a DISPLAY FIELD and
    never as data the verdict could act on. The seam was one line.

    TWO live instances out of 26 calibration protocols, and the pair is why the
    witness had to be an AGGREGATE rather than a flag on the target:
      - Ethena Minting: its own scan covered 6,750 of 5.66M blocks and recovered
        only DEFAULT_ADMIN_ROLE (0 members). Report said `can_exit_in_time`,
        window `binding` at confidence HIGH, `missing: []`.
      - Ethena USDe: NOT an AccessControl contract at all, so a target-only check
        calls it complete — but its single route terminates at a
        TimelockController whose OWN roles were partially enumerated, and a
        timelock's PROPOSER/EXECUTOR/TIMELOCK_ADMIN holders are exactly what
        "this delay is binding" rests on. Same verdict, one hop deeper. A
        target-only fix would have closed the shallow leak and left this open.

    THE FIX, in four parts, none of which is a runtime check that can be
    forgotten:
      (a) `report/enumeration.ts` derives an aggregate witness FAIL-CLOSED.
          `complete` is a POSITIVE claim: true only where every site positively
          said so. A missing reconstruction, an `undefined` flag, a stage that
          threw, a contract whose deployment block could not be found — all
          incomplete. `=== true` throughout, never `!== false`, because reading
          an absent flag as "complete" would launder a failed read into a fact,
          i.e. rebuild this very bug inside its own fix.
      (b) The witness aggregates over the TARGET, every authority node at any
          depth (AuthorityNode gained `accessControlDetected` + `roleEnumeration`
          — two fields, so "positively not AccessControl" is never confused with
          "we failed to enumerate"), every dependency token, and the stages
          themselves (a failed stage is read from errors[], never from the
          fallback value that replaced it).
      (c) STRUCTURAL enforcement: `binding` and `immutable_within_checks` now
          carry `enumeration: { complete: z.literal(true) }`. They are
          UNCONSTRUCTABLE without the witness — zod and tsc refuse, exactly as
          GuardStatus refuses a holder without evidence. `binding` degrades to
          `not_proven_binding` (keeping the observed figure, since that variant
          already means "binding-ness OR ANOTHER ROUTE is unresolved"), and
          `immutable_within_checks` to `undetermined`.
      (d) CAUTION-ONLY, preserved: `no_notice` and `trapped` are untouched.
          Unseen routes can only ADD ways to change the rules, and an extra route
          can only LOWER the minimum — so an incomplete enumeration can never
          make a bad finding safer, and `not_proven_binding` can still reach
          `trapped` when the exit already exceeds the delay.

    Also fixed: a report could say `verdict.missing: []` while its own
    reconstruction block said the role set might be incomplete — an internally
    self-contradicting report, a credibility problem quite apart from the
    false-clean. `composeVerdict` now appends every gap to `missing[]` on EVERY
    branch, including `no_notice`/`trapped`.

    Guarded three ways so the CLASS cannot return: unit tests that simulate the
    provider cap (no endpoint dependency), fail-closed derivation tests weighted
    toward the non-answers, and a REPORT-LEVEL invariant in
    `scripts/verify-pages.mjs` that walks every report and rejects a reassuring
    verdict/window on any incomplete enumeration anywhere — deriving
    incompleteness INDEPENDENTLY of enumeration.ts, so a bug in the derivation
    cannot hide itself. That check is the report analogue of the byte-identity
    determinism gate, and it runs in CI. Result: 2 verdicts changed
    (`can_exit_in_time` → `undetermined`), 0 moved from a bad finding toward
    reassurance, 20 of 26 enumerate completely, and the 4 remaining reassuring
    verdicts all carry a complete witness. schema 0.9.0 / ruleset 0.8.0.

31. **[FOUND AND FIXED day 6, the FIFTH cache-boundary defect and the one the
    determinism gate structurally could not catch] An infrastructure failure that
    did not look TRANSIENT was cached as a contract revert.** `PinnedChain.call`
    and `probeCall` asked "does this failure look transient?" and, if not,
    recorded — and permanently cached — `reverted: true`. That is fail-OPEN, and
    it matters because ~20 detectors read a revert as a fact about the CONTRACT:
    `owner()` reverted → no owner; `DEFAULT_ADMIN_ROLE()` reverted → not
    AccessControl; `balanceOf()` reverted → holds nothing.

    Day 4's edge #14 narrowed this catch from unconditional to
    transient-throws. That was an improvement in the right direction and still
    the wrong SHAPE, because the residual set is unbounded. Reproduced live
    against a real provider (`scripts/audit-error-shapes.ts`), three ordinary
    failures matching NO transient pattern:

        bad / expired API key   -32600  "Must be authenticated!"
        unreachable endpoint    (none)  "fetch failed" / "bad port"
        block not available     -32001  "block not found: 0x…"

    The third is the one that should have been obvious for five days: EVERY
    Ripcord read is pinned to a HISTORICAL block, so a non-archive endpoint
    fails in exactly this way — and would have produced a complete,
    schema-valid, confidently CLEAN report in which every contract has no owner,
    no roles and no capabilities. It is byte-identical cold and warm, so the
    determinism gate certifies it, and once written it is permanent.

    THE LESSON, distinct from #14's and worth keeping separate: the determinism
    gate catches the STRUCTURAL failure (a miss and a hit differing in
    type/shape). It is structurally incapable of catching the SEMANTIC one — a
    read that failed, cached CONSISTENTLY as an absent fact. Consistency is not
    correctness. A gate that proves two runs agree proves nothing about whether
    either is true.

    THE FIX IS THE INVERSION, not a longer pattern list — adding those three
    strings would have closed three cases and left the class open. A result is
    now a revert only when POSITIVELY identified as one: revert bytes in the
    cause chain, viem's `ExecutionRevertedError`, RPC code 3, or the node's own
    `execution reverted`. All four derived from live observation, never memory.
    Every genuine revert observed carries the last three TOGETHER — including
    no-data reverts (edge #4's USDT case) and custom-error reverts (sUSDe's
    `OperationNotAllowed()`), which is what makes a tight classifier safe for
    this set rather than merely better in theory. Deliberately excluded: viem's
    regex also matches "gas required exceeds allowance", a gas-configuration
    failure, not a contract decision.

    Residual, and the right way round: a genuine revert phrased in a way all
    four signals miss now becomes a loud `errors[]` entry rather than a silent
    absence — visible, arguable, and withholding the enumeration witness. WETH9
    (the true-negative control) cold-scans byte-identically under it.

32. **Four more absence-from-failure sites, found by walking every read path
    (day 6).** Each was a genuine revert being read as a fact rather than an
    infrastructure failure, so #31 does not cover them:
      - `getRoleMemberCount` reverting MID-ENUMERATION returned `members: []` on
        a contract already POSITIVELY established as Enumerable. A role that
        vanishes is a route that vanishes from the exit window's minimum.
      - `balanceOf` reverting on a CURATED major token silently reported "holds
        nothing" — which also removes that token's own privileged capabilities
        from the report and can flip the disclosure gate to publishable. Every
        MAJOR_TOKENS entry was verified live as a working ERC20, so a revert
        there is an anomaly, not the ordinary "does not implement it" case that
        a reverting `owner()` is.
      - An undecodable oracle getter was a silent `continue`.
      - An undecodable pause getter left `currentlyBlocked` null, i.e. "not
        paused" — on PAID, `paused()` reading TRUE is the single most
        consequential fact in the report.
    All four now record an `unknowns[]` entry or an unmeasured leg. The sites
    where the conflation is genuinely impossible (`owner()`, `getRoleAdmin`, the
    timelock delay read, the beacon implementation decode) got a comment stating
    WHY instead — in three of those the failure direction is provably
    conservative, and that argument is now written down rather than re-derived.

33. **The gap dedup keyed on PROSE, not identity (day 6, cosmetic bug in a
    non-cosmetic place).** `composeVerdict` suppressed an enumeration gap when
    any `missing[]` entry CONTAINED the gap's `where` string. `where` for the
    target is the bare word `"target"`, so any unrelated sentence mentioning a
    target would have suppressed a REAL enumeration gap — under-reporting what
    was not seen, which is the failure edge #30 exists to prevent, reached
    through a tidy-up. Gaps now carry a structural `site: {kind, id}`, the exit
    window publishes the canonical KEYS of the sites it already narrated
    (`citedGapSites`), and dedup is key equality. A suppression can now only
    collapse two representations of the SAME site. No change to the 26.
    schema 0.10.0 / ruleset 0.9.0.

34. **[FOUND day 6 BY ACTUALLY RUNNING THE DOCUMENTED COMMAND] The prose drifted
    from the data, and nothing checked it.** `verify-pages.mjs` re-derives every
    headline figure on every rendered page from its source JSON. The SENTENCES in
    README.md, CLAUDE.md and docs/ had no equivalent, and they drifted:

      - The PAID demo beat asserted that ONE contract both moved $748.90 on a
        fork AND read `paused() == true`. That is true of NEITHER. The drain
        belongs to proxy `0x8c8687fc…` (whose report the disclosure gate BLOCKS,
        so it has no page); the frozen exit belongs to proxy `0x1614f18f…`
        (which holds none of the priced majors and correctly returns
        `produced: false`). The README's "reproduce our headline claim" command
        pointed at the address that cannot produce it.
      - The `undetermined` count was quoted as thirteen in three documents. It
        has been fifteen since the enumeration-completeness fix moved both
        Ethena protocols off `can_exit_in_time`. (Written out in words here on
        purpose: the checker matches the digit form, and this sentence exists to
        DESCRIBE the stale claim, not to restate it.)
      - CALIBRATION.md §4's per-protocol table listed Ethena USDe and Ethena
        Minting as `can_exit_in_time` while §9 of the SAME DOCUMENT explained
        that they had been moved off it. Its group counts summed to 24, not 26.

    None of these is a code defect; every report was correct throughout. That is
    precisely what makes the class dangerous — the tool was right and the story
    about it was wrong, and a jury reads the story. It was caught only because
    day 6 required running the documented commands from a clean clone instead of
    assuming they worked.

    THE FIX, deliberately mechanical rather than a promise to be careful:
    `scripts/verify-claims.mjs` checks the prose against the reports and runs in
    CI beside `verify:pages`. It verifies dollar figures against
    `proof.totalUsd`/`delta.usd`, protocol-name→verdict claims in markdown table
    rows, address→verdict claims in a paragraph, "N of 26 <verdict>" counts,
    publishable counts, page-existence for every `site/*.html` referenced, and
    that no unpublishable report has a page. Two escape hatches, both explicit
    and both scoped to the paragraph or row they appear in, because a write-up
    that records its own corrections must be able to name a wrong number:
    `[retracted-figure]` and `[was]`. It is deliberately NARROW and prints the
    paragraphs a human still has to read rather than implying full coverage —
    a claim-checker that pretended to be exhaustive would be its own false-clean.

    Proven able to fail: injecting a wrong dollar figure, a wrong verdict word
    beside an address, a wrong "N of 26" count, and a corrupted table row each
    produce a failure. That check matters more than the passing run — the whole
    point of this edge is that a green result nobody has tried to break is not
    evidence of anything.

35. **[FOUND day 6, auditing the blocked reports before publication] A SUCCESSFUL
    probe was being filed as an unreadable revert, and `no_auth_revert_observed`
    conflates two very different observations.** `probeCall` records
    `rawValue = revertData ?? "reverted"` on a revert and `result ?? "0x"` on a
    success, so a literal `"0x"` can ONLY come from a call that ran to
    completion. `scripts/manual-verification-audit.mjs` mapped `"0x"` to "(no
    revert data returned)" — so the strongest observation in the whole
    calibration set, a privileged-looking function EXECUTING for three unrelated
    addresses on a live 594M-supply token, was written up as a provider quirk
    (KNOWN EDGE #4).

    Investigated to state level rather than reasoned about: `mint` on PAID proxy
    2 is reachable by anyone, and a real fork transaction from an unrelated
    sender — and from the OWNER — succeeds with Δ totalSupply 0 and Δ balance 0.
    A garbage selector reverts on the same proxy, so there is no permissive
    fallback and the call genuinely dispatches. It is a NO-OP STUB, the expected
    shape of remediation for a deployment drained through an unguarded mint in
    March 2021. Not a vulnerability; not a privileged function either. The
    "0 genuinely unguarded privileged functions" result is unchanged and now
    better evidenced, because the one candidate that looked most like a
    counterexample was followed all the way down and cleared.

    THE RESIDUAL, deliberately NOT fixed on a lock-down day:
    `no_auth_revert_observed` covers both "the call reverted and we could not
    read it" and "the call executed and returned". The second is one step from
    "unguarded" and wants its own reason code (`executed_without_revert`) beside
    day 5's split. Both block publication today, so the GATE'S BEHAVIOUR is
    already correct and nothing unsafe follows from the conflation — only the
    reporting is coarser than the evidence. A schema reason code is a detection
    change, so it is logged as the next thing to build. The audit script now
    reports the two distinctly (`EXECUTED` vs a revert class).

    This is also the disclosure gate's first real exercise: probe could not rule
    out "unguarded" -> publishable went false -> no page was ever rendered -> a
    human looked -> harmless. Had it gone the other way, the gate would have held
    a live vulnerability claim off a public site. See docs/CALIBRATION.md §12.

36. **[FOUND AND FIXED — the flagship green result was a false-clean] Role
    enumeration was never the only way the authority picture could be
    incomplete.** Edge #30 made `binding`/`immutable_within_checks`
    unconstructable over a partial ROLE scan. Compound III passed that test — a
    fully-resolved implementation, a decoded dispatcher, a clean
    `reconstruction` — and was still wrong: `pause(bool,bool,bool,bool,bool)` sat
    in its 67 `unmatchedSelectors`, guarded, and a 5-of-N Safe named by
    `pauseGuardian()` can flip `isWithdrawPaused` to true with NO notice.
    Verified as a real fork transaction: a stranger's `pause` reverts, the
    guardian's succeeds. The report said "You can exit before the rules CAN
    change… leaving takes 0s."

    NO DETECTOR WAS AT FAULT, which is what makes it the same family as #24 and
    #30. `capabilities` listed the selector; `timeToExit.blockable` said in its
    own note that "unmatched selectors were not evaluated for privilege". But
    `blockable` is computed from taxonomy-MATCHED findings, so an unmatched
    selector is invisible to it BY CONSTRUCTION however privileged it is, and the
    composition layer turned that silence into reassurance.

    THE POINT-PATCH WAS TRACED AND REJECTED. Adding `pause` to the taxonomy does
    not fix it: the probe returns `Unauthorized()` (0x82b42900), unrecognised →
    `needsManualVerification` → Comet loses its page; and even with a dialect
    entry it lands UNATTRIBUTED, so `blockable` becomes `undetermined`, which
    yields no suffix and no status change. Green either way. It would also leave
    the next kill switch under another name invisible.

    THE RULE: a reassuring assessment may not stand while a PRIVILEGED PARTY
    exists and the PRIVILEGED SURFACE was not fully evaluated (dispatcher decoded
    AND every recovered selector classified — one resolved implementation address
    is not enough). Subtractive and caution-only, like every other gap.

    THE DISCRIMINATOR MATTERS AND WAS MEASURED FIRST. All 26 reports have
    unmatched selectors, so "any unmatched selector withholds" would have deleted
    every reassuring verdict in the set, including WETH9's — earned by deriving
    all 11 of its selectors. What makes one dangerous is that somebody holds
    privilege: WETH9/wstETH have no owner, pendingOwner, proxy admin, role
    members or indirection marker, so theirs are inert and their true negatives
    survive.

    RESULT, against predictions registered before the code: exactly 2 verdicts
    changed (Comet, Uniswap v3 Factory → `undetermined`), 0 moved toward
    reassurance, WETH9/wstETH survived, 12 more reports flipped
    `enumeration.complete` with no verdict change (caution-only holding). The
    predictions are now a CI gate in verify-pages.mjs, whose independent
    derivation grew the same dimension separately so a bug in one cannot hide in
    the other. schema 0.11.0 / ruleset 0.10.0.

    THE COST, stated: `can_exit_in_time` no longer occurs anywhere in the set,
    and is not establishable for any contract with both a privileged party and an
    unevaluated surface. Restoring it honestly needs the unmatched selectors
    EVALUATED, i.e. their signatures from a block-explorer ABI source — the
    deferred work that breaks the pinned-and-cached determinism model. The $540M
    proof is untouched and still true; only the exit claim changed.

37. **[DAY 7 — the fork differential, and the graded positive tier that must
    never become a guarantee] Reasoning about exit restriction was replaced by
    TESTING it, under an epistemic ceiling stated before the code.** `ripcord
    restrict` establishes a baseline exit on a fork and has the matched archetype's
    registered guarding party try to close it (src/fork/exitRestriction.ts). Comet is the
    anchor and resolved EXACTLY as predicted: its `pauseGuardian()` (a 5-of-9
    Safe) sets `isWithdrawPaused=true` and a baseline `withdraw` that succeeded
    before then reverts — a fork-confirmed zero-notice restrictor, so Comet moved
    `undetermined → no_notice` (the 17th undetermined became the 7th no_notice).
    Its $540M upgrade path stays timelocked, so the report shows *notice on a rule
    change* (2 days) and *the exit itself being closable* (0s) as two different
    numbers, and the window is the minimum.

    THE CEILING IS THE POINT, and it is in the types. You cannot prove safe exit —
    the absence of any restriction path over arguments, sequences, and oracle/
    liquidity manipulation is not testable, for anyone. So a clean run is the
    weaker `no_direct_restriction_found`, NOT `can_exit_in_time`, scoped to the N
    registered candidates evaluated, and intended to require a confidently identified
    exit action plus an established baseline. Three ceiling items ship verbatim on
    every evaluation (exit-action mis-ID, un-swept argument space, indirect/economic
    restrictions). The riskiest new false-clean — testing the WRONG exit action —
    is refused: an unmatched interface fingerprint → `exit_action_unconfident` →
    undetermined, never the reassuring tier.

    OUTCOME-NEUTRALITY, enforced: predictions were committed as CI assertions in
    verify-pages.mjs (`DAY7_FLAGSHIP`, `DAY7_TRUE_NEGATIVES`, structural invariants)
    BEFORE the engine was written, and break-tested (flip Comet's verdict, or strip
    its fork_confirmed → build fails). Result: exactly 1 verdict changed (Comet,
    toward caution), the true negatives (WETH9/wstETH) survived, and 0 moved toward
    reassurance. The tier fires nowhere this pass and was not forced to.

    SCOPE / RESIDUAL: ONE exit archetype and one registered restriction candidate
    (compound-comet-base versus withdraw-pause) are implemented and validated live;
    the interface table (exitActions.ts) is built so neighbours are data. The
    confirmation direction (finding a restrictor) is caution-only and safe
    to run broadly; extending it to ERC-4626 redeem, a Lido withdrawal-queue claim
    behind PAUSE_ROLE, and pausable/blacklistable ERC20 transfer is the next step,
    each needing its own baseline mechanics + a live validation before it is trusted
    — deliberately not rushed under the day-7 timebox. The subsequent fail-closed
    hardening is schema 0.13.0 / ruleset 0.12.0.

38. **[PARTIALLY RESOLVED — candidate/enum fall-throughs are closed; candidate-
    surface completeness and baseline causality remain.]** Day 7 established the confirmation direction end to end: Comet's
    baseline withdrawal succeeds, its registered guardian candidate closes the
    exit, and the identical withdrawal then reverts. That supports the current
    `no_notice` finding. It does NOT validate `no_direct_restriction_found`, which
    occurs nowhere in the calibration set.

    Two cross-field gates landed in schema 0.13.0 / ruleset 0.12.0: a candidate
    returning `inconclusive` or `not_evaluated`, and any incomplete aggregate
    enumeration site, now produce `evaluation_inconclusive` instead of falling
    through to the clean outcome. The engine records named `evaluationGaps`, the
    schema rejects inconsistent clean objects, and `composeVerdict` independently
    requires complete enumeration, exact candidate counts and every result equal
    to `no_effect`. A found restrictor deliberately survives incomplete enumeration.

    Two broader gates remain before the clean direction is relied upon: (a) a
    baseline withdrawal revert is classified `already_shut` without proving the
    pause caused it, whereas an unestablished baseline should normally remain
    undetermined, and (b) the engine covers the matched archetype's REGISTERED
    candidates, currently one Comet pause function — never every privileged
    selector in the bytecode. Until those gates land, present `restrict` as a
    demonstrated Comet restrictor detector, not a calibrated absence detector.

22. **The cleared-dependency registry is small, manual, and mainnet-only
    (consolidation pass).** `clearedRegistry.ts` documents design-not-bug
    capabilities for the 6 curated majors (USDC/USDT/DAI/WBTC/stETH; WETH has
    none). It is deliberately curated, not derived — a capability on a token or
    signature not in it still blocks publication (correct: fail toward
    not-publishable). It is VERSIONED (`clearedRegistryVersion`) and every
    report records the version it used, so a clearing is auditable and
    reversible, never a silent allowlist. It only ever clears DEPENDENCIES,
    never the target's own findings. Extending it to more tokens/chains is
    ordinary future work, not a hidden gap.

## Decided approaches (do not re-litigate)

**Fork tooling: anvil, driven from TypeScript via viem's test client.** No
forge, no Solidity test contracts, no Hardhat. The deciding reason is the
demo: the call trace IS the visual, and `cast run --trace` gives by far the
most readable output; Hardhat's traces are worse and `@ethereumjs/vm` would
mean building that presentation by hand. viem has first-class anvil support
(`impersonateAccount`, `setBalance`, snapshot/revert), so the codebase stays
entirely TypeScript and the only external dependency is one binary — which
the security people on the jury almost certainly already have. Installed
2026-08-31 (anvil 1.8.1 at ~/.foundry/bin). `src/fork/preflight.ts` fails
loud with install instructions if it's missing. Fork tests are skipped in CI
unless an RPC secret exists — marked explicitly as skipped, never silently
passing.

**Taxonomy strategy: the probe is a DISCOVERY mechanism, not just an
attribution one.** The classification percentage is the wrong number to chase
— most of USDC's 55 selectors are ERC20 reads and transfers that correctly
are not capabilities. The number that matters is the FALSE-NEGATIVE rate: did
we miss a function that actually grants privileged power? Two structural
moves, each worth more than a hundred added signatures:
  1. Any selector that produces an auth-shaped revert IS a privileged
     function, whether or not it's in the taxonomy. Categorize those as
     "uncategorized privileged function." Coverage then largely solves
     itself and the taxonomy becomes a READABILITY layer rather than the
     detection layer.
  2. To probe unknown selectors we need their signatures — fetch the ABI once
     per verified contract from a block explorer and cache it. Nearly
     everything in the calibration set is verified. Bytecode extraction stays
     the always-on base layer and the fallback for unverified contracts, and
     comparing fetched ABI against extracted selectors validates the
     dispatcher parser on every real run for free.
Day-5 measurement: walk each fixture's `unmatchedSelectors` by hand, label
which were genuinely privileged, report THAT percentage.

## Day-by-day plan

- **Day 1 (done).** Power Map: proxy pattern detection (EIP-1967 transparent/
  UUPS/beacon, EIP-1167 minimal proxy, legacy zos), Ownable owner/pendingOwner,
  AccessControl role detection (enumerable + event-reconstruction), power-
  holder classification (eoa/safe/contract), report schema, CLI, 5 verified
  mainnet fixtures.
- **Day 2 (done).** Capability detection: dispatcher-based selector
  extraction (reachability-limited, not a naive scan) with proxy-
  implementation resolution, capability taxonomy grouped by power category,
  guard attribution BY PROBING real eth_calls (not static analysis) with
  weakest-link unknown propagation encoded in the schema, unguarded-looking
  capability → `needsManualVerification` routing (never asserted as
  "unguarded"). Dependency graph one level deep: curated major-ERC20
  holdings, token-level authority/capability re-run, oracle-getter probing.
  Disclosure policy in README. All 5 day-1 fixtures still scan clean.
- **Day 3 (DONE).** Recursive authority resolution (src/detect/authority.ts):
  max depth 3, cycle detection (proven live on Aave governance), depth-degraded
  confidence, explicit termination reasons, authority PATH projection. Timelock
  detection (OZ getMinDelay / Compound delay+admin / role-only fallback),
  selectors derived + asserted; adminCanShortenDelay flagged (not solved).
  Proof engine (src/fork/*): ONE archetype, CODE_CHANGE->drain on a transparent
  proxy, impersonating the RESOLVED controller, dollar-denominated via Chainlink,
  reproduce command + cast-run trace artifact, fail-loud produced=false path.
  Verified live on day 3: a PAID proxy proof PRODUCED, moved by the depth-2 EOA.
  (CORRECTED day 6 — the figure was long quoted against the WRONG address. The
  producing target is proxy 0x8c8687fc…, whose report is disclosure-BLOCKED and
  therefore unpublished; proxy 0x1614f18f… holds none of the priced majors and
  correctly returns produced=false. [retracted-figure] The figure is retired
  from the story entirely: the dollar claim rests on Comet alone.); all
  5 fixtures still schema-valid; 76 tests green. FIRST DAY-5 TASK (noted below,
  not built): a versioned "cleared registry" of common dependencies (USDC/USDT/
  WETH/major LSTs) whose privileged capabilities are documented design, so the
  publishable filter isn't tripped merely because a protocol holds USDC — right
  now WETH9 comes back publishable=false only because it holds the majors.
- **Day 3 (original brief, for reference).** MORNING — recursive power-holder resolution + timelock
  detection, pulled forward from day 4. Rationale: without it the tool
  literally cannot see the thing that justifies the project — a 3-of-11 Safe
  shielding the business owner while the real upgrade authority is a single
  EOA one hop further (exactly the PAID fixture). It also *unloads* day 4,
  since timelock delay was day-4 work regardless, moving risk off the
  tightest day. Constraints: max depth 3; cycle detection (A owns B owns A
  happens in the wild); weakest-link applies to depth too — a holder found at
  depth 3 carries less confidence than one at depth 1 and the report must
  show that. Terminate on: EOA, Safe with threshold, timelock with delay, or
  unknown-contract-at-max-depth.
  AFTERNOON/EVENING — Proof Engine: fork-simulate the admin's own upgrade
  path, produce the call trace where funds actually leave. ONE archetype,
  fully working. Do NOT broaden the proof engine to compensate for the
  morning's work.
- **Consolidation pass (DONE, before day 4).** No new detection. Production-RPC
  preflight (provider named, getLogs range probed) + proven provider-independent
  caching; adaptive getLogs chunking with labelled partial reconstruction
  (KNOWN EDGE #7 resolved) + the first OZ AccessControl fixture (FXS); versioned
  cleared-dependency registry so holding USDC no longer trips the publish gate;
  cross-layer sweep (the authority.ts `.catch(()=>null)` infra-swallow fixed —
  the highest-value find; confidence vocabulary unified and `nameMatchSpecificity`
  renamed; every catch justified; publishable surface confirmed); docs/targets
  reconciled. schema 0.6.0 / ruleset 0.5.0.
- **Day 4 (DONE).** The Exit Window metric. `src/detect/exitWindow.ts`:
  per-ROUTE modelling with the protocol window as the MINIMUM across routes; a
  Safe modelled as zero notice (a threshold is not a delay); binding-ness
  established BY PROBE against the delay mutator (self-call gate → binding,
  role gate → shortenable, anything else → cannot_determine, never credited);
  timelock-is-itself-upgradeable checked; bypass list plus `checksPerformed[]`
  so "none found" ≠ "not checked"; the assessment a discriminated union so an
  unproven delay is structurally incapable of appearing as a window.
  `src/detect/timeToExit.ts`: versioned cooldown/two-step tables, current pause
  state, exit-blockability from day-2 ACCESS_RESTRICTION findings, a lower
  bound with named gaps, liquidity explicitly not modelled.
  `src/report/verdict.ts`: pure composition, `>=` so a dead heat is trapped,
  degrades to `undetermined` with `missing[]` whenever either side is
  unresolved. schema 0.7.0 / ruleset 0.6.0.
  Two fixtures added (the original six had no genuine timelock): Compound Comet
  cUSDCv3 (proven-binding 2-day window, instant exit → healthy) and Ethena
  sUSDe (proven-binding 1-day window vs 1-day cooldown → an exact dead heat).
  Three things day 4 found and fixed beyond its brief: an infra failure cached
  as a revert (edge 14), the transient-retry deferral from edge 13, and the
  proof engine presenting a timelocked capability as if immediate (edge 21).
  149 tests green, all 8 fixtures schema-valid with errors=[].
- **Day 5 (DONE).** Calibration against 26 mainnet protocols (8 fixtures + 18 new,
  `calibration/targets.json`), all pinned to block 25800000, 0 errors, full
  write-up in `docs/CALIBRATION.md`. Determinism gate passed FIRST and three ways
  (warm→cold→warm byte-identical), re-verified on the final ruleset (24/26
  identical; the 2 differ only by `proof` present vs null) and on the proof engine
  itself (two independent forks, identical to the cent).
  HEADLINE: **0 false-clean results across 26 protocols**; the remaining error mode
  is under-determination (13/26), which is the right way round.
  Found and fixed the one optimism-direction bug (KNOWN EDGE #24) — the
  `no_rule_change_route_found` conflation — by splitting the status and INVERTING
  the default so "clean" must be earned. Added `authorityIndirection.ts` (the small
  detection win: detect the EXISTENCE of a delegated-authority handle, never follow
  it) and `guardDialects.ts` (13 dialect entries; manual-verification entries fell
  30 → 9, publishable 13/26 → 22/26, with the boundary that unrecognised NEVER
  moves toward "guarded"). rolePrivilege gate hand-verified in both directions:
  0/3 false negatives, 0 false positives, denominator honestly caveated (edge 28).
  schema 0.8.0 / ruleset 0.7.0 / taxonomy 0.2.0. 179 tests green.
  THE RENDERER (`scripts/render.ts`): one pinned JSON report in, one static HTML
  page out — no backend, no network at render OR view time, no JavaScript on the
  page at all beyond native `<details>`. The honesty rule is ENFORCED, not
  promised: every headline figure goes through `FigureLog`, which records the JSON
  path it came from, and `scripts/verify-pages.mjs` re-checks all of them against
  the source report plus 7 more properties (no network constructs; an undetermined
  verdict never wears the healthy tone; an unproven delay always says "not proven
  binding"; a partial reconstruction shows its label and covered window; a
  positively-established no-route result is never rendered as "NOT ESTABLISHED";
  a halted exit never renders as a duration; only publishable reports get a page).
  The two-bar hero has FOUR states for a reason — known / unproven (hatched at
  nominal) / unknown (full hatch, no length to read) / none (flat tint, nothing to
  measure) — because drawing "we found nothing" the same as "there is nothing"
  would put the day-5 conflation straight back in the stylesheet.
  22 pages in `site/`, 75 figures machine-checked, 0 failures.
- **Day 5 (original brief, for reference).** Calibration against 10-15 real protocols; README/report polish.
  Published set filtered on `disclosure.publishable`. Report the FALSE-NEGATIVE
  rate, not a classification percentage — see "Taxonomy strategy" below.

  **STEP ZERO, BEFORE ANY CALIBRATION FIGURE IS RECORDED — NOT OPTIONAL:**
  ```sh
  rm -rf .cache/    # then re-run every target cold
  ```
  Day 4 found that an infrastructure failure on `eth_call` was being CACHED as
  a contract revert (KNOWN EDGE #14). Ripcord reads a revert on `owner()` as
  "this contract has no owner" — so any cache written before that fix can hold
  a network timeout that now reads as FALSE-CLEAN, permanently, on every future
  run against it. Generating fifteen calibration reports on top of such a cache
  would risk publishing precisely the failure class this tool exists to catch,
  and it is exactly what a judge would go looking for. The cache is gitignored,
  so this is independent of any commit: wipe first, re-run cold, and only then
  write a number down. Warm reruns after that point are fine — a cache built
  entirely post-fix is trustworthy again.

  **VERIFY THE `rolePrivilege` GATE IN BOTH DIRECTIONS.** The sUSDe finding
  (KNOWN EDGE #18) is not a closed case, it is one instance of a class: an
  AccessControl role can be privileged, decorative, or NEGATIVE (marking bad
  actors, as `FULL_RESTRICTED_STAKER_ROLE` does). The two failure directions
  are not symmetric and must not be treated as such:
    - Marking a NON-privileged role as privileged = a false alarm. Annoying,
      and visible — it appears in the report where someone can dispute it.
    - Marking a genuinely PRIVILEGED role as unverified = real power silently
      disappearing from the report. That is FALSE-CLEAN, the failure this
      project cannot afford, and it is invisible by construction.
  So for every role the gate labels `rolePrivilege: "unverified"` across the
  calibration set, MANUALLY verify that it truly confers no privilege (read the
  verified source, check what the role actually gates). This is a calibration
  TASK with a recorded result per role, never an assumption. Report the count
  of unverified roles checked and how many turned out to be genuinely
  privileged — that number is the gate's false-negative rate and belongs
  alongside the taxonomy's.

  **DEMO BEATS (decided day 4, from the fixture results).** Run PAID and Comet
  back to back — they are the pair that proves the tool DISCRIMINATES rather
  than alarms, which is the test this jury will fire:
    - PAID (0x1614f18f…, `no_notice`, page published): NO dollar figure — see
      the correction below. Both authority routes terminate at plain EOAs with
      no delay anywhere, AND `paused()` reads TRUE at the pinned block, so the
      exit is not slow, IT IS SHUT. You cannot leave slowly; you cannot leave at
      all. (This is the contract PAID redeployed after its March-2021 incident;
      Ripcord just reads the current state.) A frozen exit is a livelier trapped
      case than any small drain simulation.
    - Comet (0xc3d688B6…, `can_exit_in_time`): the power is enormous —
      $540,604,938.71 moved, proven on a fork, reproducible to the cent across
      two independent forks — BUT it is bound: a proven-binding 2-day notice
      against an instant exit. Same engine, opposite verdict.
  **CORRECTED DAY 6 — do not reinstate the $748.90.** [retracted-figure] The old beat asserted that
  ONE contract both moved $748.90 and read `paused()` TRUE. That is true of
  NEITHER: the drain belongs to proxy 0x8c8687fc… (whose report the disclosure
  gate BLOCKS, so it has no page), and the frozen exit belongs to proxy
  0x1614f18f… (which produces no proof at all). The dollar figure now rests
  entirely on Comet, which is stronger anyway — $540M is the number that lands,
  and $748 on a dead contract never was. If a "the gate blocks me" beat is
  wanted, use sUSDe: a verdict-level `trapped` case explainable in one sentence,
  rather than a probe edge case (empty revert payload, edge #4) that costs demo
  time to explain.
  The two halves of the story come from two different engines (proof engine =
  the SIZE of the power; exit window = whether you can escape it), and the
  notice figure in the proof headline is read from the same exit-window ROUTE
  the verdict uses, so they can never quote different delays. Say that out
  loud — the internal consistency is the point, not a detail.
  **Framing note for Aave:** present `undetermined` on a large protocol as the
  tool REFUSING TO GUESS at a governance structure it has no verified model for
  (the delay lives in Aave's PayloadsController, keyed by access level — see
  KNOWN EDGE #17), never as "the tool does not work on large protocols." The
  distinction is the whole honest-tool argument and it is lost if the framing
  slips.
- **Enumeration-completeness fix (DONE, before day 6).** No new detection: a
  correctness + propagation fix and its tests, closing the last plausible
  false-clean vector found in day-5 calibration (KNOWN EDGE #30). Role
  enumeration goes partial on a capped provider, was correctly LABELLED partial,
  and that label reached NOTHING downstream — so the exit window's
  minimum-across-routes arithmetic ran over a route set that may have been
  missing entries. Two live instances of the resulting false-clean, and the
  second (Ethena USDe: not an AccessControl contract itself, partial scan on its
  DEPTH-1 TIMELOCK) is why the witness had to aggregate over every route at every
  depth rather than sit on the target. Fixed fail-closed, enforced structurally
  via `z.literal(true)` witnesses on the two reassuring assessment variants,
  caution-only in direction, plus a report-level invariant in verify-pages that
  runs in CI and derives incompleteness independently. 2 verdicts changed
  (`can_exit_in_time` → `undetermined`), 0 moved toward reassurance, 200 tests.
  schema 0.9.0 / ruleset 0.8.0. **The pitch case:** Ripcord told a real, large
  protocol "you can exit in time" while an un-enumerated minter could dilute a
  holder with no notice — and corrected itself to `undetermined` on calibration
  day, from its own recorded evidence. That is the whole thesis in one case.
- **Day 6 (DONE — see edges #31/#32/#33 and docs/CALIBRATION.md §10/§11).** **FIRST: the cache-boundary audit pass.** FOUR separate defects
  have now entered through the same seam — the `authority.ts` `.catch(() => null)`
  that turned a network outage into "no roles found" (consolidation pass), the
  docs overclaiming `getLogs` completeness (consolidation pass), an
  infrastructure failure cached as a contract revert (day 4, KNOWN EDGE #14),
  and a cache miss returning a different TYPE than a cache hit (day 4, KNOWN
  EDGE #23, found by the mandated cold re-run). Four instances of one class is
  a systemic weakness, not coincidence: **the cache boundary is where a failure
  gets laundered into a fact, and where a value from the network and a value
  from disk stop being indistinguishable.**
  Two distinct failure modes to walk, because they need different checks:
    (a) SEMANTIC — something that is really "we could not read this" gets
        stored, and later read back, as "we read this and it was empty/absent."
        Walk every `catch` in the read path; every place a revert, an empty
        result, a zero word, or an absent key is treated as a fact about the
        CONTRACT rather than about the READ; and every cache write that can
        record a non-answer.
    (b) STRUCTURAL — a miss and a hit differ in type or shape, so behaviour
        depends on whether someone ran the scan before. #23 was this. The
        general test is cheap and should be made routine: **wipe the cache and
        re-run; a cold report must be byte-identical to a warm one.** That
        single check would have caught #23 immediately and is now the day-5
        step-zero procedure anyway.
  Each site either gets a comment explaining why the conflation is impossible
  there, or gets fixed. This is most likely the last category of latent bugs in
  the project, and it is far better closed by us than opened by a judge.
  THEN (optional, if time remains): Watchtower — live monitoring of timelock
  queues, alerting when a rule change is actually queued.
- **Day 7 (DONE — see KNOWN EDGES #37/#38 and docs/CALIBRATION.md §14).** The fork
  differential: `ripcord restrict` stops reasoning about exit restriction and
  TESTS one registered path on a fork — identify the exit action, establish a
  baseline exit, then impersonate the matched archetype's guarding party, call it
  with the exit-restricting argument, and re-run the exit. A found restrictor is decisive; a clean run is designed to earn
  only the deliberately weaker `no_direct_restriction_found` (scoped, never a
  safety guarantee, unreachable without exit-action ID + baseline). New modules:
  src/fork/exitActions.ts (versioned interface fingerprints + whales),
  src/fork/exitRestriction.ts (the engine, ONE archetype + ONE candidate — Comet
  base-withdrawal versus withdraw-pause — validated live),
  src/report/applyExitRestriction.ts (pure merge + re-compose).
  Schema gains `exitRestriction` + the verdict status + route confirmation fields;
  subsequent candidate/enumeration hardening is schema 0.13.0 / ruleset 0.12.0.
  Predictions registered as CI assertions FIRST
  (outcome-neutral, break-tested); exactly one verdict changed — Comet
  `undetermined → no_notice`, fork-confirmed via the pauseGuardian Safe — the true
  negatives survived, and nothing moved toward reassurance. 275 tests green; the
  determinism gate (cold==warm) holds on the reproducible reports and on the
  Comet restrict report (two independent forks, byte-identical). The confirmation
  direction is architected to extend broadly to neighbour interfaces; that
  extension is the next step, not rushed under the timebox.
