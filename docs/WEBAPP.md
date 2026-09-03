# The Ripcord webapp

A browser front end around the existing engine. A visitor enters a contract
address, watches the analysis happen, follows a real fork experiment, and gets a
report with its evidence attached.

Nothing here re-implements analysis. Every label, notice, verdict, uncertainty
and figure on screen comes from the same engine functions the CLI calls, and the
webapp's job is transport and presentation.

---

## 1. What it is made of

```
src/            the existing engine — untouched except for optional observer hooks
server/         API, job runner, event transport, storage, DTOs
web/            React + Vite frontend
dist-server/    compiled server (tsconfig.server.json)
dist-web/       built frontend (vite.config.ts)
```

One process serves the built frontend, the API, the progress stream and the job
runner. One public port. `anvil` is spawned transiently by a job worker, binds
loopback, and is never exposed.

| Piece | File | What it is responsible for |
| --- | --- | --- |
| Config | `server/config.ts` | Env → typed config, validated at startup. A missing RPC is a **supported state**, not a crash. |
| Sanitiser | `server/sanitize.ts` | Strips RPC URLs (which are provider keys) out of every outbound error. |
| Validation | `server/validate.ts` | Address, chain, block, mode, contract-code presence. Resolves `latest` **once**. |
| Store | `server/jobs/store.ts` | Atomic writes, safe id→path resolution, interrupted-job recovery, retention. |
| Manager | `server/jobs/manager.ts` | Queue, worker lifecycle, event sequencing, cancellation, timeouts. |
| Worker | `server/jobs/worker.ts` | A forked child that imports the engine directly. |
| Observer | `server/jobs/observer.ts` | Engine observations → transport events, and the early-stream boundary. |
| Reports | `server/reports.ts` | The **only** place the publication gate is enforced for outward transports. |

### The engine is imported, never shelled out to

`server/jobs/worker.ts` imports `buildReport`, `runProofEngine`,
`runExitRestrictionEngine` and `applyExitRestriction` directly. It does **not**
run `src/cli.ts` and does **not** parse the CLI's terminal output — those strings
are written for a person reading a terminal, and treating them as a protocol
makes every wording change a silent breakage. `scripts/verify-webapp.mjs` fails
the build if any server module imports the CLI.

### The observer cannot change a report

`src/report/observer.ts` adds optional, typed progress hooks to `buildReport` and
`runExitRestrictionEngine`. They are additive by construction: every hook is
optional, returns void, receives already-computed values, and is invoked through
a `notify` helper that contains a throwing callback rather than letting it abort
an analysis.

`test/observer.test.ts` asserts the property directly — the same report built
with and without an observer is **byte-identical**, and a hostile observer that
throws on every hook produces the identical report too.

---

## 2. Run modes

| Mode | What runs | Equivalent CLI |
| --- | --- | --- |
| `scan` | `buildReport` only. No fork. | `ripcord scan` |
| `scan_withdrawal_test` | `buildReport` → `runExitRestrictionEngine` → `applyExitRestriction` | — (no exact CLI equivalent) |
| `scan_withdrawal_test_upgrade_proof` | the above **plus** `runProofEngine` | `ripcord restrict` |

**The middle mode is deliberately not `ripcord restrict`.** The CLI's `restrict`
also runs the upgrade-drain proof; the web's default flow does not, because
spawning a second fork doubles the wait for a beat the withdrawal differential
does not need. The CLI's semantics are unchanged, and the third mode exists so
the full `restrict` behaviour is still reachable — as an explicit choice, with
its own phase and its own evidence block.

A consequence worth stating: **in `scan_withdrawal_test`, `report.proof` is
`null`.** No drain figure from a stored report is ever shown next to a run that
did not produce one.

---

## 3. What may stream before the disclosure gate has run

The publication gate (`disclosure.publishable`) is decided at the **end** of a
scan. Until then, a capability whose guard could not be attributed is undecided —
and streaming its signature would publish a possible "this live contract may be
unguarded" reading that the gate might be about to block. Once a browser has it,
no later decision takes it back.

So the boundary is drawn in `server/jobs/observer.ts`:

**May stream early** — proxy pattern and slots, implementation, proxy admin,
owner and pending owner, role holders, the authority chain with its termination
reasons and confidences, indirection markers, phase progress, and *counts* from
the capability stage.

**Never streams early** — capability signatures, selectors, guard-probe payloads,
manual-verification entries. Those reach a browser only through
`GET /api/reports/:id`, after the gate has been checked.

