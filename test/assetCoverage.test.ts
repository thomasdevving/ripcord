/**
 * ASSET COVERAGE — the composition rules, as tests.
 *
 * Every case here is a way the panel could quietly overclaim. The composer is a
 * presentation layer, which is exactly why it needs this: it is the one place
 * where a vendor snapshot, a pinned balance read and a fork experiment are put
 * side by side, and side-by-side placement is itself an invitation to read them
 * as one progressive status.
 *
 * The rules being pinned down:
 *   - identity is (chain, address); nothing merges across chains
 *   - a null/unusable chain never produces a positive match
 *   - a missing dependency entry is NOT a proven zero balance
 *   - curated-list membership is eligibility, never evidence
 *   - a sandbox holder's withdrawal is never shown as the target's
 *   - an unestablished baseline is never a successful test
 *   - a historical report never wears a current-ruleset label
 *   - a report-only asset survives Mobula's absence
 *   - a capped/floored snapshot is never presented as a full inventory
 */
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { buildAssetCoverage, normaliseChainRef, assetKey, withdrawalBaseToken } from "../server/coverage.js";
import type { Report } from "../src/report/schema.js";
import type { LiveExposure, LiveHolding } from "../src/live/exposure.js";

const TARGET = "0xc3d688B66703497DAA19211EEdff47f25384cdc3";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
/** Not on the curated list, so it can only ever arrive from Mobula or an experiment. */
const LINK = "0x514910771af9ca656af840dff83e8264ecf986ca";

function report(overrides: Partial<Report> = {}): Report {
  return {
    schemaVersion: "0.13.0",
    rulesetVersion: "0.13.0",
    generatedAt: "2026-09-03T00:00:00.000Z",
    chainId: 1,
    block: { number: "25800000", hash: "0xblockhash" },
    target: { address: TARGET, hasCode: true, bytecodeSize: 100, bytecodeHash: null },
    dependencies: { tokens: [], oracles: [] },
    unknowns: [],
    errors: [],
    proof: null,
    exitRestriction: null,
    ...overrides,
  } as unknown as Report;
}

function holding(over: Partial<LiveHolding> = {}): LiveHolding {
  return {
    chainId: "evm:1",
    address: USDC.toLowerCase(),
    isNative: false,
    unverifiedSymbol: "USDC",
    unverifiedName: "USD Coin",
    logo: null,
    amount: 10,
    valuation: { basis: "endpoints_agree", usd: 10 },
    holdingsQuoteUsd: 10,
    priceQuoteUsd: 10,
    liquidityUsd: 1_000_000,
    chains: [{ chainId: "evm:1", chainName: "Ethereum", amountUSD: 10 }],
    outsideCuratedList: false,
    ...over,
  } as LiveHolding;
}

function exposure(over: Partial<LiveExposure> = {}): LiveExposure {
  return {
    liveLayerVersion: "0.4.0",
    fetchedAt: "2026-09-02T16:47:01.016Z",
    target: TARGET,
    chainId: 1,
    status: "ok",
    reason: null,
    exposureUsd: 10,
    countedHoldings: 1,
    vendorReportedTotalUsd: 10,
    holdingsCount: 193,
    chainCount: 1,
    chains: ["evm:1"],
    holdings: [holding()],
    withheld: [{ reason: "below the $1 display floor", count: 181, totalUsd: 0.4 }],
    concentration: null,
    floorUsd: 1,
    cap: 12,
    endpoints: { holdings: true, price: true, metadata: true },
    notes: [],
    ...over,
  } as LiveExposure;
}

const rowFor = (coverage: ReturnType<typeof buildAssetCoverage>, key: string) =>
  coverage.rows.find((r) => r.identity.key === key);

