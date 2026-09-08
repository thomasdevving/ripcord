import type { Report } from "../src/report/schema.js";
import type { StructuralSnapshot } from "./shared/dto.js";
import { TransportObserver } from "./jobs/observer.js";
import { buildEvidenceIndex } from "../src/report/evidenceIndex.js";
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

  // Evidence is indexed ONCE and attached by reference. This runs after the
  // report publication gate, so public report evidence may be inspected here.
  //
  // The previous shape serialised every entry for every node and asked whether
  // the node's address appeared anywhere in the resulting string — quadratic in
  // (nodes x evidence x size), and not actually a statement about relevance: an
  // address can sit inside unrelated calldata, while an ABI-encoded address in a
  // 32-byte storage word does not contain its 40-character form at all. So the
  // old rule over-attached and under-attached at the same time, silently. See
  // src/report/evidenceIndex.ts for how an entry now NAMES an address.
  const index = buildEvidenceIndex(report);
  const inlined = new Set<string>();
  for (const node of snapshot.nodes) {
    const all = index.idsFor(node.address);
    node.evidenceTotal = all.length;
    node.evidenceIds = all.slice(0, EVIDENCE_INLINE_LIMIT);
    for (const id of node.evidenceIds) inlined.add(id);
  }
  // One shared table holding ONLY what the nodes reference, so an entry relevant
  // to five nodes is transported once and an entry relevant to none is not
  // transported at all. The remainder is served on demand — see the evidence
  // route in server/routes.ts.
  snapshot.evidence = Object.fromEntries(
    index.entries.filter(({ id }) => inlined.has(id)).map(({ id, evidence }) => [id, evidence]),
  );
  snapshot.evidenceInlineLimit = EVIDENCE_INLINE_LIMIT;
  return snapshot;
}

/**
 * How many evidence entries a node inlines.
 *
 * Chosen against the corpus rather than by feel: the Aave ACL Manager report's
 * single node is named by 1,518 log-scan reads, and inlining them made the graph
 * payload larger than the useful part of the report. Fifty is more than enough
 * to see what kind of reads support a node; the exact count is always reported
 * beside it, and the full set is one request away.
 */
const EVIDENCE_INLINE_LIMIT = 50;