The `onCapabilities` hook is deliberately an empty method with a comment saying
why, and `safeMetrics` drops anything from the capabilities stage that is not a
plain number or boolean — so a future metric carrying a signature cannot start
streaming just because somebody added a field upstream.

### The gate on every transport

`ReportService.loadPublishable` is the only function that loads a report body.
HTML, JSON and download all go through it. A blocked report returns **451** with
a neutral message and **no report bytes at all** — there is no variant of that
function returning a body plus a "do not display" flag, and hiding with CSS is
not withholding. Blocked reports are also absent from `GET /api/reports`: a row
reading "withheld: *protocol*" is itself a signal about that protocol.

Blocked reports *are* still stored. They are evidence, and their author may need
them; what changes is who may read them.

---

## 4. Jobs, progress and reconnection

`POST /api/jobs` answers **202** with a job id immediately. The analysis keeps
running server-side; closing the tab does not cancel it, and a disconnected
consumer cannot change the outcome.

**Every event carries a monotonic per-job `seq`.** A client resumes from its
cursor. If that cursor has fallen off the bounded history the server sends a
`resync` frame and the client re-snapshots from `GET /api/jobs/:id` — returning
the surviving tail silently would render as a complete timeline missing its
middle.

**SSE with polling as a first-class fallback.** Both read the same event log
through the same cursor, so they cannot disagree. Corporate proxies buffer
`text/event-stream`; a demo that dies behind conference wifi is worse than one
that polls.

**No invented progress percentage.** The engine does not know in advance how many
RPC round-trips a role reconstruction takes. Discrete phases with real statuses
say more and claim less.

### Four non-pending phase statuses, and why the distinctions matter

| Status | Meaning |
| --- | --- |
| `completed` | Ran and answered. A zero-result answer counts — "no roles exist here" is an answer. **The only green, and it means the step finished, never that the contract is safe.** |
| `inconclusive` | Ran and could not answer. First-class in this project, not a failure. |
| `degraded` | Threw, and a fallback value was substituted. **Never green** — a stage that actually failed, shown as done, is the false-clean this codebase exists to refuse. |
| `failed` | Stopped the run. |

### Cancellation needs its own token

`POST /api/jobs/:id/cancel` requires the `controlToken`. The browser generates it before submitting and retains it through retries; clients that omit it receive a server-generated token once.
A job id travels in shareable links; if the id sufficed, anyone with a link could
kill someone else's run. Only a SHA-256 of the token is stored, and it is
compared in constant time.

### Idempotency

A resubmit with the same `idempotencyKey` **and the same parameters** returns the
existing job rather than queueing a second heavyweight scan. Reusing a key
against different parameters is rejected. A deliberate re-run simply
omits the key and gets a new execution id.

---

## 5. API

| Endpoint | Notes |
| --- | --- |
| `GET /healthz` | Cheap, **touches no chain**. Answers whether this process is healthy. Whether live analysis is possible is a separate field in `/api/config`. |
| `GET /api/config` | Public settings, available modes, limits, provider **host** (never the URL), anvil availability, presets. |
| `POST /api/jobs` | 202 + job id + control token. |
| `GET /api/jobs/:id` | State, phases, structural snapshot, `lastSeq`. Carries **no report payload**. |
| `GET /api/jobs/:id/events` | SSE. `?after=` or `Last-Event-ID` resumes. |
| `GET /api/jobs/:id/events/poll` | Polling fallback, same cursor semantics, reports `truncated`. |
| `POST /api/jobs/:id/cancel` | Requires the control token. |
| `GET /api/reports` | Publishable reports only. |
| `GET /api/reports/:id` | 200, or **451** for a blocked report, or 404. |
| `GET /api/reports/:id/download` | Same boundary. |

Downloads contain no provider key, server path or control token: report evidence
records the node's raw values, never the endpoint they came from.

---

## 6. Storage

Everything lives under `RIPCORD_DATA_DIR`, in separate subdirectories:

```
jobs/       job records            reports/    reports + .meta.json sidecars
events/     JSON-lines event logs  artifacts/  per-job fork artifacts
rpc-cache/  the pinned RPC cache — existing key semantics untouched
```

The web worker places the existing `(chainId, blockNumber, method, params)` cache
inside a block-hash namespace. Admission verifies `eth_chainId` and a block hash;
the worker checks that identity before and after all work, and each Anvil fork
checks its initial block hash. A changed identity refuses publication. The CLI
cache behavior is unchanged. Hash buckets are retained for up to seven days,
16 completed block identities or 512 MiB; active buckets and buckets younger than
one hour are protected, so those limits are soft during active work.
Jobs and event histories are bounded in memory as well as on disk (200 jobs,
500 reports). Shared report links can expire after report retention. Cache writes
use a temporary file and atomic rename so cancellation cannot leave a partial
JSON entry that a later run treats as chain state.

