/**
 * Merges a day-7 exit-restriction fork evaluation into a report and RE-COMPOSES
 * the verdict — the same pattern the proof engine uses (`buildReport` static,
 * then a fork pass merges and re-validates), extended to also update the exit
 * window and the verdict because, unlike the proof, a fork-confirmed restrictor
 * changes the conclusion.
 *
 * A fork-confirmed restrictor is injected as a synthetic exit-window ROUTE with
 * zero notice, so the window arithmetic (the MINIMUM notice across routes) sees
 * it and collapses to `no_notice`. The route carries `confirmationMethod:
 * "fork_confirmed"` and its `restrictionState`, so a reader can tell a delay we
 * could not verify apart from a kill switch we watched fire. Nothing here
 * touches the chain; it is a pure recomposition of already-produced facts, so it
 * is unit-testable without a fork.
 *
 * DIRECTION: this can only ADD a zero-notice route or leave the window
 * unchanged. It never removes a route and never softens a finding — a
 * `no_direct_restriction_found` outcome injects no route at all and lets the
 * verdict layer decide (strictly gated) whether the otherwise-undetermined
 * window may be upgraded to the weak positive tier.
 */
import { composeVerdict } from "./verdict.js";
import type { ExitWindow, ExitWindowAssessment, Report } from "./schema.js";
import type { ExitRestrictionResult } from "../fork/exitRestriction.js";

export function applyExitRestriction(report: Report, result: ExitRestrictionResult): Report {
  const { exitRestriction, restrictorRoute } = result;

  let exitWindow: ExitWindow | null = report.exitWindow;
  // A failed baseline is not a zero-notice authority route. Only attach a route
  // evidenced by an established differential, matching this restrictor's party.
  const matchingRestrictor = exitRestriction.restrictors.find((candidate) =>
    candidate.result === "restrictor" && candidate.noticeSeconds === "0" &&
    candidate.guardingParty?.toLowerCase() === restrictorRoute?.root.toLowerCase());
  if (restrictorRoute && exitWindow && matchingRestrictor &&
    exitRestriction.restrictionState === "restrictable" && exitRestriction.baseline.status === "established" &&
    exitRestriction.confirmationMethod === "fork_confirmed" && restrictorRoute.noticeSeconds === "0") {
    const routes = [...exitWindow.routes, restrictorRoute];
    const assessment: ExitWindowAssessment = {
      status: "no_notice",
      confidence: "high",
      statement: `Exit window is zero on the demonstrated route (${restrictorRoute.label} → ${restrictorRoute.effectiveControllerType} ${restrictorRoute.effectiveController}): the baseline withdrawal succeeded and the identical withdrawal failed after the privileged mutation on the fork.${matchingRestrictor.guardingPartyType === "safe" || matchingRestrictor.guardingPartyType === "contract" ? " The controller was impersonated; this conclusion assumes it can authorize and submit the call. Its signatures, guards and modules were not executed." : ""}`,
    };
    exitWindow = { ...exitWindow, routes, assessment };
  }

  const verdict = composeVerdict(exitWindow, report.timeToExit, report.enumeration, exitRestriction);

  return { ...report, exitWindow, exitRestriction, verdict };
}
