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

src/detect/
  bytecode.ts     Dependency-free bytecode helpers: EIP-1167 clone matcher,
                   Solidity CBOR-metadata-trailer stripper, containsOpcode
                   (linear scan respecting PUSH1..PUSH32 immediate lengths).
  proxy.ts        Proxy pattern detection (see classification order in file
                   header). Resolves one hop through a beacon's implementation().
  ownership.ts    owner()/pendingOwner() (Ownable-style).
  accessControl.ts OpenZeppelin AccessControl detection: Enumerable getters
                   when available, else reconstructed by replaying
                   RoleGranted/RoleRevoked from deployment block (chunked,
                   capped at 500×10k-block chunks — beyond that, explicit
                   unknowns[], never a silently truncated role list).
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
                   one address. Resolves the correct scan address first: the
                   implementation for a confirmed proxy, but the TARGET's own
                   bytecode when `proxy.pattern === "unknown"` (day-1's
                   DELEGATECALL-found-but-unclassified case) — see KNOWN
                   EDGES #3a for why those two isProxy-true cases must be
                   handled differently. Guard attribution reads owner/
                   AccessControl state from the ORIGINAL target, never the
                   implementation (same storage-location reasoning as
                   ownership.ts/accessControl.ts).
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

src/report/
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
  report rather than decoration. Both bumped to 0.2.0 on day 2.
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
2. **AccessControl's reconstruction has gaps.** Non-enumerable role
   membership is reconstructed by replaying `RoleGranted`/`RoleRevoked` from
   a binary-searched deployment block; the scan is capped at 500×10k-block
   chunks (5,000,000 blocks) and abandons (explicit `unknowns[]`, never
   silent truncation) beyond that. Also: this only recovers roles that were
   *granted* — a role wired only via constructor-set default with no event
   emission (nonstandard) would be invisible to it.
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
3. **Day 1 stops at the immediate power holder.** A `type: "contract"` power
   holder (e.g. an OpenZeppelin `ProxyAdmin`) is not recursively resolved to
   *its* own owner. Verified manually on PAID Network fixtures where the
   ProxyAdmin's owner is a plain EOA one hop further than Ripcord looks.
   Day-2 dependency graph goes one level into token/oracle dependencies, not
   into recursive owner-of-owner resolution of contract power holders — that
   remains unresolved after day 2 too.

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
- **Day 3.** Proof Engine: fork-simulate the admin's own upgrade path, produce
  the call trace where funds actually leave.
- **Day 4.** Exit Window metric: upgrade/admin-change delay (minus bypass/
  shortcut paths) vs. real time-to-exit (unstaking, withdrawal cooldowns,
  queues, liquidity depth).
- **Day 5.** Calibration against 10-15 real protocols; README/report polish.
- **Day 6 (optional).** Watchtower: live monitoring of timelock queues,
  alerting when a rule change is actually queued.