**Ids from URLs never become paths.** `safeJoin` validates against a strict
character class *and* checks the resolved path is still inside its directory.
There is no public file server over `calibration/` or the job data directory;
committed reports are served from an explicit allowlist built at startup.

**After a restart, jobs that were `running` or `queued` become `interrupted`** —
not resumed, not completed. Nobody knows how far they got, and manufacturing a
result would be the same false-clean this project refuses everywhere else,
reached through a deploy instead of a detector.

---

## 7. Errors

Every failure is classified into a product-level code with a next step
(`server/sanitize.ts`). The rule the wording follows: **an RPC failure is a fact
about our infrastructure, never a property of the contract.** A missing archive
endpoint says "this analysis needs an archive endpoint", and adds "no conclusion
about the contract follows from this".

Sanitisation is broad by shape rather than by provider allowlist — any URL, any
long opaque token, any absolute path. viem embeds the request URL in its errors
and anvil prints its `--fork-url`; on every mainstream provider that URL *is* the
key. Over-redacting costs a slightly less specific hint, which is worth paying
every time.

---

## 8. Local development

```sh
pnpm install

# One command starts both the compiling API watcher and Vite on its own port.
pnpm dev:webapp

# Alternatively: pnpm dev:server in one terminal, pnpm exec vite in another.
# Do not start dev:server separately alongside dev:webapp.
```

Production build and run:

```sh
pnpm build:webapp        # tsc -p tsconfig.server.json && vite build
pnpm start:webapp        # node dist-server/server/index.js
```

`pnpm start:webapp` runs **compiled output**. Build first, or it will tell you
the worker is missing and how to fix it.

To enable real analysis locally:

```sh
export RPC_URL_1="https://…"          # an ARCHIVE endpoint, see below
export RIPCORD_ENABLE_LIVE_RUNS=true
pnpm start:webapp
```

The RPC must serve **historical state**: every read is pinned to a block. A
non-archive endpoint fails with `rpc_missing_history`, which the UI reports as an
infrastructure gap rather than a finding.

### Verification

```sh
pnpm typecheck        # CLI + server + web, three tsconfigs
pnpm test             # unit tests, no network
pnpm verify:webapp    # the six structural webapp boundary properties
pnpm verify:boundary  # the Mobula live-layer boundary
pnpm verify:pages     # rendered calibration pages vs their source JSON
pnpm verify:claims    # prose vs reports
```

---

## 9. What is deliberately not here

No wallet connection (this flow needs no signature and sends no mainnet
transaction), no database, no Redis, no accounts, no payments, no watchtower, no
new chain and no new exit archetype. The withdrawal differential covers what the
engine actually supports — one exit archetype, one registered restriction
candidate — and any other interface reports honestly why the experiment did not
run, with the scan still fully usable.

## Review hardening

- Before publication, graph edges use structural sources only; capability-derived
  holders and relations stay gated. Blocked scans do not execute the optional
  proof or withdrawal stages, and no detailed verdict is emitted for them.
- Every report response/download and progress event uses a public projection
  that removes provider URLs, configured credentials and infrastructure paths.
  Public addresses, hashes, calldata and raw amounts remain intact. The download
  is a sanitized projection, not a byte-identical internal artifact.
- Admission, duplicate intents and job writes are serialized. A lost response
  can be retried with the same key and client cancellation capability without
  resolving `latest` again or starting another scan. Capacity is checked before
  expensive RPC validation, with at most 12 new attempts per minute. Error responses never discard the browser's token.
- Workers own detached process groups on Linux/macOS. Every terminal path sends
  SIGTERM to that group, then SIGKILL if it remains alive. A signal-sent flag is
  never treated as proof of exit; queue capacity is released after worker exit.
- Job snapshots include A/B/C fork blocks, exact raw reads, phase timing and
  scan read-operation/cache-hit counts. These counts exclude fork traffic and
  transport-level retries. Named SSE heartbeats switch a buffered stream to
  polling after 35 seconds; terminal jobs detach listeners.
- Saved reports use the same transaction projector as live events. Historical
  reports are explicitly marked legacy when current full-position checks or
  receipt timestamps are unavailable. A receipt is never presented as an
  economic proof; candidate calls are never presented as confirmed closure.
- Public report pages include the power map and inspectable evidence. Token
  amounts use exact decimal formatting, with raw base units available alongside.

