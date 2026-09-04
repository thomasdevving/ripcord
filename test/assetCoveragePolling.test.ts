import { describe, expect, it } from "vitest";
import { ApiRequestError } from "../web/src/api.js";
import { assetRowProgress } from "../web/src/components/AssetCoverage.js";
import { assetCoverageErrorIsTerminal, assetCoverageIsPending } from "../web/src/useAssetCoverage.js";
import type { AssetCoverage, AssetCoverageRow, CoverageProvenance } from "../server/shared/coverage.js";

const coverage = (verification: string, fork: string) => ({
  provenance: {
    candidateVerification: { status: verification },
    candidateFork: { status: fork },
  },
}) as unknown as AssetCoverage;

describe("asset coverage polling decisions", () => {
  it("keeps polling while either asynchronous second-layer phase is pending", () => {
    expect(assetCoverageIsPending(coverage("pending", "not_requested"))).toBe(true);
    expect(assetCoverageIsPending(coverage("complete", "pending"))).toBe(true);
    expect(assetCoverageIsPending(coverage("complete", "complete"))).toBe(false);
  });

  it("labels only plausible snapshot rows while candidate selection is pending", () => {
    const provenance = {
      analysedChainRef: "evm:1",
      candidateVerification: { status: "pending" },
      candidateFork: { status: "pending" },
    } as unknown as CoverageProvenance;
    const row = {
      identity: { chainRef: "evm:1", address: "0x1111111111111111111111111111111111111111", isNative: false },
      sources: ["mobula_snapshot"],
      mobula: { state: "observed" },
      balance: { state: "no_recorded_evidence" },
      experiments: [],
    } as unknown as AssetCoverageRow;

    expect(assetRowProgress(row, provenance)).toBe("candidate_pending");
    expect(assetRowProgress({ ...row, identity: { ...row.identity, chainRef: "evm:8453" } }, provenance)).toBeNull();
    expect(assetRowProgress({ ...row, identity: { ...row.identity, address: null, isNative: true } }, provenance)).toBeNull();
  });

  it("labels exact pinned candidates while their fork outcome is pending", () => {
    const provenance = {
      analysedChainRef: "evm:1",
      candidateVerification: { status: "complete" },
      candidateFork: { status: "pending" },
    } as unknown as CoverageProvenance;
    const row = {
      identity: { chainRef: "evm:1", address: "0x1111111111111111111111111111111111111111", isNative: false },
      sources: ["mobula_snapshot", "mobula_candidate_verification"],
      mobula: { state: "observed" },
      balance: { state: "verified_zero" },
      experiments: [],
    } as unknown as AssetCoverageRow;

    expect(assetRowProgress(row, provenance)).toBe("fork_pending");
    expect(assetRowProgress({
      ...row,
      experiments: [{ kind: "candidate_withdrawal" }],
    } as AssetCoverageRow, provenance)).toBeNull();
    expect(assetRowProgress({
      ...row,
      experiments: [{ kind: "withdrawal_restriction" }],
    } as AssetCoverageRow, provenance)).toBeNull();
  });

  it("stops only for report answers that cannot become readable on retry", () => {
    const api = (status: number) => new ApiRequestError(
      { code: "internal", message: "request failed", hint: null },
      status,
    );
    expect(assetCoverageErrorIsTerminal(api(404))).toBe(true);
    expect(assetCoverageErrorIsTerminal(api(451))).toBe(true);
    expect(assetCoverageErrorIsTerminal(api(500))).toBe(false);
    expect(assetCoverageErrorIsTerminal(new TypeError("network disconnected"))).toBe(false);
  });
});
