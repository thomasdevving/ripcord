# Fork evidence hardening

Ruleset **0.13.0**, exit actions **0.3.0**; the report schema remains **0.13.0**.

The candidate/enumeration fall-through fix in commit `0a02da6` is retained and
verified through the engine: a reverted guardian mutation produces an
inconclusive candidate and `evaluation_inconclusive`. Empty evaluation lists and
incomplete enumeration with an empty gaps list also fail closed.

## What now earns a result

- Funding must deliver the expected token balance. Supply must debit it and
  establish a positive base position without debt.
- A baseline withdraws the full base position with `uint256.max`. Actual tokens
  must return, principal and supply must reach zero, and debt must remain zero.
  Failure is `baseline_unestablished`, with no synthetic zero-notice route.
- Both branches start from the same snapshot. A neutral guardian transaction
  occupies the mutation's block in the control. Snapshot-aware clocks and fixed
  gas/base fees make corresponding withdrawals use the same block/time and fees.
  The guardian pays different gas for the two actions; this experiment does not
  claim equivalence for arbitrary contracts that inspect that ETH balance.
- The candidate preserves other pause flags. A confirmed restriction requires
  the false-to-true withdraw-pause transition, `Paused()` revert data below the
  gas cap, and unchanged holder tokens and principal. An unrelated revert,
  no-op mutation or missing economic recovery stays inconclusive.
- A successful withdrawal after the mutation earns no-effect only if the full
  position clears and token recovery equals the control.
- Report wording uses the candidate's own notice, never an unrelated route's
  zero. Safe impersonation assumes controller authorization; it does not execute
  signatures, guards or modules. This authorization model remains a limitation.
- Proof deltas preserve actual before/after balances. Oracle rounds are recorded
  and pinned; nonpositive prices, missing/future timestamps and prices older
  than 24 hours at the report block yield unknown USD. The 24-hour rule is a
  valuation policy, not a feed-specific heartbeat claim.
- A zero time-to-exit lower bound is displayed as unestablished duration. The
  determinism gate rejects empty directories and mismatched report inventories.

## Validation and limits

`test/exitRestrictionExecution.test.ts` runs the engine with a stateful mocked
fork boundary and fault injection. These tests establish classification and
evidence handling, not the live protocol's economic semantics.

`test/anvilClock.test.ts` starts a real local Anvil node and forks it. It checks
that reverting and replaying a branch produces identical complete transaction
receipts. It requires Anvil on PATH or `ANVIL_EXECUTABLE`; absence skips this test.
This caught both gas-price and next-base-fee state surviving `evm_revert`.

The complete suite passes with Anvil present. TypeScript build and the claims,
page and live-boundary gates are checked separately. None needs an external RPC.

**Fresh historical Comet validation remains pending.** The public archive RPCs
attempted during this pass refused historical access or timed out. No new
mainnet fork result is claimed. `calibration/reports` retains its older ruleset
and partial-withdrawal evidence; rendering it does not upgrade that evidence.

With an archive-capable `RPC_URL_1`, run:

```sh
pnpm ripcord restrict 0xc3d688B66703497DAA19211EEdff47f25384cdc3 --block 25800000 --chain 1
```

Inspect token/position witnesses, pause transition and receipt evidence before
updating the published fixture. Run it twice and compare the resulting report
directories with `scripts/compare-reports.mjs`. Full candidate-surface coverage,
other exit archetypes and live negative controls are still outside this patch.
