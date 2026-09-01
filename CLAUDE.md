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

src/report/
  verdict.ts      (day 4) PURE composition of the two sides — no chain access,
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
                   failures (bad RPC, bad args) exit non-zero.
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
  Verified live: PAID v1 proof PRODUCED ($748.90 moved by the depth-2 EOA); all
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
- **Day 5.** Calibration against 10-15 real protocols; README/report polish.
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
    - PAID: the power is there ($748.90 moved, proven on a fork) and you cannot
      leave — zero notice, and the live token's `paused()` reads TRUE at the
      pinned block, so the exit is not slow, it is shut.
    - Comet: the power is there and far larger ($540,604,938.71 moved, proven
      on the same fork) BUT it is bound — a proven-binding 2-day notice against
      an instant exit. Same engine, opposite verdict.
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
- **Day 6.** **FIRST: the cache-boundary audit pass.** Three separate
  false-clean results have now entered through the same seam — the
  `authority.ts` `.catch(() => null)` that turned a network outage into "no
  roles found" (consolidation pass), the docs overclaiming `getLogs`
  completeness (consolidation pass), and an infrastructure failure cached as a
  contract revert (day 4, KNOWN EDGE #14). Three instances of one class is a
  systemic weakness, not coincidence: **the cache boundary is where a failure
  gets laundered into a fact.** The mechanism is always the same — something
  that is really "we could not read this" gets stored, and later read back, as
  "we read this and it was empty/absent."
  So: walk EVERY path where a cached value can be interpreted as clean, and
  justify each one in writing. Concretely — every `catch` in the read path;
  every place a revert, an empty result, a zero word, or an absent key is
  treated as a fact about the contract rather than about the read; and every
  cache write that can record a non-answer. Each site either gets a comment
  explaining why the conflation is impossible there, or gets fixed. This is
  most likely the last category of latent bugs in the project, and it is far
  better closed by us than opened by a judge.
  THEN (optional, if time remains): Watchtower — live monitoring of timelock
  queues, alerting when a rule change is actually queued.