describe("asset identity", () => {
  it("normalises both chain notations to one canonical form", () => {
    expect(normaliseChainRef(1)).toBe("evm:1");
    expect(normaliseChainRef("evm:1")).toBe("evm:1");
    expect(normaliseChainRef("1")).toBe("evm:1");
  });

  it("returns null for a chain it cannot map, rather than guessing", () => {
    // A null chainRef is load-bearing: it is what stops a positive match.
    expect(normaliseChainRef(null)).toBeNull();
    expect(normaliseChainRef("")).toBeNull();
    expect(normaliseChainRef("ethereum")).toBeNull();
    expect(normaliseChainRef("solana")).toBeNull();
  });

  it("keeps the same token address on different chains apart", () => {
    expect(assetKey("evm:1", USDC, false)).not.toBe(assetKey("evm:8453", USDC, false));
  });

  it("keeps native assets on different chains apart despite the shared sentinel", () => {
    // The 0xeeee… sentinel is identical on every chain while meaning a
    // different asset on each.
    expect(assetKey("evm:1", NATIVE, true)).not.toBe(assetKey("evm:8453", NATIVE, true));
    expect(assetKey("evm:1", NATIVE, true)).toBe("evm:1|native");
  });

  it("does not merge a native asset with an ERC20 on the same chain", () => {
    expect(assetKey("evm:1", NATIVE, true)).not.toBe(assetKey("evm:1", USDC, false));
  });

  it("never merges two chains into one row", () => {
    const coverage = buildAssetCoverage(
      report(),
      exposure({
        holdings: [
          holding({ chainId: "evm:1" }),
          holding({ chainId: "evm:8453", unverifiedSymbol: "USDC-base" }),
        ],
      }),
    );
    expect(coverage.rows.filter((r) => r.identity.address === USDC.toLowerCase())).toHaveLength(2);
  });
});

describe("Mobula observation", () => {
  it("marks a holding with no usable chain as chain_unclear and gives it no balance verification", () => {
    const coverage = buildAssetCoverage(report(), exposure({ holdings: [holding({ chainId: null })] }));
    const row = coverage.rows[0];
    expect(row?.mobula.state).toBe("chain_unclear");
    expect(row?.balance.state).not.toBe("verified");
  });

  it("flags a cross-chain aggregate so it is never read as a single-chain quantity", () => {
    const coverage = buildAssetCoverage(
      report(),
      exposure({
        holdings: [
          holding({
            chains: [
              { chainId: "evm:1", chainName: "Ethereum", amountUSD: 6 },
              { chainId: "evm:8453", chainName: "Base", amountUSD: 4 },
            ],
          }),
        ],
      }),
    );
    const row = coverage.rows[0];
    expect(row?.mobula.state).toBe("observed");
    if (row?.mobula.state === "observed") expect(row.mobula.amountIsMultiChainAggregate).toBe(true);
  });

  it("says 'not listed' rather than 'absent' for an asset outside the shown subset", () => {
    const coverage = buildAssetCoverage(
      report({ dependencies: { tokens: [{ token: WETH, balance: "5", balanceEvidence: [] }], oracles: [] } } as never),
      exposure(),
    );
    const row = rowFor(coverage, `evm:1|${WETH.toLowerCase()}`);
    expect(row?.mobula.state).toBe("not_listed");
    if (row?.mobula.state === "not_listed") expect(row.mobula.note).toMatch(/not evidence the asset is absent/i);
  });

  it("reports Mobula as unavailable without losing pinned evidence", () => {
    const coverage = buildAssetCoverage(
      report({ dependencies: { tokens: [{ token: USDC, balance: "42", balanceEvidence: [{}] }], oracles: [] } } as never),
      null,
    );
    const row = rowFor(coverage, `evm:1|${USDC.toLowerCase()}`);
    expect(row?.mobula.state).toBe("unavailable");
    // The whole point: a vendor outage must not erase what the chain read said.
    expect(row?.balance.state).toBe("verified");
    expect(coverage.provenance.mobulaStatus).toBe("absent");
  });
});

