/**
 * THE ENRICHED ASSESSMENT — the one place sidecar evidence may reach a
 * conclusion, and therefore the one place worth attacking hardest.
 *
 * Three properties carry the whole design, and each is tested from the
 * direction that would break it rather than the direction that confirms it:
 *
 *   1. It can only ever push toward caution. No input — however clean — may
 *      produce an outcome that softens, clears or reassures.
 *   2. It refuses to join a sidecar to a report it does not belong to.
 *   3. It never modifies the report.
 */
import { describe, expect, it } from "vitest";
import { buildEnrichedAssessment, linkMismatches } from "../server/enriched.js";
import type { AssetContextArtifact } from "../server/asset-context.js";
import type { AssetExitScenario, AssetScenarioBatch, AssetScenarioState } from "../src/fork/assetScenarios.js";
import type { Report } from "../src/report/schema.js";

const TARGET = "0xc3d688B66703497DAA19211EEdff47f25384cdc3";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const WBTC = "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599";
const HASH = `0x${"11".repeat(32)}`;

const report = (over: Record<string, unknown> = {}): Report => ({
  target: { address: TARGET },
  chainId: 1,
  block: { number: "25800000", hash: HASH },
  verdict: { status: "undetermined" },
  exitRestriction: { restrictionState: "undetermined" },
  ...over,
} as unknown as Report);

const scenario = (address: string, state: AssetScenarioState): AssetExitScenario => ({
  address,
  assetRole: "collateral",
  state,
  holder: "0x000000000000000000000000000000000000d100",
  suppliedRaw: "1000",
  recoveredRaw: state === "restrictor_confirmed" ? "1000" : null,
  guardian: "0x00000000000000000000000000000000000dead0",
  guardianType: "safe",
  noticeSeconds: "0",
  detail: `state=${state}`,
  evidence: [],
  caveats: [],
});

const batch = (scenarios: AssetExitScenario[]): AssetScenarioBatch => ({
  assetScenarioVersion: "0.4.0",
  experimental: true,
  status: "complete",
  target: TARGET.toLowerCase(),
  chainId: 1,
  forkBlock: "25800000",
  startedAt: "2026-09-04T10:00:00.000Z",
  completedAt: "2026-09-04T10:01:00.000Z",
  candidatesConsidered: scenarios.length,
  supported: scenarios.length,
  evaluated: scenarios.filter((s) => s.state === "restrictor_confirmed" || s.state === "no_effect").length,
  restrictorsConfirmed: scenarios.filter((s) => s.state === "restrictor_confirmed").length,
  unresolved: 0,
  scenarios,
  notes: [],
});

const context = (over: Partial<AssetContextArtifact> = {}): AssetContextArtifact => ({
  assetContextVersion: "0.1.0",
  reportId: "rep_1",
  target: TARGET,
  chainId: 1,
  block: { number: "25800000", hash: HASH },
  requestedAt: "2026-09-04T10:00:00.000Z",
  completedAt: "2026-09-04T10:01:00.000Z",
  status: "complete",
  exposure: {
    fetchedAt: "2026-09-04T10:00:00.000Z",
    holdings: [{ address: WETH, unverifiedSymbol: "WETH" }, { address: WBTC, unverifiedSymbol: "WBTC" }],
  } as never,
  candidates: [],
  counts: { displayed: 2, eligible: 2, verified: 2, failed: 0 },
  forkScenarios: { requested: true, status: "complete", batch: batch([]), note: "" },
  notes: [],
  ...over,
});

const withScenarios = (scenarios: AssetExitScenario[], over: Partial<AssetContextArtifact> = {}) =>
  context({ forkScenarios: { requested: true, status: "complete", batch: batch(scenarios), note: "" }, ...over });

/** Every outcome this layer is allowed to reach. Nothing here may reassure. */
const ALL_STATUSES = ["not_applicable", "unusable", "no_change", "scope_broadened", "stricter_than_report"];

