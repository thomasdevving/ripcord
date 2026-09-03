# scripts/

Calibration and rendering tooling. None of it is part of the `ripcord` CLI; all
of it exists so the numbers in [`docs/CALIBRATION.md`](../docs/CALIBRATION.md)
can be re-derived rather than taken on trust.

## The renderer (no network, ever)

| Script | What it does |
|---|---|
| `render.ts` | One pinned JSON report in, one static HTML page out. `pnpm render` writes `site/` from `calibration/reports/`, skipping anything the disclosure gate blocks (`--all` overrides, for local inspection only). |
| `figures.ts` | The provenance mechanism. Every headline figure is read through a `FigureLog` that records the JSON path it came from, so a figure cannot be hand-written into the template. |
| `verify-pages.mjs` | Re-derives every figure from the source report and checks seven further honesty properties. Runs in CI; needs no network, since both sides are committed. |

## Evidence gathering

These back specific claims in the calibration write-up. Each was used to
establish something on-chain rather than assume it.

| Script | What it establishes |
|---|---|
| `identify.ts` | `name()`/`symbol()` and code presence at the pinned block — no address enters the calibration set on memory. |
| `identify2.ts` | Distinguishing reads for contracts with no `name()`, e.g. `feeAmountTickSpacing(3000) == 60` for the Uniswap v3 factory. |
| `sel.ts` / `rolehash.ts` / `checksum.ts` | Derive selectors, role hashes and checksums via viem. Used to identify raw revert bytes (`0xf50a3b52` → `OperationNotAllowed()`) and to confirm a role hash matches its name. |
| `selscan.ts` | Brute-forces a candidate signature space against an observed selector. Used on Wasabi's `0xf07e038f` — 210 candidates, no match, recorded as unidentified. |
| `probe-call.ts` | A raw `eth_call` from a chosen sender at the pinned block. This is what proved sUSDe's restricted-staker role *removes* power: its holders cannot `transfer`, an unrelated address can. |
| `probe-many.ts` | Which authority-indirection getters actually resolve on a contract — the evidence behind `authorityIndirection.ts`'s getter list. |

## Reporting over a set of reports

| Script | What it does |
|---|---|
| `summarize.mjs` | One line per report: verdict, window, time-to-exit, selector accounting, publishability. |
| `manual-verification-audit.mjs` | Every `needsManualVerification` entry with its probe revert **decoded** — the table behind the disclosure gate's false-alarm rate. |
| `compare-reports.mjs` | Byte-compares two explicit report directories with `generatedAt` normalised: `node scripts/compare-reports.mjs <dirA> <dirB>`. The determinism gate. |