describe("balance evidence", () => {
  it("verifies a balance only from a recorded dependency entry", () => {
    const coverage = buildAssetCoverage(
      report({ dependencies: { tokens: [{ token: USDC, balance: "39744687928433", balanceEvidence: [{}] }], oracles: [] } } as never),
      exposure(),
    );
    const row = rowFor(coverage, `evm:1|${USDC.toLowerCase()}`);
    expect(row?.balance.state).toBe("verified");
    if (row?.balance.state === "verified") {
      expect(row.balance.balanceRaw).toBe("39744687928433");
      expect(row.balance.account).toBe(TARGET);
      expect(row.balance.block).toBe("25800000");
    }
  });

  it("does NOT treat a missing dependency entry as a proven zero balance", () => {
    // The dependency scan writes an entry only for a NON-ZERO balance, so a
    // genuine zero leaves no artifact. Absence is therefore unusable evidence.
    const coverage = buildAssetCoverage(report(), exposure());
    const row = rowFor(coverage, `evm:1|${USDC.toLowerCase()}`);
    expect(row?.balance.state).toBe("no_recorded_evidence");
    if (row?.balance.state === "no_recorded_evidence") {
      expect(row.balance.reason).toMatch(/not evidence of a zero balance/i);
    }
    expect(JSON.stringify(row)).not.toMatch(/zero balance verified|balance is zero/i);
  });

  it("does not verify a curated token merely because it is on the list", () => {
    const coverage = buildAssetCoverage(report(), exposure());
    const row = rowFor(coverage, `evm:1|${USDC.toLowerCase()}`);
    // Eligibility is not evidence.
    expect(row?.identity.onCuratedList).toBe(true);
    expect(row?.balance.state).toBe("no_recorded_evidence");
  });

  it("distinguishes a failed read from an absent one", () => {
    const coverage = buildAssetCoverage(
      report({
        unknowns: [
          {
            field: `dependencies.tokens[${USDC.toLowerCase()}].balance`,
            reason: "balanceOf(target) did not return a value on a curated major token",
          },
        ],
      } as never),
      exposure(),
    );
    const row = rowFor(coverage, `evm:1|${USDC.toLowerCase()}`);
    expect(row?.balance.state).toBe("read_failed");
  });

  it("reports an asset on another chain as different_chain, never verified", () => {
    const coverage = buildAssetCoverage(
      report(),
      exposure({ holdings: [holding({ chainId: "evm:8453" })] }),
    );
    const row = coverage.rows[0];
    expect(row?.balance.state).toBe("different_chain");
  });

  it("says why a native asset has no balance evidence instead of leaving it blank", () => {
    const coverage = buildAssetCoverage(
      report(),
      exposure({ holdings: [holding({ address: NATIVE, isNative: true, unverifiedSymbol: "ETH" })] }),
    );
    const row = rowFor(coverage, "evm:1|native");
    expect(row?.balance.state).toBe("no_recorded_evidence");
    if (row?.balance.state === "no_recorded_evidence") expect(row.balance.reason).toMatch(/ERC20 balances only/i);
    expect(row?.identity.onCuratedList).toBe(false);
  });
});

