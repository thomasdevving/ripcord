/**
 * THE ENRICHED-ASSESSMENT COMPOSER.
 *
 * `buildEnrichedAssessment(report, assetContext)` is a PURE function of two
 * artifacts that already exist. No chain read, no RPC, no fork, no vendor
 * fetch — the same scope decision `buildAssetCoverage` makes, and for the same
 * reason: a composer that could go and fetch the missing piece would be able to
 * manufacture the evidence its conclusion rests on.
 *
 * See `shared/enriched.ts` for the four rules this file implements. The two
 * that do the most work here:
 *
 *   THE LINK MUST BE EARNED. `linkMismatches` compares target, chain, block
 *   number, block hash and the batch's own fork block. Any disagreement makes
 *   the whole assessment `unusable` and names what differed. This is the only
 *   place a fork result becomes a statement about a specific report, so an
 *   optimistic join here would produce a finding about a block nobody measured.
 *
 *   THE DIRECTION IS CAUTION-ONLY. `confirmed.length === 0` returns `no_change`
 *   before anything else is considered, so no path exists from a clean sidecar
 *   to a softer conclusion. Only a confirmed restrictor can change the outcome,
 *   and only ever toward a stricter one.
 */
import type { Report } from "../src/report/schema.js";
import type { AssetContextArtifact } from "./asset-context.js";
import type { AssetExitScenario } from "../src/fork/assetScenarios.js";
import {
  enrichedAssessmentVersion,
  NO_EFFECT_NOTE,
  type ConfirmedRestrictor,
  type EnrichedAssessment,
  type EnrichedOutcome,
  type UnconfirmedAsset,
} from "./shared/enriched.js";

/**
 * Verdict statuses that ALREADY report a party being able to shut or delay the
 * exit. Against these, a confirmed restrictor cannot make the finding worse in
 * kind — it makes it wider — so the outcome is `scope_broadened`. Listed
 * positively: an unrecognised future status is treated as "the report did not
 * reach this", which routes to the stricter variant rather than the softer one.
 */
const ALREADY_SEVERE = new Set(["no_notice", "trapped"]);

const SCOPE_NOTES = [
  "This statement is composed from the pinned report and a separate, experimental per-asset fork pass. It does not modify the report, its verdict, or any figure in it.",
  "A base asset marked as covered by the primary report is linked for provenance only and is not counted as an additional per-asset experiment.",
  "Only a demonstrated restriction can appear here. A candidate that produced no restriction contributes nothing to the conclusion and is listed separately.",
  "The assets named are the assets tested. Nothing is claimed about assets, exit routes, privileged functions, argument values, call sequences or economic conditions that were not.",
  "Every position was created on a fork. No mainnet transaction, private key or approval was used, and the guarding party was impersonated rather than authorised.",
];

function chainRefOf(chainId: number): string {
  return `evm:${chainId}`;
}

/**
 * Why this sidecar may not be read as evidence about this report.
 *
 * Every field compared here is one that, if it differed, would make the fork
 * result a measurement of something else.
 */
export function linkMismatches(report: Report, context: AssetContextArtifact): string[] {
  const out: string[] = [];
  const target = report.target?.address?.toLowerCase() ?? "";
  const batch = context.forkScenarios?.batch ?? null;

  if (context.target?.toLowerCase() !== target) {
    out.push("the sidecar was produced for a different contract address");
  }
  if (context.chainId !== report.chainId) {
    out.push("the sidecar was produced for a different chain");
  }
  if (context.block?.number !== report.block?.number) {
    out.push("the sidecar was pinned to a different block number");
  }
  // A null hash on either side is not a match. Two unknowns are not agreement.
  const reportHash = report.block?.hash && report.block.hash !== "0x" ? report.block.hash.toLowerCase() : null;
  const contextHash = context.block?.hash ? context.block.hash.toLowerCase() : null;
  if (reportHash === null || contextHash === null || reportHash !== contextHash) {
    out.push("the report and the sidecar do not agree on a single pinned block hash");
  }
  if (batch) {
    if (batch.forkBlock !== report.block?.number) {
      out.push("the fork batch ran at a different block than the report");
    }
    if (batch.target?.toLowerCase() !== target) {
      out.push("the fork batch ran against a different contract address");
    }
  }
  return out;
}

function assetFor(scenario: AssetExitScenario, chainRef: string, symbolOf: (address: string) => string | null) {
  return {
    chainRef,
    address: scenario.address.toLowerCase(),
    unverifiedSymbol: symbolOf(scenario.address.toLowerCase()),
  };
}

function statementFor(
  confirmed: ConfirmedRestrictor[],
  reportVerdict: string,
  broadened: boolean,
): string {
  const named = confirmed
    .map((item) => item.unverifiedSymbol ?? item.address)
    .join(", ");
  const immediate = confirmed.every((item) => item.noticeSeconds === "0");
  const notice = immediate
    ? "with no notice on the route that was exercised"
    : "on the route that was exercised";

  const lead = broadened
    ? `The report's verdict is already \`${reportVerdict}\`. The per-asset pass shows that finding reaches further than the report's own experiment established:`
    : `The report's verdict is \`${reportVerdict}\`. The per-asset pass demonstrated something the report did not reach on its own:`;

  return (
    `${lead} on a fork at the report's pinned block, a privileged party closed a working exit ` +
    `for ${confirmed.length} asset(s) — ${named} — ${notice}. ` +
    `Each was demonstrated by supplying a real position, withdrawing it successfully, restoring the exact prior state, ` +
    `applying the real privileged call, and finding the identical withdrawal refused. ` +
    `This describes capability, not intent, and says nothing about assets or routes that were not tested.`
  );
}

