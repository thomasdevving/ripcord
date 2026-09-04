import { describe, expect, it } from "vitest";
import { ApiRequestError } from "../web/src/api.js";
import { assetCoverageErrorIsTerminal, assetCoverageIsPending } from "../web/src/useAssetCoverage.js";
import type { AssetCoverage } from "../server/shared/coverage.js";

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