describe("fork experiments", () => {
  const withBaseTokenEvidence = (extra: Record<string, unknown> = {}) =>
    report({
      exitRestriction: {
        outcome: "restrictor_found",
        forkBlock: "25800000",
        ceiling: ["ceiling item"],
        baseline: { status: "established", holder: "0x000000000000000000000000000000000000abc1", note: "baseline note", evidence: [] },
        candidates: [{ detail: "DIFFERENTIAL CONFIRMED", evidence: [] }],
        restrictors: [{ detail: "DIFFERENTIAL CONFIRMED" }],
        evidence: [
          { params: { read: "baseToken()", address: TARGET }, rawValue: USDC },
        ],
        ...extra,
      },
    } as never);

  it("links the withdrawal test to the base token recorded in evidence", () => {
    const found = withdrawalBaseToken(withBaseTokenEvidence());
    expect(found?.address).toBe(USDC.toLowerCase());

    const coverage = buildAssetCoverage(withBaseTokenEvidence(), exposure());
    const row = rowFor(coverage, `evm:1|${USDC.toLowerCase()}`);
    expect(row?.experiments.map((e) => e.kind)).toContain("withdrawal_restriction");
  });

  it("refuses the link when the evidence does not record which target was read", () => {
    // Older reports omit `params.address`. Attaching the experiment anyway would
    // be inferring from the protocol name or the archetype.
    const stale = report({
      rulesetVersion: "0.12.0",
      exitRestriction: {
        outcome: "restrictor_found",
        forkBlock: "25800000",
        ceiling: [],
        baseline: { status: "established", holder: "0xabc1", note: "n", evidence: [] },
        candidates: [{ detail: "d", evidence: [] }],
        restrictors: [{ detail: "d" }],
        evidence: [{ params: { read: "baseToken()" }, rawValue: USDC }],
      },
    } as never);
    expect(withdrawalBaseToken(stale)).toBeNull();

    const coverage = buildAssetCoverage(stale, exposure());
    const row = rowFor(coverage, `evm:1|${USDC.toLowerCase()}`);
    expect(row?.experiments).toHaveLength(0);
    expect(row?.forkGap?.state).toBe("unlinkable");
    expect(row?.forkGap?.reason).toMatch(/Could not establish asset-level test coverage/i);
  });

  it("shows the sandbox holder, never the target, as the withdrawal account", () => {
    const coverage = buildAssetCoverage(withBaseTokenEvidence(), exposure());
    const row = rowFor(coverage, `evm:1|${USDC.toLowerCase()}`);
    const experiment = row?.experiments.find((e) => e.kind === "withdrawal_restriction");
    expect(experiment?.account.scope).toBe("sandbox_holder");
    expect(experiment?.account.address).toBe("0x000000000000000000000000000000000000abc1");
    expect(experiment?.account.address?.toLowerCase()).not.toBe(TARGET.toLowerCase());
    expect(experiment?.account.note).toMatch(/not the target/i);
  });

  it("does not present an unestablished baseline as a successful test", () => {
    const failed = withBaseTokenEvidence({
      outcome: "baseline_unestablished",
      baseline: { status: "unestablished", holder: "0xabc1", note: "could not fund", evidence: [] },
      restrictors: [],
      candidates: [],
    });
    const coverage = buildAssetCoverage(failed, exposure());
    const row = rowFor(coverage, `evm:1|${USDC.toLowerCase()}`);
    const experiment = row?.experiments.find((e) => e.kind === "withdrawal_restriction");
    expect(experiment?.execution).toBe("not_established");
    expect(experiment?.caveats[0]).toMatch(/baseline exit was not established/i);
  });

  it("labels a historical result as not re-run under the current ruleset", () => {
    const historical = report({
      rulesetVersion: "0.12.0",
      exitRestriction: {
        outcome: "restrictor_found",
        forkBlock: "25800000",
        ceiling: [],
        baseline: { status: "established", holder: "0xabc1", note: "n", evidence: [] },
        candidates: [{ detail: "d", evidence: [] }],
        restrictors: [{ detail: "d" }],
        evidence: [{ params: { read: "baseToken()", address: TARGET }, rawValue: USDC }],
      },
    } as never);
    const coverage = buildAssetCoverage(historical, exposure());
    const experiment = rowFor(coverage, `evm:1|${USDC.toLowerCase()}`)?.experiments[0];
    expect(experiment?.caveats.join(" ")).toMatch(/has not been re-run under the current ruleset/i);
  });

  it("keeps the withdrawal test and the upgrade proof as separate records", () => {
    const both = report({
      exitRestriction: {
        outcome: "restrictor_found",
        forkBlock: "25800000",
        ceiling: [],
        baseline: { status: "established", holder: "0xabc1", note: "n", evidence: [] },
        candidates: [{ detail: "d", evidence: [] }],
        restrictors: [{ detail: "d" }],
        evidence: [{ params: { read: "baseToken()", address: TARGET }, rawValue: USDC }],
      },
      proof: {
        produced: true,
        forkBlock: "25800000",
        impersonated: "0xcontroller",
        noticeSeconds: "172800",
        noticeNote: "timelocked route",
        failureReason: null,
        deltas: [{ token: USDC, symbol: "USDC", delta: "100", usd: 100, priceSource: "chainlink" }],
      },
    } as never);
    const coverage = buildAssetCoverage(both, exposure());
    const row = rowFor(coverage, `evm:1|${USDC.toLowerCase()}`);
    // Two different experiments must never collapse into one generic tick.
    expect(row?.experiments.map((e) => e.kind).sort()).toEqual(["upgrade_fund_movement", "withdrawal_restriction"]);
    const proofExperiment = row?.experiments.find((e) => e.kind === "upgrade_fund_movement");
    expect(proofExperiment?.account.scope).toBe("impersonated_controller");
    // The notice the fork did not simulate has to travel with the movement.
    expect(proofExperiment?.caveats.join(" ")).toMatch(/172800s of notice/);
  });
});

