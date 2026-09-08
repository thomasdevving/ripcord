import type { JobManager } from "./jobs/manager.js";
import { isTerminal } from "./shared/dto.js";
import { compareReports } from "./protocol-diff.js";
import { ProtocolStore, type StoredProtocolScan } from "./protocol-store.js";
import type { ReportService } from "./reports.js";
import type {
  ProtocolComparison,
  ProtocolComparisonGap,
  ProtocolDetailResponse,
  ProtocolListItem,
  ProtocolRecord,
  ProtocolScanState,
  ProtocolScanTargetView,
  ProtocolScanView,
} from "./shared/protocols.js";

export class ProtocolService {
  constructor(
    private readonly store: ProtocolStore,
    private readonly jobs: JobManager,
    private readonly reports: ReportService,
  ) {}

  async list(): Promise<ProtocolListItem[]> {
    return Promise.all((await this.store.listProtocols()).map(async (protocol) => {
      const scans = await this.store.listScans(protocol.id);
      const last = scans.at(-1);
      const view = last ? await this.viewScan(protocol, last, scans) : null;
      return {
        ...protocol,
        scanCount: scans.length,
        lastScanAt: last?.createdAt ?? null,
        lastScanState: view?.state ?? null,
      };
    }));
  }

  async detail(protocol: ProtocolRecord): Promise<ProtocolDetailResponse> {
    const scans = await this.store.listScans(protocol.id);
    const views = await Promise.all([...scans].reverse().map((scan) => this.viewScan(protocol, scan, scans)));
    return { protocol, scans: views };
  }

  async viewScan(protocol: ProtocolRecord, scan: StoredProtocolScan, allScans?: StoredProtocolScan[]): Promise<ProtocolScanView> {
    const targets = await Promise.all(scan.targets.map(async (stored): Promise<ProtocolScanTargetView> => {
      const target = protocol.targets.find((candidate) => candidate.id === stored.targetId);
      if (!target) {
        return {
          targetId: stored.targetId,
          label: "Removed contract",
          address: "",
          chainId: 1,
          jobId: stored.jobId,
          state: "submission_failed",
          reportId: null,
          block: null,
          disclosure: null,
          error: { message: "This contract is no longer part of the protocol definition.", hint: null },
        };
      }
      if (!stored.jobId) {
        return {
          targetId: target.id,
          label: target.label,
          address: target.address,
          chainId: target.chainId,
          jobId: null,
          state: "submission_failed",
          reportId: null,
          block: null,
          disclosure: null,
          error: stored.submissionError ?? { message: "This contract was not submitted.", hint: null },
        };
      }
      const record = await this.jobs.getRecord(stored.jobId);
      if (!record) {
        return {
          targetId: target.id,
          label: target.label,
          address: target.address,
          chainId: target.chainId,
          jobId: stored.jobId,
          state: "interrupted",
          reportId: null,
          block: null,
          disclosure: null,
          error: { message: "The analysis record is no longer available.", hint: "Start a new protocol scan." },
        };
      }
      const summary = this.jobs.toSummary(record);
      return {
        targetId: target.id,
        label: target.label,
        address: target.address,
        chainId: target.chainId,
        jobId: stored.jobId,
        state: summary.state,
        reportId: summary.reportId,
        block: summary.block,
        disclosure: summary.disclosure,
        error: summary.error,
      };
    }));

    const state = aggregateState(targets);
    const scans = allScans ?? await this.store.listScans(protocol.id);
    const previous = scans.filter((candidate) => candidate.sequence < scan.sequence).at(-1) ?? null;
    const comparison = previous && state !== "queued" && state !== "running"
      ? await this.compare(protocol, previous, scan, targets)
      : null;
    return { id: scan.id, protocolId: scan.protocolId, sequence: scan.sequence, kind: scan.kind, state, createdAt: scan.createdAt, targets, comparison };
  }

