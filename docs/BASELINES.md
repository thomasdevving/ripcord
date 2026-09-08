# Engineering baselines

Correctness tests answer whether Ripcord preserved its safety invariants. They
do not answer whether selector coverage is shrinking or reports are becoming
materially more expensive to store and transport. These baselines make those
two questions visible without requiring an RPC endpoint.

## Report corpus

```sh
pnpm baseline:reports
pnpm verify:report-baseline
```

`baseline:reports` measures every committed calibration report. It verifies that
each recovered selector is accounted for as classified, manual-verification, or
unmatched, then reports selector coverage, report bytes, and repeated evidence
bytes. `verify:report-baseline` compares those deterministic metrics with
`calibration/report-baseline.json` and runs in CI.

The snapshot is a change detector, not a maximum. A larger report or changed
coverage can be correct, but it must be reviewed and the snapshot updated
deliberately. It never treats an unmatched selector as harmless.

## Selector analyser

```sh
pnpm benchmark:selectors
pnpm benchmark:selectors -- --iterations 500 --rounds 9
```

This runs the selector adapter over four real runtime-bytecode fixtures and
prints the exact analyser identity, input sizes, recovered counts, median time,
and operations per second. Timing is intentionally not committed or enforced in
CI because it depends on hardware and process load. Record the JSON output when
comparing branches on the same machine.

This is a CPU boundary benchmark, not a whole-analysis load test. RPC latency,
role-event history, authority-graph breadth, Anvil startup, and evidence
transport remain separate capacity measurements.

## Report resource budget

Every report produced from schema 0.15.0 carries a `budget` block: the limits it
ran under, what it consumed in each dimension, and every boundary it met.

```sh
pnpm ripcord scan <address> --block <n> | jq .budget
```

The four dimensions count **logical work** — reads requested, log requests,
authority nodes visited, role members enumerated — never elapsed time and never
network attempts. That is not a stylistic choice: a warm run makes zero network
calls and a cold run makes thousands, so a budget exhaustible by one and not the
other would make a report depend on whether someone had run it before, which is
the cold/warm divergence KNOWN EDGE #23 exists to forbid.

Measured on the committed corpus, the most expensive of the 26 reports issues
~1,600 reads and ~1,590 log requests, visits 4 authority nodes and enumerates at
most 3 members in a role. Live re-scans at the same pinned block consume 146
(WETH9) and 142 (Compound III) reads. The defaults sit far above all of these on
purpose: this pass makes the worst case finite and labelled, not the ordinary
case cheaper.

**A limit that starts binding on an ordinary target is a finding, not a tuning
opportunity.** Exhaustion is recorded in `budget.exhausted`, becomes a gap in
`report.enumeration`, and withholds the witness that the reassuring assessment
variants cannot be constructed without — so a report that hits a ceiling comes
out more cautious, never cheaper-looking. Raising or lowering a limit changes
what Ripcord will examine and belongs in the ruleset version alongside a recorded
reason.

Not covered by this accounting: the fork engines (`prove`, `restrict`, asset
scenarios) read the chain directly and carry their own bounds — anvil lifecycle,
gas caps, `deadlineAt`. A `restrict` run's cost is the sum of two separately
bounded things rather than one number.

## Analysis reuse

`src/detect/facts.ts` memoizes per-address derivations (code, selectors, proxy
pattern, ownership, access control) for the life of one reader. The number worth
watching is how much of the graph is shared:

```sh
pnpm ripcord scan <address> --block <n> | jq '.budget.consumed'
```

A report whose `authorityNodes` count greatly exceeds the number of distinct
addresses in `authorityResolution` is walking the same contracts repeatedly —
which the fact layer now makes cheap, but which also indicates a graph shape
worth looking at directly.