describe("the union of sources", () => {
  it("keeps a report-only asset visible when Mobula does not list it", () => {
    const coverage = buildAssetCoverage(
      report({ dependencies: { tokens: [{ token: WETH, balance: "5", balanceEvidence: [{}] }], oracles: [] } } as never),
      exposure(),
    );
    const row = rowFor(coverage, `evm:1|${WETH.toLowerCase()}`);
    expect(row).toBeDefined();
    expect(row?.sources).toContain("report_balance_evidence");
    expect(row?.sources).not.toContain("mobula_snapshot");
  });

  it("does not present a fork-only asset as an observed target holding", () => {
    const coverage = buildAssetCoverage(
      report({
        exitRestriction: {
          outcome: "restrictor_found",
          forkBlock: "1",
          ceiling: [],
          baseline: { status: "established", holder: "0xabc1", note: "n", evidence: [] },
          candidates: [{ detail: "d", evidence: [] }],
          restrictors: [{ detail: "d" }],
          evidence: [{ params: { read: "baseToken()", address: TARGET }, rawValue: LINK }],
        },
      } as never),
      exposure(),
    );
    const row = rowFor(coverage, `evm:1|${LINK.toLowerCase()}`);
    expect(row?.sources).toEqual(["fork_experiment"]);
    expect(row?.mobula.state).toBe("not_listed");
    expect(row?.balance.state).toBe("no_recorded_evidence");
  });
});

describe("counts and scope", () => {
  it("reports the available and shown snapshot sizes separately", () => {
    const coverage = buildAssetCoverage(report(), exposure());
    // 193 available vs 12 shown: the shown subset must never stand in for the
    // whole inventory.
    expect(coverage.counts.mobulaEntriesAvailable).toBe(193);
    expect(coverage.counts.mobulaEntriesShown).toBe(1);
    expect(coverage.provenance.mobulaLimits.floorUsd).toBe(1);
    expect(coverage.provenance.mobulaLimits.displayCap).toBe(12);
    expect(coverage.provenance.mobulaLimits.withheld[0]?.count).toBe(181);
  });

  it("counts each characteristic over its own scope", () => {
    const coverage = buildAssetCoverage(
      report({ dependencies: { tokens: [{ token: USDC, balance: "1", balanceEvidence: [{}] }], oracles: [] } } as never),
      exposure(),
    );
    expect(coverage.counts.assetsWithBalanceEvidence).toBe(1);
    expect(coverage.counts.assetsInWithdrawalExperiment).toBe(0);
    expect(coverage.counts.assetsInUpgradeProof).toBe(0);
  });

  it("publishes no coverage percentage, safety score or tested-value share", () => {
    const serialised = JSON.stringify(buildAssetCoverage(report(), exposure()));
    expect(serialised).not.toMatch(/coveragePercent|safetyScore|percentTested|valueAtRisk|drainableValue/i);
  });

  it("keeps the roadmap explicitly future-tense", () => {
    const coverage = buildAssetCoverage(report(), exposure());
    expect(coverage.roadmapNote).toMatch(/^Planned after the hackathon/);
    expect(coverage.roadmapNote).toMatch(/Not available yet/);
  });

  it("does not mutate the report or the exposure it was given", () => {
    const source = report({ dependencies: { tokens: [{ token: USDC, balance: "1", balanceEvidence: [] }], oracles: [] } } as never);
    const live = exposure();
    const before = JSON.stringify({ source, live });
    buildAssetCoverage(source, live);
    expect(JSON.stringify({ source, live })).toBe(before);
  });
});