  private async compare(
    protocol: ProtocolRecord,
    previous: StoredProtocolScan,
    current: StoredProtocolScan,
    currentTargets: ProtocolScanTargetView[],
  ): Promise<ProtocolComparison> {
    const previousView = await this.viewTargets(protocol, previous);
    const targets = [];
    const gaps: ProtocolComparisonGap[] = [];

    for (const target of protocol.targets) {
      const before = previousView.find((item) => item.targetId === target.id);
      const after = currentTargets.find((item) => item.targetId === target.id);
      if (!before?.reportId || !after?.reportId) {
        gaps.push({
          targetId: target.id,
          label: target.label,
          reason: comparisonGap(before, after),
        });
        continue;
      }
      const [beforeReport, afterReport] = await Promise.all([
        this.reports.loadPublishable(before.reportId),
        this.reports.loadPublishable(after.reportId),
      ]);
      if (!beforeReport.ok || !afterReport.ok) {
        gaps.push({ targetId: target.id, label: target.label, reason: "One of the reports is unavailable or withheld, so no comparison is claimed." });
        continue;
      }
      try {
        targets.push(compareReports({
          targetId: target.id,
          label: target.label,
          beforeReportId: before.reportId,
          afterReportId: after.reportId,
          before: beforeReport.value.report,
          after: afterReport.value.report,
        }));
      } catch {
        gaps.push({ targetId: target.id, label: target.label, reason: "The two artifacts were not compatible with the current comparison schema." });
      }
    }

    return {
      fromScanId: previous.id,
      toScanId: current.id,
      comparableTargets: targets.length,
      totalTargets: protocol.targets.length,
      totalChanges: targets.reduce((sum, target) => sum + target.changes.length, 0),
      targets,
      gaps,
    };
  }

  private async viewTargets(protocol: ProtocolRecord, scan: StoredProtocolScan): Promise<ProtocolScanTargetView[]> {
    const view: Array<ProtocolScanTargetView | null> = await Promise.all(scan.targets.map(async (stored): Promise<ProtocolScanTargetView | null> => {
      const target = protocol.targets.find((candidate) => candidate.id === stored.targetId);
      if (!target) return null;
      const base = { targetId: target.id, label: target.label, address: target.address, chainId: target.chainId };
      if (!stored.jobId) return { ...base, jobId: null, state: "submission_failed", reportId: null, block: null, disclosure: null, error: stored.submissionError };
      const record = await this.jobs.getRecord(stored.jobId);
      if (!record) return { ...base, jobId: stored.jobId, state: "interrupted", reportId: null, block: null, disclosure: null, error: null };
      const summary = this.jobs.toSummary(record);
      return { ...base, jobId: stored.jobId, state: summary.state, reportId: summary.reportId, block: summary.block, disclosure: summary.disclosure, error: summary.error };
    }));
    return view.filter((item): item is ProtocolScanTargetView => item !== null);
  }
}

function aggregateState(targets: ProtocolScanTargetView[]): ProtocolScanState {
  if (targets.some((target) => target.state === "running")) return "running";
  if (targets.some((target) => target.state === "queued")) return "queued";
  const successes = targets.filter((target) => target.state === "completed" && target.reportId).length;
  if (successes === targets.length && targets.length > 0) return "completed";
  if (successes > 0) return "partial";
  if (targets.some((target) => target.state === "completed" && target.disclosure?.publishable === false)) return "partial";
  return "failed";
}

function comparisonGap(before: ProtocolScanTargetView | undefined, after: ProtocolScanTargetView | undefined): string {
  if (!before) return "This contract was absent from the previous scan.";
  if (!after) return "This contract is absent from the new scan.";
  if (!terminal(before.state) || !terminal(after.state)) return "One of the two analyses is still running, so the comparison is incomplete.";
  if (before.disclosure?.publishable === false || after.disclosure?.publishable === false) return "One of the reports is withheld pending manual review; Ripcord does not infer no change from that gap.";
  if (before.error || after.error) return "One of the two analyses failed, so no state comparison is claimed.";
  return "A publishable report is unavailable for one of the two analyses.";
}

function terminal(state: ProtocolScanTargetView["state"]): boolean {
  return state === "submission_failed" || isTerminal(state);
}