describe("the enriched assessment never softens a conclusion", () => {
  // The exhaustive version of the caution-only rule: whatever the sidecar says,
  // if nothing was demonstrated the outcome is `no_change`. There is deliberately
  // no input that reaches a reassuring outcome, because no such outcome exists.
  const cleanStates: AssetScenarioState[] = [
    "no_effect",
    "baseline_unestablished",
    "inconclusive",
    "unsupported_asset",
    "role_unresolved",
    "token_interface_rejected",
    "read_failed",
  ];

  for (const state of cleanStates) {
    it(`returns no_change when every candidate is ${state}`, () => {
      const result = buildEnrichedAssessment(report(), withScenarios([scenario(WETH, state), scenario(WBTC, state)]));
      expect(result.outcome.status).toBe("no_change");
      expect(result.counts.confirmed).toBe(0);
      // The whole considered set is still reconcilable from the output.
      expect(result.unconfirmed).toHaveLength(2);
      expect(result.counts.considered).toBe(2);
    });
  }

  it("does not count the primary-report base asset as an additional Mobula experiment", () => {
    const result = buildEnrichedAssessment(
      report(),
      withScenarios([
        scenario(WETH, "covered_by_primary_report"),
        scenario(WBTC, "no_effect"),
      ]),
    );
    expect(result.outcome.status).toBe("no_change");
    expect(result.counts).toEqual({ considered: 1, confirmed: 0, noEffect: 1, unresolved: 0 });
    expect(result.unconfirmed.map((item) => item.address)).toEqual([WBTC]);
  });

  it("makes no reassuring claim in the text that carries the conclusion", () => {
    const result = buildEnrichedAssessment(report(), withScenarios([scenario(WETH, "no_effect")]));
    // Checked on the outcome itself, which is where a claim would live. The
    // scope notes DO contain the word "safe" — inside the sentence that denies
    // it — so scanning the whole document for the word would be a test that
    // fails on its own safety rail.
    const outcome = result.outcome;
    const claim = [
      "reason" in outcome ? outcome.reason : "",
      "statement" in outcome ? outcome.statement : "",
    ].join(" ");
    expect(claim).not.toMatch(/\bis safe\b/i);
    expect(claim).not.toMatch(/\bsecure\b/i);
    expect(claim).not.toMatch(/no risk/i);
    expect(claim).not.toMatch(/can exit/i);
    expect(claim).toMatch(/not a clean result/i);
    // And the note that stops `no_effect` reading as a clean bill is attached.
    expect(result.scopeNotes.join(" ")).toMatch(/not evidence that the asset, the exit or the protocol is safe/i);
  });

  it("offers no outcome variant that could weaken a verdict", () => {
    // A structural check on the union itself: every reachable status is one of
    // the five, and none of them is a clearing outcome. If a future change adds
    // one, this fails rather than shipping quietly.
    const seen = new Set<string>();
    seen.add(buildEnrichedAssessment(report(), null).outcome.status);
    seen.add(buildEnrichedAssessment(report(), context({ target: "0xdead" })).outcome.status);
    seen.add(buildEnrichedAssessment(report(), withScenarios([scenario(WETH, "no_effect")])).outcome.status);
    seen.add(buildEnrichedAssessment(report(), withScenarios([scenario(WETH, "restrictor_confirmed")])).outcome.status);
    seen.add(
      buildEnrichedAssessment(
        report({ verdict: { status: "no_notice" } }),
        withScenarios([scenario(WETH, "restrictor_confirmed")]),
      ).outcome.status,
    );
    for (const status of seen) expect(ALL_STATUSES).toContain(status);
    expect(seen.size).toBe(5);
  });
});

describe("the enriched assessment only speaks from demonstrated restrictions", () => {
  it("states something stricter when the report did not reach the finding itself", () => {
    // The case that justifies this layer existing: the report's own baseline
    // failed, so its verdict is undetermined, while a collateral differential
    // succeeded.
    const result = buildEnrichedAssessment(
      report({ verdict: { status: "undetermined" } }),
      withScenarios([scenario(WETH, "restrictor_confirmed"), scenario(WBTC, "no_effect")]),
    );
    expect(result.outcome.status).toBe("stricter_than_report");
    if (result.outcome.status !== "stricter_than_report") return;
    expect(result.outcome.reportVerdict).toBe("undetermined");
    expect(result.outcome.confirmed).toHaveLength(1);
    expect(result.outcome.confirmed[0]?.unverifiedSymbol).toBe("WETH");
    expect(result.outcome.statement).toMatch(/capability, not intent/i);
    // The unconfirmed one is still listed, never absorbed into the total.
    expect(result.unconfirmed.map((a) => a.state)).toEqual(["no_effect"]);
    expect(result.counts).toMatchObject({ considered: 2, confirmed: 1, noEffect: 1, unresolved: 0 });
  });

  it("broadens rather than restates when the report already reports the finding", () => {
    for (const status of ["no_notice", "trapped"]) {
      const result = buildEnrichedAssessment(
        report({ verdict: { status } }),
        withScenarios([scenario(WETH, "restrictor_confirmed")]),
      );
      expect(result.outcome.status).toBe("scope_broadened");
      if (result.outcome.status !== "scope_broadened") return;
      expect(result.outcome.reportVerdict).toBe(status);
      expect(result.outcome.statement).toMatch(/reaches further/i);
    }
  });

  it("treats an unrecognised verdict as one the report did not reach", () => {
    // Fail toward the stricter variant, never toward "already covered".
    const result = buildEnrichedAssessment(
      report({ verdict: { status: "some_future_status" } }),
      withScenarios([scenario(WETH, "restrictor_confirmed")]),
    );
    expect(result.outcome.status).toBe("stricter_than_report");
  });

  it("names the assets, the guarding party and the sandbox account it rests on", () => {
    const result = buildEnrichedAssessment(report(), withScenarios([scenario(WETH, "restrictor_confirmed")]));
    if (result.outcome.status !== "stricter_than_report") throw new Error("expected a confirmed outcome");
    const [confirmed] = result.outcome.confirmed;
    expect(confirmed?.address).toBe(WETH);
    expect(confirmed?.chainRef).toBe("evm:1");
    expect(confirmed?.guardianType).toBe("safe");
    // The holder is the sandbox account, and it is never the analysed target.
    expect(confirmed?.holder).not.toBe(TARGET);
    expect(confirmed?.evidenceRef).toContain(WETH);
  });
});