/**
 * The publication boundary, against REAL committed reports.
 *
 * The unit tests above prove the composition rules on synthetic input. These
 * prove the two things that only real artifacts can: that a blocked report's
 * findings cannot escape sideways through coverage output, and that the panel
 * degrades honestly on a historical report rather than dressing it up.
 */
describe("against the committed calibration set", () => {
  const load = (name: string): Report => JSON.parse(readFileSync(`calibration/reports/${name}.json`, "utf8")) as Report;
  const loadLive = (name: string): LiveExposure | null => {
    const path = `calibration/live/${name}.json`;
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as LiveExposure) : null;
  };

  it("never emits a blocked report's capability findings through coverage", () => {
    const blocked = load("paid-network-token-proxy-2");
    expect(blocked.disclosure.publishable).toBe(false);

    // The route refuses a blocked report before reaching the composer. This
    // asserts the second line of defence: even if the composer were handed one,
    // its output carries no capability signature, selector or guard detail.
    const coverage = buildAssetCoverage(blocked, loadLive("paid-network-token-proxy-2"));
    const serialised = JSON.stringify(coverage);
    for (const finding of blocked.capabilities.findings) {
      expect(serialised).not.toContain(finding.signature);
      expect(serialised).not.toContain(finding.selector);
    }
    for (const entry of blocked.capabilities.needsManualVerification) {
      expect(serialised).not.toContain(entry.signature);
    }
  });

  it("degrades the historical Comet report's withdrawal linkage instead of inferring it", () => {
    const historical = load("compound-comet-cusdcv3");
    const coverage = buildAssetCoverage(historical, loadLive("compound-comet-cusdcv3"));

    // Its `baseToken()` evidence predates `params.address`, so the asset-level
    // link is refused — even though the archetype is obviously Comet and the
    // base token is obviously USDC. Inferring it from either would be exactly
    // the shortcut this panel exists to avoid.
    expect(coverage.counts.assetsInWithdrawalExperiment).toBe(0);
    const usdc = coverage.rows.find((r) => r.identity.address === USDC.toLowerCase());

    // The upgrade proof IS linkable, because its deltas name the token — so
    // this row carries an experiment and therefore no `forkGap`. The
    // unattributable WITHDRAWAL test must still be stated, or the one green
    // record would hide the other experiment's missing linkage.
    expect(coverage.counts.assetsInUpgradeProof).toBeGreaterThan(0);
    expect(usdc?.experiments.map((e) => e.kind)).toContain("upgrade_fund_movement");
    expect(usdc?.experiments.map((e) => e.kind)).not.toContain("withdrawal_restriction");
    expect(usdc?.gaps.join(" ")).toMatch(/Could not establish withdrawal-test coverage/i);

    // An asset with no experiment at all gets the row-level gap instead.
    const unlinked = coverage.rows.find((r) => r.experiments.length === 0);
    expect(unlinked?.forkGap?.state).toBe("unlinkable");
  });

  it("shows a capped snapshot as capped on every publishable calibration target", () => {
    for (const name of ["compound-comet-cusdcv3", "weth9", "usdc"]) {
      const live = loadLive(name);
      if (!live || live.status !== "ok") continue;
      const coverage = buildAssetCoverage(load(name), live);
      // Available vs shown must remain visibly different wherever the vendor
      // returned more entries than the cap allows.
      if ((coverage.counts.mobulaEntriesAvailable ?? 0) > coverage.counts.mobulaEntriesShown) {
        expect(coverage.provenance.mobulaLimits.displayCap).not.toBeNull();
        expect(coverage.provenance.mobulaLimits.withheld.length).toBeGreaterThan(0);
      }
    }
  });
});
