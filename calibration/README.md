# calibration/

The day-5 calibration set: **26 mainnet protocols, chain 1, all pinned to block
25800000**. Regenerate the whole thing with:

```sh
node scripts/run-calibration.mjs          # reads run-manifest.json
node scripts/compare-reports.mjs calibration/reports <your-output-dir>
```

- `targets.json` — the 18 protocols added on day 5 beyond the 8 verification
  fixtures, each with the live read (`identity`) that established it and the
  result that was expected before the report existed.
- `run-manifest.json` — the exact run as data: `(label, address, mode)` per
  target, block and chain pinned. `mode: prove` additionally runs the fork proof
  engine; `mode: restrict` runs that proof pass plus the exit-restriction
  differential. The current manifest uses `restrict` only for Compound Comet.
- `reports/` — one schema-valid JSON report per target.

## All 26 reports are here, including 4 that are not publishable

Four reports carry `disclosure.publishable: false`, and they are committed
anyway. That is deliberate, and the distinction is the point of the gate:

> The flag governs whether a rendered **verdict page** is produced, not whether
> the raw evidence exists.

`site/` therefore holds 22 pages, not 26, and `scripts/verify-pages.mjs` fails
the build if an unpublishable report ever acquires one. The JSON stays because it
is the reproducibility substrate — without it the determinism gate covers only
part of the set and "check our numbers yourself" stops being true.

The blocked reports assert nothing: every blocking entry says, in its own `note`,
*"this does not prove the function is unguarded"*. Their claim is about Ripcord's
coverage, not about the contract's safety. Every blocker was decoded and
hand-classified, and the one that looked strongest was followed to state level on
a fork and cleared — see [`docs/CALIBRATION.md` §6 and §12](../docs/CALIBRATION.md).

**Calibration found zero genuinely unguarded privileged functions across the 26**,
so no responsible-disclosure obligation was triggered and nothing is being sat on.