describe("the enriched assessment refuses an unearned link", () => {
  const cases: [string, Partial<AssetContextArtifact>, RegExp][] = [
    ["a different contract", { target: "0x0000000000000000000000000000000000000001" }, /different contract address/],
    ["a different chain", { chainId: 8453 }, /different chain/],
    ["a different block number", { block: { number: "25800001", hash: HASH } }, /different block number/],
    ["a different block hash", { block: { number: "25800000", hash: `0x${"22".repeat(32)}` } }, /single pinned block hash/],
  ];

  for (const [label, override, expected] of cases) {
    it(`refuses to attach a sidecar from ${label}`, () => {
      const result = buildEnrichedAssessment(report(), withScenarios([scenario(WETH, "restrictor_confirmed")], override));
      expect(result.outcome.status).toBe("unusable");
      if (result.outcome.status !== "unusable") return;
      expect(result.outcome.mismatches.join(" ")).toMatch(expected);
      // A confirmed restrictor from the wrong block contributes NOTHING.
      expect(result.counts.confirmed).toBe(0);
    });
  }

  it("refuses when the fork batch itself ran elsewhere, even if the sidecar header matches", () => {
    const drifted = withScenarios([scenario(WETH, "restrictor_confirmed")]);
    drifted.forkScenarios.batch!.forkBlock = "25799999";
    const result = buildEnrichedAssessment(report(), drifted);
    expect(result.outcome.status).toBe("unusable");
  });

  it("does not treat two missing block hashes as agreement", () => {
    const result = buildEnrichedAssessment(
      report({ block: { number: "25800000", hash: "0x" } }),
      withScenarios([scenario(WETH, "restrictor_confirmed")], { block: { number: "25800000", hash: null } }),
    );
    expect(result.outcome.status).toBe("unusable");
    expect(linkMismatches(report({ block: { number: "25800000", hash: "0x" } }), context()).join(" "))
      .toMatch(/single pinned block hash/);
  });
});

describe("the enriched assessment leaves the report alone", () => {
  it("never modifies the report object it was given", () => {
    const source = report({ verdict: { status: "undetermined" } });
    const before = JSON.stringify(source);
    buildEnrichedAssessment(source, withScenarios([scenario(WETH, "restrictor_confirmed")]));
    expect(JSON.stringify(source)).toBe(before);
  });

  it("declares that it changes no verdict, as a value that cannot be anything else", () => {
    const result = buildEnrichedAssessment(report(), withScenarios([scenario(WETH, "restrictor_confirmed")]));
    expect(result.changesVerdict).toBe(false);
    // The report's own verdict is quoted, not replaced, so the two artifacts
    // cannot drift into disagreeing about what the report says.
    expect(result.provenance.reportVerdict).toBe("undetermined");
  });

  it("carries the two clocks separately", () => {
    const result = buildEnrichedAssessment(report(), withScenarios([scenario(WETH, "restrictor_confirmed")]));
    expect(result.provenance.analysisBlock).toBe("25800000");
    expect(result.provenance.sidecarFetchedAt).toBe("2026-09-04T10:00:00.000Z");
  });

  it("says so plainly when there is no sidecar at all", () => {
    const result = buildEnrichedAssessment(report(), null);
    expect(result.outcome.status).toBe("not_applicable");
    expect(result.counts.considered).toBe(0);
  });

  it("stays experimental while the underlying batch is", () => {
    expect(buildEnrichedAssessment(report(), withScenarios([])).experimental).toBe(true);
    // An absent batch is not thereby calibrated.
    expect(buildEnrichedAssessment(report(), null).experimental).toBe(true);
  });
});