export function buildEnrichedAssessment(
  report: Report,
  assetContext: AssetContextArtifact | null,
): EnrichedAssessment {
  const chainRef = chainRefOf(report.chainId);
  const reportVerdict = report.verdict?.status ?? "undetermined";
  const batch = assetContext?.forkScenarios?.batch ?? null;

  // Vendor symbols are display metadata only, and are looked up by (chain,
  // address) from the sidecar's own candidate list rather than trusted as identity.
  const symbols = new Map<string, string | null>();
  for (const holding of assetContext?.exposure?.holdings ?? []) {
    if (holding.address) symbols.set(holding.address.toLowerCase(), holding.unverifiedSymbol || null);
  }
  const symbolOf = (address: string) => symbols.get(address) ?? null;

  const base = {
    enrichedAssessmentVersion,
    changesVerdict: false as const,
    experimental: batch?.experimental ?? true,
    scopeNotes: SCOPE_NOTES,
    provenance: {
      target: report.target?.address ?? "",
      chainRef,
      analysisBlock: report.block?.number ?? "",
      reportVerdict,
      reportRestrictionState: report.exitRestriction?.restrictionState ?? null,
      sidecarFetchedAt: assetContext?.exposure?.fetchedAt ?? null,
      sidecarCompletedAt: assetContext?.completedAt ?? null,
    },
  };

  const empty = { considered: 0, confirmed: 0, noEffect: 0, unresolved: 0 };

  if (!assetContext) {
    return {
      ...base,
      outcome: { status: "not_applicable", reason: "No post-analysis asset context was produced for this report." },
      unconfirmed: [],
      counts: empty,
    };
  }

  const mismatches = linkMismatches(report, assetContext);
  if (mismatches.length > 0) {
    return {
      ...base,
      outcome: {
        status: "unusable",
        reason: "The asset context could not be attached to this report, so none of its results are read as evidence about it.",
        mismatches,
      },
      unconfirmed: [],
      counts: empty,
    };
  }

  if (!batch) {
    return {
      ...base,
      outcome: {
        status: "not_applicable",
        reason:
          assetContext.forkScenarios?.requested === true
            ? `No per-asset fork batch is available for this report. ${assetContext.forkScenarios.note}`
            : "No per-asset fork scenarios were requested for this report.",
      },
      unconfirmed: [],
      counts: empty,
    };
  }

  const confirmed: ConfirmedRestrictor[] = [];
  const unconfirmed: UnconfirmedAsset[] = [];
  let noEffect = 0;

  for (const scenario of batch.scenarios) {
    // The base asset can be carried into the batch as a provenance link to the
    // primary experiment. It is not new evidence from the per-asset pass and
    // must not inflate either the considered or unresolved totals.
    if (scenario.state === "covered_by_primary_report") continue;
    const asset = assetFor(scenario, chainRef, symbolOf);
    if (scenario.state === "restrictor_confirmed") {
      confirmed.push({
        ...asset,
        guardian: scenario.guardian,
        guardianType: scenario.guardianType,
        noticeSeconds: scenario.noticeSeconds,
        holder: scenario.holder,
        suppliedRaw: scenario.suppliedRaw,
        recoveredRaw: scenario.recoveredRaw,
        evidenceRef: `asset-context.forkScenarios.batch.scenarios[${asset.address}].evidence`,
      });
      continue;
    }
    if (scenario.state === "no_effect") noEffect++;
    unconfirmed.push({ ...asset, state: scenario.state, detail: scenario.detail });
  }

  const counts = {
    considered: confirmed.length + unconfirmed.length,
    confirmed: confirmed.length,
    noEffect,
    unresolved: unconfirmed.length - noEffect,
  };
  // Every additional candidate is either confirmed or listed. The linked base
  // row is deliberately outside these counts because the primary report owns
  // that experiment.
  const scopeNotes = noEffect > 0 ? [...SCOPE_NOTES, NO_EFFECT_NOTE] : SCOPE_NOTES;

  // THE CAUTION-ONLY GATE. Reached before any outcome that says something, so
  // there is no route from a clean sidecar to a softer conclusion.
  if (confirmed.length === 0) {
    return {
      ...base,
      scopeNotes,
      outcome: {
        status: "no_change",
        reason:
          counts.considered === 0
            ? "The per-asset pass evaluated no candidate, so it adds nothing to the report's conclusion."
            : `No restriction was demonstrated on any of the ${counts.considered} candidate(s) considered, so nothing is added to the report's conclusion. This is not a clean result: ${counts.unresolved} candidate(s) reached no conclusion at all, and a candidate that showed no effect establishes only that one action did not close one exit in one experiment.`,
      },
      unconfirmed,
      counts,
    };
  }

  const broadened = ALREADY_SEVERE.has(reportVerdict);
  const outcome: EnrichedOutcome = broadened
    ? {
        status: "scope_broadened",
        reportVerdict,
        confirmed,
        statement: statementFor(confirmed, reportVerdict, true),
      }
    : {
        status: "stricter_than_report",
        reportVerdict,
        confirmed,
        statement: statementFor(confirmed, reportVerdict, false),
      };

  return { ...base, scopeNotes, outcome, unconfirmed, counts };
}
