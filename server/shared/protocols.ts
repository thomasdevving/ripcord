import type { JobState } from "./dto.js";

/** A named contract inside a protocol workspace. */
export interface ProtocolTarget {
  id: string;
  label: string;
  address: string;
  chainId: number;
}

export interface ProtocolRecord {
  id: string;
  name: string;
  targets: ProtocolTarget[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateProtocolRequest {
  name: string;
  targets: Array<{ label?: string; address: string; chainId?: number }>;
}

export type ProtocolScanState = "queued" | "running" | "completed" | "partial" | "failed";

export interface ProtocolListItem extends ProtocolRecord {
  scanCount: number;
  lastScanAt: string | null;
  lastScanState: ProtocolScanState | null;
}

export interface ProtocolScanTargetView {
  targetId: string;
  label: string;
  address: string;
  chainId: number;
  jobId: string | null;
  state: JobState | "submission_failed";
  reportId: string | null;
  block: string | null;
  disclosure: { publishable: boolean; message: string } | null;
  error: { message: string; hint: string | null } | null;
}

export type ProtocolChangeKind =
  | "engine_version"
  | "bytecode"
  | "proxy"
  | "authority"
  | "role_membership"
  | "capability"
  | "authority_path"
  | "authority_indirection"
  | "dependency"
  | "exit_window"
  | "time_to_exit"
  | "exit_blockability"
  | "verdict"
  | "analysis_coverage";

/**
 * A semantic difference between two reports. `attention` prioritises review;
 * it is not a risk verdict and never claims that a change is safe or malicious.
 */
export interface ProtocolChange {
  id: string;
  kind: ProtocolChangeKind;
  attention: "high" | "review";
  title: string;
  before: string;
  after: string;
  beforePath: string;
  afterPath: string;
}

export interface ProtocolTargetComparison {
  targetId: string;
  label: string;
  address: string;
  beforeReportId: string;
  afterReportId: string;
  beforeBlock: string;
  afterBlock: string;
  changes: ProtocolChange[];
}

export interface ProtocolComparisonGap {
  targetId: string;
  label: string;
  reason: string;
}

export interface ProtocolComparison {
  fromScanId: string;
  toScanId: string;
  comparableTargets: number;
  totalTargets: number;
  totalChanges: number;
  targets: ProtocolTargetComparison[];
  gaps: ProtocolComparisonGap[];
}

export interface ProtocolScanView {
  id: string;
  protocolId: string;
  sequence: number;
  kind: "baseline" | "rescan";
  state: ProtocolScanState;
  createdAt: string;
  targets: ProtocolScanTargetView[];
  comparison: ProtocolComparison | null;
}

export interface ProtocolDetailResponse {
  protocol: ProtocolRecord;
  scans: ProtocolScanView[];
}

export interface StartProtocolScanResponse {
  scan: ProtocolScanView;
}
