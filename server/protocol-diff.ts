/**
 * Semantic report comparison.
 *
 * Evidence arrays, generation timestamps and ordering are deliberately absent:
 * they can change while the observed state remains identical. Every comparison
 * below is over a field that can change a reviewer's understanding of power,
 * notice, exitability, or the coverage under which those claims were made.
 */
import { createHash } from "node:crypto";
import { reportSchema, type Report } from "../src/report/schema.js";
import type { ProtocolChange, ProtocolTargetComparison } from "./shared/protocols.js";

type ChangeInput = Omit<ProtocolChange, "id">;

const address = (value: string | null | undefined): string => value?.toLowerCase() ?? "none";
const text = (value: unknown): string => {
  if (value === null || value === undefined || value === "") return "none";
  if (typeof value === "object") return stable(value);
  return String(value);
};
const sorted = (values: readonly string[]): string[] => [...values].map((v) => v.toLowerCase()).sort();
const stable = (value: unknown): string => JSON.stringify(value, (_key, nested) => {
  if (Array.isArray(nested) && nested.every((item) => typeof item === "string")) return [...nested].sort();
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return Object.fromEntries(Object.entries(nested).sort(([a], [b]) => a.localeCompare(b)));
  }
  return nested;
});

function change(input: ChangeInput): ProtocolChange {
  const digest = createHash("sha256")
    .update(stable([input.kind, input.title, input.beforePath, input.afterPath, input.before, input.after]))
    .digest("hex")
    .slice(0, 16);
  return { id: `chg_${digest}`, ...input };
}

function addIfChanged(
  out: ProtocolChange[],
  kind: ProtocolChange["kind"],
  attention: ProtocolChange["attention"],
  title: string,
  before: unknown,
  after: unknown,
  beforePath: string,
  afterPath = beforePath,
): void {
  if (stable(before) === stable(after)) return;
  out.push(change({ kind, attention, title, before: text(before), after: text(after), beforePath, afterPath }));
}

function roles(report: Report): Record<string, { name: string; adminRole: string; members: string[] }> {
  const result: Record<string, { name: string; adminRole: string; members: string[] }> = {};
  for (const role of report.authority.accessControl?.roles ?? []) {
    result[role.role.toLowerCase()] = {
      name: role.name ?? role.role,
      adminRole: role.adminRole?.toLowerCase() ?? "none",
      members: sorted(role.members),
    };
  }
  return result;
}

function capabilities(report: Report): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const finding of report.capabilities.findings) {
    const key = `${finding.selector.toLowerCase()}|${finding.category}|${finding.signature}`;
    result[key] = {
      scannedAddress: finding.scannedAddress.toLowerCase(),
      probedAddress: finding.probedAddress.toLowerCase(),
      guard:
        finding.guard.status === "attributed"
          ? {
              status: finding.guard.status,
              authSource: finding.guard.authSource,
              role: finding.guard.role?.toLowerCase() ?? null,
              holders: sorted(finding.guard.holders),
            }
          : { status: finding.guard.status, note: finding.guard.note },
    };
  }
  return result;
}

function authorityPaths(report: Report): unknown[] {
  return (report.authorityResolution?.paths ?? [])
    .map((path) => ({
      label: path.label,
      hops: path.hops.map((hop) => ({
        address: hop.address.toLowerCase(),
        relation: hop.relation,
        type: hop.type,
        depth: hop.depth,
      })),
      effectiveController: path.effectiveController?.toLowerCase() ?? null,
      effectiveControllerType: path.effectiveControllerType,
      terminationReason: path.terminationReason,
      confidence: path.confidence,
    }))
    .sort((a, b) => stable(a).localeCompare(stable(b)));
}

