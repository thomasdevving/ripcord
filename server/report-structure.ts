import type { Report } from "../src/report/schema.js";
import type { StructuralSnapshot } from "./shared/dto.js";
import { TransportObserver } from "./jobs/observer.js";
export function reportStructure(report: Report): StructuralSnapshot | null {
  if (!report.target?.address || !report.proxy || !report.authority) return null;
  const observer = new TransportObserver(report.target.address, () => undefined);
  observer.onProxy(report.proxy);
  const unavailable = { address: null, source: "not established", evidence: [] };
  observer.onOwnership({ owner: report.authority.owner ?? unavailable, pendingOwner: report.authority.pendingOwner ?? unavailable });
  if (report.authority.accessControl) observer.onAccessControl(report.authority.accessControl);
  observer.onPowerHolders(report.powerHolders ?? []);
  observer.onAuthority(report.authorityResolution);
  observer.onAuthorityIndirection(report.authorityIndirection);
  for (const candidate of report.exitRestriction?.candidates ?? []) {
    const type = candidate.guardingPartyType;
    if (!candidate.guardingParty || (type !== "safe" && type !== "eoa" && type !== "contract")) continue;
    const holder = report.powerHolders?.find(h => h.address.toLowerCase() === candidate.guardingParty!.toLowerCase());
    observer.onForkStep({
      phase: "verdict",
      outcome: candidate.result === "restrictor" ? "completed" : "inconclusive",
      detail: candidate.detail,
      party: {
        address: candidate.guardingParty, type,
        safeThreshold: holder?.safe?.threshold ?? null,
        safeOwners: holder?.safe?.owners.length ?? null,
        signature: candidate.signature ?? candidate.selector,
        relation: "can pause withdrawals of",
        confirmed: candidate.result === "restrictor",
      },
    });
  }
  const snapshot = observer.snapshot();
  // Collect only evidence entries, not arbitrary findings. This runs after the
  // report publication gate, so public report evidence may be inspected here.
  const evidence: unknown[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const v = value as Record<string, unknown>;
    if (v.kind && v.params && "rawValue" in v && "block" in v) { evidence.push(v); return; }
    for (const child of Object.values(v)) visit(child);
  };
  visit(report);
  for (const node of snapshot.nodes) {
    const unique = new Map<string, unknown>();
    for (const entry of evidence) {
      const text = JSON.stringify(entry);
      if (text.toLowerCase().includes(node.address.toLowerCase())) unique.set(text, entry);
    }
    node.evidence = [...unique.values()];
  }
  return snapshot;
}
