/**
 * THE OVERVIEW LIST — a PROJECTION of conclusions the report already reached,
 * never a new one.
 *
 * The report page leads with its verdict and then asks the reader to scroll
 * through every section looking for what actually matters. This module answers
 * "what did this run establish, and where is the evidence" in one list, with a
 * link to the tab that carries the proof.
 *
 * FOUR RULES, and the first is the one that keeps this honest:
 *
 *  1. NOTHING IS DECIDED HERE. Every entry restates a field the engine already
 *     populated — a route's own `noticeStatus`, a candidate's own `result`, a
 *     gap the enumeration witness already recorded. There is no scoring, no
 *     weighting and no threshold. If this file were deleted the report would
 *     lose a table of contents, not a conclusion.
 *  2. THE SPLIT IS EVIDENTIAL, NOT A SEVERITY RANKING. `demonstrated` means the
 *     run positively established the thing — a fork transaction that ran, a
 *     delay read at the pinned block, a paused() that returned true.
 *     `unresolved` means it could not be settled. Calling the second half
 *     "warning" would imply the first half is a measured risk score, which this
 *     project does not compute and must not appear to.
 *  3. UNRESOLVED IS NEVER OMITTED, and never rendered as reassurance. An empty
 *     list means the projection found nothing to name, which is a statement
 *     about this list, not about the contract — `noFindingsNote` says exactly
 *     that, and the page is required to print it.
 *  4. A LINK IS A DESTINATION, NOT A CLAIM. `link.node` selects a power-map
 *     node when the finding names an address; when it cannot, the link still
 *     resolves to the tab rather than pretending to a precision it lacks.
 *
 * Browser-safe: a type-only import of the report schema (erased at build time,
 * asserted by scripts/verify-webapp.mjs) and pure functions, no Node imports.
 */
import type { Report } from "../../src/report/schema.js";

/** Bump when the projection rules or this shape change. */
export const reportFindingsVersion = "0.1.0";

/**
 * Which pane of the report carries the evidence for an entry.
 *
 * These are presentation destinations, deliberately not analysis categories:
 * two findings on the same tab are not thereby related, and a tab carrying no
 * finding is not thereby clean.
 */
export type FindingTab = "overview" | "power" | "fork" | "assets" | "evidence";

/** See rule 2. Not a severity ranking. */
export type FindingSeverity = "demonstrated" | "unresolved";

export interface FindingLink {
  tab: FindingTab;
  /** An element id on that tab to scroll to. Always present; tabs carry a landing anchor. */
  anchor: string;
  /** A power-map node to select on arrival, when the finding names one address. Null otherwise. */
  node: string | null;
}

export interface ReportFinding {
  /** Stable within one report, so React keys and scroll targets do not shuffle between renders. */
  id: string;
  severity: FindingSeverity;
  /** The claim, in the report's own voice. Never stronger than the field it restates. */
  title: string;
  /** The qualification the claim travels with. Empty only when the title is already complete. */
  detail: string;
  /** Which layer of the run produced it — "Exit window", "Fork differential", "Capabilities". */
  source: string;
  link: FindingLink;
}

/** Printed whenever the list is empty. Required: an empty list is not a clean bill. */
export const noFindingsNote =
  "This projection named nothing. That is a statement about the list, not about the contract — the tabs above carry " +
  "the full analysis, including everything this run could not settle.";

const lower = (value: string | null | undefined): string | null => (value ? value.toLowerCase() : null);

/**
 * Seconds as the engine stores them (a decimal string) → a zero test.
 *
 * A null is NOT a zero and must never answer true here: null means no notice
 * was established, which is the `unresolved` half of this file, while "0" is a
 * measured absence of notice. Conflating them is the project's oldest bug.
 */
function isZeroSeconds(value: string | null | undefined): boolean {
  return typeof value === "string" && /^0+$/.test(value.trim());
}