The Docker smoke job builds without credentials, mounts a fresh root-owned data
volume, and checks boot and saved-report access. This checks deployment mechanics;
it does not validate an archive RPC or a live mainnet fork. Before presenting,
run the chosen target on the deployed service and record a backup demo.

---

## 10. Assets & analysis coverage

A panel on the report and analysis views that answers, per asset: was it seen in
the Mobula snapshot, was its balance established at the analysis block, was it in
a fork experiment, what did that experiment show, and what was never examined.

**It is a scope view, not a risk score.** There is no ladder from "found" to
"safe", no coverage percentage and no share-of-value-tested. A percentage would
need a denominator, and nothing here establishes a complete asset inventory.

### Where it lives

`server/coverage.ts` exposes `buildAssetCoverage(report, liveExposure)` — a pure
function of two artifacts that already exist. It performs **no** chain read, RPC
call, fork or Mobula fetch. That is deliberate: a composer that could fetch the
missing piece would erase the gaps this panel exists to display.

It sits outside the pinned chain. `src/report`, `src/detect`, `src/chain` and
`src/fork` do not import it or Mobula, its output never enters the deterministic
report JSON, and it is served as a separate envelope at
`GET /api/reports/:id/coverage` — through the same `loadPublishable` gate as
every other report transport, so a blocked report returns **451** here too.

### Three independent characteristics

| Characteristic | States |
| --- | --- |
| **Mobula observation** | `observed` · `not_listed` · `chain_unclear` · `unavailable` |
| **Balance at the analysis block** | `verified` · `read_failed` · `no_recorded_evidence` · `different_chain` |
| **Fork experiments** | zero or more records, each with its own kind, account, execution status and caveats |

They are independent. An asset can be observed with no on-chain evidence, have a
verified balance and no experiment, or appear only in an experiment.

### The judgements that keep it honest

**A missing dependency entry is not a zero balance.** `detectDependencies`
records an entry only for a **non-zero** balance and `continue`s otherwise, so a
genuine zero leaves no artifact at all. Absence is therefore unusable as
evidence, and the panel says `no_recorded_evidence` with that reason spelled out.
A *failed* read is different — that one **is** recorded as an `unknowns[]` entry —
so the two are told apart.

**Curated-list membership is eligibility, never evidence.** Being on
`MAJOR_TOKENS` means the asset was eligible to be checked, not that it was
checked in this run.

**Identity is (chain, address).** Mobula reports `evm:1`, the report reports `1`;
both normalise to `evm:<n>`. A source with no usable chain yields a null chain
reference, and a null reference can never produce a positive match. Native assets
are keyed `evm:N|native` — the `0xeeee…` sentinel is identical on every chain
while meaning a different asset on each.

**Account scope travels with every experiment.** The withdrawal baseline
exercises a **sandbox holder** Ripcord funded on the fork, not the target. A
successful sandbox withdrawal of USDC is never rendered as "the target's USDC was
withdrawn". The upgrade proof is separate, carries the impersonated controller,
and the two never collapse into one green tick.

**Fork linkage must be earned from evidence.** An asset is attached to the
withdrawal experiment only when the report carries a `baseToken()` read whose
recorded `params.address` is the target. Reports written before that parameter
existed return "Could not establish asset-level test coverage" instead of being
linked by protocol name or archetype — visible on the committed Comet report,
whose upgrade proof *is* linkable (its deltas name the token) while its
withdrawal test is not.

**Historical results keep their version.** A report from an earlier ruleset
carries an explicit caveat that it has not been re-run under the current
full-position and causality checks.

### Counts and the two clocks

Counts are computed, scoped and overlapping — never combined:

> 5341 entries available in this snapshot · 12 shown here · 6 with recorded
> target-balance evidence · 0 in a withdrawal experiment · 0 in an upgrade proof

The shown subset is never presented as the whole inventory: the floor, the
display cap and each withheld bucket are rendered above the table.

The Mobula snapshot and the pinned block are shown as **separate observations**
with their own timestamps. A difference between them is not an inconsistency, and
a stored snapshot keeps its original `fetchedAt`.

### Mobula is optional

Snapshots are read from committed sidecars (`calibration/live/`), indexed by
**(chain, target)** — never by file or protocol name, so a fresh scan of a target
reuses the snapshot for that same address with its original fetch time intact. A
missing or unreadable snapshot makes the panel **partial**: Mobula reads
`unavailable` and every pinned balance and fork observation is still shown. It
can never fail a scan, a fork, or the report page.