function authorityConfiguration(report: Report): unknown {
  const flatten = (nodes: NonNullable<Report["authorityResolution"]>["roots"]): unknown[] => nodes.flatMap((node) => [
    {
      address: node.address.toLowerCase(),
      relation: node.relation,
      type: node.type,
      confidence: node.confidence,
      terminal: node.terminal,
      terminationReason: node.terminationReason,
      safe: node.safe ? { threshold: node.safe.threshold, owners: sorted(node.safe.owners), version: node.safe.version } : null,
      timelock: node.timelock ? {
        kind: node.timelock.kind,
        delaySeconds: node.timelock.delaySeconds,
        cancellers: node.timelock.cancellers ? sorted(node.timelock.cancellers) : null,
        executors: node.timelock.executors ? sorted(node.timelock.executors) : null,
        adminCanShortenDelay: node.timelock.adminCanShortenDelay,
      } : null,
      accessControlDetected: node.accessControlDetected,
      roleEnumeration: node.roleEnumeration ? {
        complete: node.roleEnumeration.complete,
        confidence: node.roleEnumeration.confidence,
        scannedFromBlock: node.roleEnumeration.scannedFromBlock,
        scannedToBlock: node.roleEnumeration.scannedToBlock,
      } : null,
    },
    ...flatten(node.children),
  ]);
  return {
    directPowerHolders: report.powerHolders.map((holder) => ({
      address: holder.address.toLowerCase(),
      type: holder.type,
      viaCapabilities: [...holder.viaCapabilities].sort(),
      safe: holder.safe ? { threshold: holder.safe.threshold, owners: sorted(holder.safe.owners), version: holder.safe.version } : null,
    })).sort((a, b) => stable(a).localeCompare(stable(b))),
    resolvedNodes: flatten(report.authorityResolution?.roots ?? []).sort((a, b) => stable(a).localeCompare(stable(b))),
  };
}

function authorityShape(authority: Report["authority"]): unknown {
  return {
    owner: address(authority.owner?.address),
    pendingOwner: address(authority.pendingOwner?.address),
    roles: Object.fromEntries(Object.entries((() => {
      const result: Record<string, unknown> = {};
      for (const role of authority.accessControl?.roles ?? []) result[role.role.toLowerCase()] = { adminRole: role.adminRole?.toLowerCase() ?? null, members: sorted(role.members) };
      return result;
    })()).sort(([a], [b]) => a.localeCompare(b))),
  };
}

function capabilityShape(findings: Report["capabilities"]): unknown {
  const output: Record<string, unknown> = {};
  for (const finding of findings.findings) {
    const key = `${finding.selector.toLowerCase()}|${finding.category}|${finding.signature}`;
    output[key] = finding.guard.status === "attributed"
      ? { status: finding.guard.status, authSource: finding.guard.authSource, role: finding.guard.role?.toLowerCase() ?? null, holders: sorted(finding.guard.holders) }
      : { status: finding.guard.status, note: finding.guard.note };
  }
  return { dispatcherRecognized: findings.dispatcherRecognized, findings: output, unmatchedSelectors: sorted(findings.unmatchedSelectors) };
}

function dependencyControl(report: Report): unknown {
  return {
    tokens: report.dependencies.tokens.map((token) => ({
      token: token.token.toLowerCase(),
      proxy: {
        pattern: token.proxy.pattern,
        implementation: address(token.proxy.implementation),
        admin: address(token.proxy.admin),
        beacon: address(token.proxy.beacon),
      },
      authority: authorityShape(token.authority),
      capabilities: capabilityShape(token.capabilities),
      powerHolders: token.powerHolders.map((holder) => ({
        address: holder.address.toLowerCase(),
        type: holder.type,
        safe: holder.safe ? { threshold: holder.safe.threshold, owners: sorted(holder.safe.owners) } : null,
      })).sort((a, b) => stable(a).localeCompare(stable(b))),
    })).sort((a, b) => a.token.localeCompare(b.token)),
    oracles: report.dependencies.oracles.map((oracle) => ({
      source: oracle.source,
      address: oracle.address.toLowerCase(),
      authority: authorityShape(oracle.authority),
      powerHolders: oracle.powerHolders.map((holder) => ({ address: holder.address.toLowerCase(), type: holder.type })).sort((a, b) => stable(a).localeCompare(stable(b))),
    })).sort((a, b) => stable(a).localeCompare(stable(b))),
  };
}