export function deriveReportFindings(report: Report): ReportFinding[] {
  const demonstrated: ReportFinding[] = [];
  const unresolved: ReportFinding[] = [];

  // --- the exit window's routes ---------------------------------------------
  //
  // A route is read exactly as the engine labelled it. `noticeStatus` is the
  // engine's own word; this code only decides which list it lands in.
  const routes = report.exitWindow?.routes ?? [];
  routes.forEach((route, index) => {
    const holder = lower(route.effectiveController ?? route.root);
    const via = route.effectiveController && route.effectiveController !== route.root
      ? `${route.label} → ${route.effectiveController}`
      : route.label;

    if (isZeroSeconds(route.noticeSeconds)) {
      demonstrated.push({
        id: `route-${index}`,
        severity: "demonstrated",
        title: `The rules can change with no notice via ${route.label}`,
        detail:
          `${via} imposes no waiting period` +
          (route.confirmationMethod === "fork_confirmed"
            ? ", demonstrated on a fork rather than inferred. "
            : ", established from the authority map and guard probes without executing anything. ") +
          route.note,
        source: "Exit window",
        link: { tab: "power", anchor: "power-map", node: holder },
      });
      return;
    }

    if (route.noticeSeconds === null) {
      unresolved.push({
        id: `route-${index}`,
        severity: "unresolved",
        title: `No notice could be established for ${route.label}`,
        detail: `${route.noticeStatus.replace(/_/g, " ")}. ${route.note}`,
        source: "Exit window",
        link: { tab: "power", anchor: "power-map", node: holder },
      });
    }
  });

  // --- the exit itself ------------------------------------------------------
  const blockable = report.timeToExit?.blockable;
  if (blockable?.status === "currently_blocked") {
    demonstrated.push({
      id: "exit-blocked",
      severity: "demonstrated",
      title: "The exit is halted at the analysed block",
      detail: blockable.note,
      source: "Time to exit",
      link: { tab: "overview", anchor: "time-to-exit", node: lower(blockable.by[0]) },
    });
  } else if (blockable?.status === "blockable") {
    demonstrated.push({
      id: "exit-blockable",
      severity: "demonstrated",
      title: "A privileged party can stop holders leaving",
      detail: blockable.note,
      source: "Time to exit",
      link: { tab: "overview", anchor: "time-to-exit", node: lower(blockable.by[0]) },
    });
  } else if (blockable?.status === "undetermined") {
    unresolved.push({
      id: "exit-blockable",
      severity: "unresolved",
      title: "Whether the exit can be blocked was not established",
      detail: blockable.note,
      source: "Time to exit",
      link: { tab: "overview", anchor: "time-to-exit", node: null },
    });
  }

  if (report.timeToExit && report.timeToExit.unmeasuredLegs.length > 0) {
    unresolved.push({
      id: "exit-unmeasured",
      severity: "unresolved",
      title: `${report.timeToExit.unmeasuredLegs.length} part(s) of the exit were not measured`,
      detail:
        "An unmeasured leg is never counted as zero, so the reported duration is a floor: " +
        report.timeToExit.unmeasuredLegs.map((leg) => leg.name).join(", ") + ".",
      source: "Time to exit",
      link: { tab: "overview", anchor: "time-to-exit", node: null },
    });
  }

  // --- the fork differential ------------------------------------------------
  const er = report.exitRestriction;
  if (er) {
    er.candidates.forEach((candidate, index) => {
      const label = candidate.signature ?? candidate.selector;
      if (candidate.result === "restrictor") {
        demonstrated.push({
          id: `candidate-${index}`,
          severity: "demonstrated",
          title: `${label} closed the exit on a fork`,
          detail: candidate.detail,
          source: "Fork differential",
          link: { tab: "fork", anchor: `candidate-${index}`, node: lower(candidate.guardingParty) },
        });
      } else if (candidate.result === "inconclusive" || candidate.result === "not_evaluated") {
        unresolved.push({
          id: `candidate-${index}`,
          severity: "unresolved",
          title: `${label} was ${candidate.result.replace(/_/g, " ")}`,
          detail: candidate.detail,
          source: "Fork differential",
          link: { tab: "fork", anchor: `candidate-${index}`, node: lower(candidate.guardingParty) },
        });
      }
    });

    er.evaluationGaps.forEach((gap, index) => {
      unresolved.push({
        id: `fork-gap-${index}`,
        severity: "unresolved",
        title: "A gap stops the fork evaluation concluding cleanly",
        detail: gap,
        source: "Fork differential",
        link: { tab: "fork", anchor: "fork-result", node: null },
      });
    });

    if (er.baseline.status !== "established" && er.attempted) {
      unresolved.push({
        id: "fork-baseline",
        severity: "unresolved",
        title: "No baseline exit could be established on the fork",
        detail: `${er.baseline.note} Without a baseline there is nothing to compare a restricted exit against.`,
        source: "Fork differential",
        link: { tab: "fork", anchor: "fork-result", node: null },
      });
    }
  }

  // --- the drain proof ------------------------------------------------------
  if (report.proof?.produced) {
    demonstrated.push({
      id: "proof",
      severity: "demonstrated",
      title: "An upgrade moved funds on a sandbox fork",
      detail: `${report.proof.headline} Impersonated via ${report.proof.impersonatedVia}. This is capability, executed in a sandbox — never a prediction about anyone's intent.`,
      source: "Proof engine",
      link: { tab: "fork", anchor: "drain-proof", node: null },
    });
  }

  // --- attributed capabilities ---------------------------------------------
  //
  // Only the ATTRIBUTED ones. A capability whose guard could not be attributed
  // is an unresolved entry below, and one with no recognised auth revert is in
  // needsManualVerification — three different observations that must not merge.
  (report.capabilities?.findings ?? []).forEach((finding, index) => {
    if (finding.guard.status !== "attributed") return;
    demonstrated.push({
      id: `capability-${index}`,
      severity: "demonstrated",
      title: `${finding.signature} is reachable by a named holder`,
      detail: `${finding.category.replace(/_/g, " ").toLowerCase()} — guarded, and the guard maps to ${finding.guard.holders.join(", ")}.`,
      source: "Capabilities",
      link: { tab: "power", anchor: "power-map", node: lower(finding.guard.holders[0]) },
    });
  });

  (report.capabilities?.needsManualVerification ?? []).forEach((entry, index) => {
    unresolved.push({
      id: `manual-${index}`,
      severity: "unresolved",
      title: `${entry.signature} could not be tested for a guard`,
      detail: `${entry.reason.replace(/_/g, " ")} — ${entry.note} This is never a claim that the function is unguarded.`,
      source: "Capabilities",
      link: { tab: "evidence", anchor: "capabilities", node: null },
    });
  });

  const unmatched = report.capabilities?.unmatchedSelectors.length ?? 0;
  if (unmatched > 0) {
    unresolved.push({
      id: "unmatched-selectors",
      severity: "unresolved",
      title: `${unmatched} recovered selector(s) matched no taxonomy entry`,
      detail:
        "Unmatched means “not in Ripcord's taxonomy table”, never “not privileged”. The privileged surface " +
        "is therefore not fully evaluated.",
      source: "Capabilities",
      link: { tab: "evidence", anchor: "capabilities", node: null },
    });
  }

  // --- what the run could not see ------------------------------------------
  (report.enumeration?.gaps ?? []).forEach((gap, index) => {
    unresolved.push({
      id: `enumeration-${index}`,
      severity: "unresolved",
      title: `Incomplete enumeration at ${gap.where}`,
      detail: `${gap.reason} A reassuring window cannot be constructed over a route set that may be missing entries.`,
      source: "Enumeration",
      link: {
        tab: gap.site.kind === "authority" || gap.site.kind === "target" ? "power" : "evidence",
        anchor: gap.site.kind === "authority" || gap.site.kind === "target" ? "power-map" : "uncertainty",
        node: gap.site.kind === "authority" || gap.site.kind === "target" ? lower(gap.site.id) : null,
      },
    });
  });

  (report.budget?.exhausted ?? []).forEach((record, index) => {
    unresolved.push({
      id: `budget-${index}`,
      severity: "unresolved",
      title: `The analysis budget ran out at ${record.where}`,
      detail: `${record.consequence} The truncation is recorded so it cannot be mistaken for a target with less to find.`,
      source: "Budget",
      link: { tab: "evidence", anchor: "uncertainty", node: null },
    });
  });

  (report.errors ?? []).forEach((error, index) => {
    unresolved.push({
      id: `error-${index}`,
      severity: "unresolved",
      title: `The ${error.stage} stage failed to read`,
      detail: `${error.message} This is a failure of our infrastructure, not a property of the contract.`,
      source: "Infrastructure",
      link: { tab: "evidence", anchor: "uncertainty", node: null },
    });
  });

  return [...demonstrated, ...unresolved];
}
