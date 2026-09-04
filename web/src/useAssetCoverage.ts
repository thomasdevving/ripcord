import { useEffect, useState } from "react";
import type { AssetCoverage } from "@shared/coverage";
import type { EnrichedAssessment } from "@shared/enriched";
import { ApiRequestError, getCoverage } from "./api.js";

const POLL_INTERVAL_MS = 2_000;
/**
 * How long this hook will chase a `pending` sidecar.
 *
 * Bounded deliberately. The server caps one refresh with its own timeout and
 * rewrites a stranded `pending` at boot, but neither of those helps a browser
 * whose server died and did not come back, or one that was told `pending` by a
 * refresh that never wrote a sidecar at all. Unbounded 2-second polling in that
 * state is one request every two seconds, per open tab, forever.
 *
 * Comfortably longer than the server's own default ceiling, so the normal case
 * is always resolved by the server rather than abandoned here.
 */
const POLL_CEILING_MS = 20 * 60_000;

export interface AssetCoverageState {
  coverage: AssetCoverage | null;
  /** Composed from the report and the sidecar together; never modifies either. */
  enriched: EnrichedAssessment | null;
  /** True once this hook stopped waiting for a pending refresh that never resolved. */
  gaveUp: boolean;
}

/** The server uses these two independent statuses because verification can be visible while the fork still runs. */
export function assetCoverageIsPending(coverage: AssetCoverage): boolean {
  return coverage.provenance.candidateVerification.status === "pending" ||
    coverage.provenance.candidateFork.status === "pending";
}

/**
 * A missing or disclosure-blocked report will not become readable by retrying.
 * Transport failures and 5xx responses can recover, especially on conference
 * Wi-Fi, so one failed poll must not permanently hide a layer still running.
 */
export function assetCoverageErrorIsTerminal(error: unknown): boolean {
  return error instanceof ApiRequestError && (error.status === 404 || error.status === 451);
}

/**
 * Coverage is additive and asynchronous. Poll only while the optional Mobula
 * sidecar says it is pending; failures never take the core report down.
 */
export function useAssetCoverage(reportId: string | null): AssetCoverageState {
  const [state, setState] = useState<AssetCoverageState>({ coverage: null, enriched: null, gaveUp: false });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stopPollingAt = Date.now() + POLL_CEILING_MS;

    const load = async () => {
      if (!reportId) return;
      try {
        const response = await getCoverage(reportId);
        if (cancelled) return;
        const pending = assetCoverageIsPending(response.coverage);
        const outOfTime = Date.now() >= stopPollingAt;
        setState({ coverage: response.coverage, enriched: response.enriched ?? null, gaveUp: pending && outOfTime });
        if (pending && !outOfTime) timer = setTimeout(() => void load(), POLL_INTERVAL_MS);
      } catch (err) {
        if (cancelled) return;
        // A 404/451 is a real answer. Everything else may be a transient API or
        // transport failure; retain any evidence already shown and retry within
        // the same finite ceiling instead of making one dropped request final.
        if (assetCoverageErrorIsTerminal(err)) {
          setState({ coverage: null, enriched: null, gaveUp: false });
          return;
        }
        const outOfTime = Date.now() >= stopPollingAt;
        setState((current) => ({ ...current, gaveUp: outOfTime }));
        if (!outOfTime) timer = setTimeout(() => void load(), POLL_INTERVAL_MS);
      }
    };

    setState({ coverage: null, enriched: null, gaveUp: false });
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [reportId]);

  return state;
}