function exitAssessment(report: Report): unknown {
  const assessment = report.exitWindow?.assessment;
  if (!assessment) return null;
  return {
    status: assessment.status,
    windowSeconds: "windowSeconds" in assessment ? assessment.windowSeconds : null,
    nominalDelaySeconds: "nominalDelaySeconds" in assessment ? assessment.nominalDelaySeconds : null,
    missing: "missing" in assessment ? [...assessment.missing].sort() : [],
    basis: "basis" in assessment ? [...assessment.basis].sort() : [],
    caveats: "caveats" in assessment ? [...assessment.caveats].sort() : [],
    confidence: assessment.confidence,
  };
}

function exitRoutes(report: Report): unknown[] {
  return (report.exitWindow?.routes ?? [])
    .map((route) => ({
      label: route.label,
      root: route.root.toLowerCase(),
      effectiveController: route.effectiveController?.toLowerCase() ?? null,
      effectiveControllerType: route.effectiveControllerType,
      terminationReason: route.terminationReason,
      rolePrivilege: route.rolePrivilege,
      noticeStatus: route.noticeStatus,
      noticeSeconds: route.noticeSeconds,
      nominalDelaySeconds: route.nominalDelaySeconds,
      categories: [...route.categories].sort(),
      confirmationMethod: route.confirmationMethod,
      restrictionState: route.restrictionState,
      confidence: route.confidence,
      timelock: route.timelock ? {
        address: route.timelock.address.toLowerCase(),
        kind: route.timelock.kind,
        delaySeconds: route.timelock.delaySeconds,
        binding: route.timelock.binding,
        method: route.timelock.method,
        timelockIsUpgradeable: route.timelock.timelockIsUpgradeable,
      } : null,
    }))
    .sort((a, b) => stable(a).localeCompare(stable(b)));
}

function coverageText(value: beforeCoverageShape): string {
  return [
    value.enumerationComplete ? "enumeration complete" : `${value.enumerationGaps.length} enumeration gap(s)`,
    `${value.unmatchedSelectors.length} unmatched selector(s)`,
    `${value.manualVerification.length} manual-verification item(s)`,
    `${value.dependencyUnmatchedSelectors.length} unmatched dependency selector(s)`,
    `${value.unknownCount} unknown(s)`,
    `${value.errorCount} error(s)`,
  ].join("; ");
}

type beforeCoverageShape = {
  enumerationComplete: boolean;
  enumerationGaps: string[];
  unmatchedSelectors: string[];
  manualVerification: string[];
  dependencyUnmatchedSelectors: string[];
  unknownCount: number;
  errorCount: number;
};

export function compareReports(input: {
  targetId: string;
  label: string;
  beforeReportId: string;
  afterReportId: string;
  before: unknown;
  after: unknown;
}): ProtocolTargetComparison {
  const beforeParsed = reportSchema.safeParse(input.before);
  const afterParsed = reportSchema.safeParse(input.after);
  if (!beforeParsed.success || !afterParsed.success) throw new Error("protocol comparison requires two current, schema-valid reports");
  const before = beforeParsed.data;
  const after = afterParsed.data;
  if (before.chainId !== after.chainId || address(before.target.address) !== address(after.target.address)) {
    throw new Error("protocol comparison requires reports for the same chain and target address");
  }

  const changes: ProtocolChange[] = [];
  addIfChanged(changes, "engine_version", "review", "Analysis engine version changed", `${before.schemaVersion} / ${before.rulesetVersion}`, `${after.schemaVersion} / ${after.rulesetVersion}`, "schemaVersion + rulesetVersion");
  addIfChanged(changes, "bytecode", "high", "Target bytecode changed", before.target.bytecodeHash, after.target.bytecodeHash, "target.bytecodeHash");
  addIfChanged(changes, "proxy", "high", "Proxy pattern changed", before.proxy.pattern, after.proxy.pattern, "proxy.pattern");
  addIfChanged(changes, "proxy", "high", "Proxy implementation changed", address(before.proxy.implementation), address(after.proxy.implementation), "proxy.implementation");
  addIfChanged(changes, "proxy", "high", "Proxy admin changed", address(before.proxy.admin), address(after.proxy.admin), "proxy.admin");
  addIfChanged(changes, "proxy", "high", "Proxy beacon changed", address(before.proxy.beacon), address(after.proxy.beacon), "proxy.beacon");
  addIfChanged(changes, "authority", "high", "Owner changed", address(before.authority.owner?.address), address(after.authority.owner?.address), "authority.owner.address");
  addIfChanged(changes, "authority", "high", "Pending owner changed", address(before.authority.pendingOwner?.address), address(after.authority.pendingOwner?.address), "authority.pendingOwner.address");

  const beforeRoles = roles(before);
  const afterRoles = roles(after);
  const roleKeys = [...new Set([...Object.keys(beforeRoles), ...Object.keys(afterRoles)])].sort();
  for (const key of roleKeys) {
    const oldRole = beforeRoles[key];
    const newRole = afterRoles[key];
    addIfChanged(
      changes,
      "role_membership",
      "high",
      `${newRole?.name ?? oldRole?.name ?? key} membership changed`,
      oldRole ? `${oldRole.members.join(", ") || "no members"}; admin ${oldRole.adminRole}` : "role absent",
      newRole ? `${newRole.members.join(", ") || "no members"}; admin ${newRole.adminRole}` : "role absent",
      `authority.accessControl.roles[${key}]`,
    );
  }

  const beforeCapabilities = capabilities(before);
  const afterCapabilities = capabilities(after);
  const capabilityKeys = [...new Set([...Object.keys(beforeCapabilities), ...Object.keys(afterCapabilities)])].sort();
  for (const key of capabilityKeys) {
    const oldCapability = beforeCapabilities[key];
    const newCapability = afterCapabilities[key];
    addIfChanged(
      changes,
      "capability",
      "high",
      `Privileged capability changed: ${key.split("|")[2] ?? key}`,
      oldCapability ? stable(oldCapability) : "not found",
      newCapability ? stable(newCapability) : "not found",
      `capabilities.findings[${key}]`,
    );
  }

  addIfChanged(changes, "authority_path", "high", "Resolved authority paths changed", authorityPaths(before), authorityPaths(after), "authorityResolution.paths");
  addIfChanged(changes, "authority", "high", "Authority account configuration changed", authorityConfiguration(before), authorityConfiguration(after), "powerHolders + authorityResolution.roots");
  addIfChanged(
    changes,
    "authority_indirection",
    "high",
    "Authority indirection markers changed",
    before.authorityIndirection?.markers.map((marker) => ({ signature: marker.signature, selector: marker.selector.toLowerCase(), target: marker.target.toLowerCase() })).sort((a, b) => stable(a).localeCompare(stable(b))) ?? null,
    after.authorityIndirection?.markers.map((marker) => ({ signature: marker.signature, selector: marker.selector.toLowerCase(), target: marker.target.toLowerCase() })).sort((a, b) => stable(a).localeCompare(stable(b))) ?? null,
    "authorityIndirection.markers",
  );
  addIfChanged(changes, "dependency", "high", "Dependency control surface changed", dependencyControl(before), dependencyControl(after), "dependencies");
  addIfChanged(changes, "exit_window", "high", "Exit Window assessment changed", exitAssessment(before), exitAssessment(after), "exitWindow.assessment");
  addIfChanged(changes, "exit_window", "high", "Exit Window routes changed", exitRoutes(before), exitRoutes(after), "exitWindow.routes");
  addIfChanged(changes, "time_to_exit", "high", "Time-to-exit assessment changed", before.timeToExit ? {
    status: before.timeToExit.status,
    atLeastSeconds: before.timeToExit.atLeastSeconds,
    tight: before.timeToExit.tight,
    confidence: before.timeToExit.confidence,
    legs: before.timeToExit.legs.map((leg) => ({ kind: leg.kind, name: leg.name, seconds: leg.seconds, measured: leg.measured, confidence: leg.confidence, mutableBy: leg.mutableBy })).sort((a, b) => stable(a).localeCompare(stable(b))),
    unmeasuredLegs: before.timeToExit.unmeasuredLegs.map((leg) => ({ name: leg.name, reason: leg.reason })).sort((a, b) => stable(a).localeCompare(stable(b))),
  } : null, after.timeToExit ? {
    status: after.timeToExit.status,
    atLeastSeconds: after.timeToExit.atLeastSeconds,
    tight: after.timeToExit.tight,
    confidence: after.timeToExit.confidence,
    legs: after.timeToExit.legs.map((leg) => ({ kind: leg.kind, name: leg.name, seconds: leg.seconds, measured: leg.measured, confidence: leg.confidence, mutableBy: leg.mutableBy })).sort((a, b) => stable(a).localeCompare(stable(b))),
    unmeasuredLegs: after.timeToExit.unmeasuredLegs.map((leg) => ({ name: leg.name, reason: leg.reason })).sort((a, b) => stable(a).localeCompare(stable(b))),
  } : null, "timeToExit");
  addIfChanged(changes, "exit_blockability", "high", "Exit blockability changed", before.timeToExit ? { status: before.timeToExit.blockable.status, by: sorted(before.timeToExit.blockable.by) } : null, after.timeToExit ? { status: after.timeToExit.blockable.status, by: sorted(after.timeToExit.blockable.by) } : null, "timeToExit.blockable");
  addIfChanged(changes, "verdict", "high", "Verdict changed", before.verdict ? { status: before.verdict.status, marginSeconds: before.verdict.marginSeconds, confidence: before.verdict.confidence, missing: [...before.verdict.missing].sort(), inputs: before.verdict.inputs.map((item) => ({ name: item.name, value: item.value, confidence: item.confidence, source: item.source })).sort((a, b) => stable(a).localeCompare(stable(b))) } : null, after.verdict ? { status: after.verdict.status, marginSeconds: after.verdict.marginSeconds, confidence: after.verdict.confidence, missing: [...after.verdict.missing].sort(), inputs: after.verdict.inputs.map((item) => ({ name: item.name, value: item.value, confidence: item.confidence, source: item.source })).sort((a, b) => stable(a).localeCompare(stable(b))) } : null, "verdict");

  const beforeCoverage: beforeCoverageShape = {
    enumerationComplete: before.enumeration.complete,
    enumerationGaps: before.enumeration.gaps.map((gap) => `${gap.site.kind}:${gap.site.id}`).sort(),
    unmatchedSelectors: sorted(before.capabilities.unmatchedSelectors),
    manualVerification: before.capabilities.needsManualVerification.map((entry) => `${entry.selector}:${entry.reason}`).sort(),
    unknownCount: before.unknowns.length,
    errorCount: before.errors.length,
    dependencyUnmatchedSelectors: before.dependencies.tokens.flatMap((token) => token.capabilities.unmatchedSelectors.map((selector) => `${token.token.toLowerCase()}:${selector.toLowerCase()}`)).sort(),
  };
  const afterCoverage: beforeCoverageShape = {
    enumerationComplete: after.enumeration.complete,
    enumerationGaps: after.enumeration.gaps.map((gap) => `${gap.site.kind}:${gap.site.id}`).sort(),
    unmatchedSelectors: sorted(after.capabilities.unmatchedSelectors),
    manualVerification: after.capabilities.needsManualVerification.map((entry) => `${entry.selector}:${entry.reason}`).sort(),
    unknownCount: after.unknowns.length,
    errorCount: after.errors.length,
    dependencyUnmatchedSelectors: after.dependencies.tokens.flatMap((token) => token.capabilities.unmatchedSelectors.map((selector) => `${token.token.toLowerCase()}:${selector.toLowerCase()}`)).sort(),
  };
  if (stable(beforeCoverage) !== stable(afterCoverage)) {
    changes.push(change({
      kind: "analysis_coverage",
      attention: "review",
      title: "Analysis coverage changed",
      before: coverageText(beforeCoverage),
      after: coverageText(afterCoverage),
      beforePath: "enumeration + capabilities coverage + unknowns + errors",
      afterPath: "enumeration + capabilities coverage + unknowns + errors",
    }));
  }

  return {
    targetId: input.targetId,
    label: input.label,
    address: after.target.address,
    beforeReportId: input.beforeReportId,
    afterReportId: input.afterReportId,
    beforeBlock: before.block.number,
    afterBlock: after.block.number,
    changes,
  };
}
