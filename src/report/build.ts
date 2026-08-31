/**
 * Orchestrates the detectors into a single report and validates it against
 * the zod schema before returning it. A report that fails its own schema
 * is a bug in Ripcord, not a bad target — that failure is surfaced, not
 * swallowed.
 */
import { keccak256, type Hex } from "viem";
import type { ChainReader } from "../chain/client.js";
import { detectProxy } from "../detect/proxy.js";
import { detectOwnership } from "../detect/ownership.js";
import { detectAccessControl } from "../detect/accessControl.js";
import { collectPowerHolders } from "../detect/accounts.js";
import { detectCapabilities } from "../detect/capabilities.js";
import { detectDependencies } from "../detect/dependencies.js";
import { taxonomyVersion } from "../detect/taxonomy.js";
import {
  reportSchema,
  schemaVersion,
  rulesetVersion,
  type CapabilitiesResult,
  type DependencyGraph,
  type Disclosure,
  type ErrorEntry,
  type Report,
  type UnknownEntry,
} from "./schema.js";

/**
 * Applies the publication gate described on `disclosureSchema`: any
 * `needsManualVerification` entry, at the target or anywhere in the
 * dependency graph, makes the report non-publishable. Deliberately
 * conservative — it gates on the presence of the uncertainty itself, never
 * on how serious the entry happens to look, so calibration day is a
 * mechanical check rather than a per-protocol ethics call under time
 * pressure.
 */
function assessDisclosure(capabilities: CapabilitiesResult, dependencies: DependencyGraph): Disclosure {
  const blockedBy: Disclosure["blockedBy"] = [
    ...capabilities.needsManualVerification.map((e) => ({
      location: `capabilities (${e.probedAddress})`,
      signature: e.signature,
      category: e.category,
    })),
    ...dependencies.tokens.flatMap((t) =>
      t.capabilities.needsManualVerification.map((e) => ({
        location: `dependencies.tokens[${t.token}]`,
        signature: e.signature,
        category: e.category,
      })),
    ),
  ];

  if (blockedBy.length === 0) {
    return {
      publishable: true,
      reason:
        "no needsManualVerification entries at the target or in its dependency graph — this report contains only admin-capability findings, which the disclosure policy publishes freely",
      blockedBy: [],
    };
  }
  return {
    publishable: false,
    reason: `${blockedBy.length} capability/capabilities could not be attributed to a recognized guard by probing. Probing cannot distinguish "guarded by a scheme Ripcord doesn't recognize" from "not guarded at all," and the second reading would be a vulnerability claim about a live contract. Do not publish this report: keep it local until each entry below is either cleared by a human as a design property, or disclosed to the project. See the disclosure policy in README.`,
    blockedBy,
  };
}

export async function buildReport(chain: ChainReader, target: Hex): Promise<Report> {
  const unknowns: UnknownEntry[] = [];
  const errors: ErrorEntry[] = [];

  const { code, evidence: codeEvidence } = await chain.getCode(target);
  const bytecodeSize = code ? (code.length - 2) / 2 : 0;
  const bytecodeHash = code ? keccak256(code) : null;

  const proxy = await runStage(
    "proxy",
    () => detectProxy(chain, target),
    errors,
    () => ({
      pattern: "unknown" as const,
      isProxy: false,
      implementation: null,
      beacon: null,
      admin: null,
      slots: {},
      evidence: [codeEvidence],
    }),
  );

  // Authority-related state (owner, AccessControl roles) is always read from
  // `target`, never from `proxy.implementation`. A proxy's storage — where
  // owner/role state actually lives — belongs to the proxy address; the
  // implementation is only code reached via delegatecall, and querying it
  // directly would read the implementation contract's own (usually
  // uninitialized) storage instead.
  const ownership = await runStage(
    "ownership",
    () => detectOwnership(chain, target),
    errors,
    () => ({
      owner: { address: null, source: "detection failed, see errors[]", evidence: [] },
      pendingOwner: { address: null, source: "detection failed, see errors[]", evidence: [] },
    }),
  );

  const accessControlDetection = await runStage(
    "accessControl",
    () => detectAccessControl(chain, target),
    errors,
    () => ({ result: { detected: false, method: "not_applicable" as const, roles: [] }, unknowns: [] }),
  );
  unknowns.push(...accessControlDetection.unknowns);

  // Capability detection scans the implementation's bytecode for a proxy
  // (see detectCapabilities), but attributes guards using THIS target's
  // owner()/AccessControl state — the implementation's own storage is not
  // where authority lives, same reasoning as ownership/accessControl above.
  const capabilityDetection = await runStage(
    "capabilities",
    () =>
      detectCapabilities(
        chain,
        target,
        proxy,
        ownership.owner.address as Hex | null,
        accessControlDetection.result.roles,
      ),
    errors,
    () => ({
      result: {
        taxonomyVersion,
        dispatcherRecognized: false,
        scannedAddress: null,
        probedAddress: target,
        selectorsExtracted: 0,
        unmatchedSelectors: [],
        findings: [],
        needsManualVerification: [],
        evidence: [],
      } as CapabilitiesResult,
      unknowns: [],
    }),
  );
  unknowns.push(...capabilityDetection.unknowns);

  const capabilityHolders = capabilityDetection.result.findings
    .filter((f) => f.guard.status === "attributed")
    .flatMap((f) =>
      (f.guard as Extract<typeof f.guard, { status: "attributed" }>).holders.map((address) => ({
        address,
        label: f.signature,
      })),
    );

  const powerHolders = await collectPowerHolders(chain, {
    owner: ownership.owner.address as Hex | null,
    pendingOwner: ownership.pendingOwner.address as Hex | null,
    proxyAdmin: proxy.admin as Hex | null,
    accessControlRoles: accessControlDetection.result.roles,
    capabilityHolders,
  });

  const dependencyDetection = await runStage(
    "dependencies",
    () => detectDependencies(chain, target),
    errors,
    () => ({ result: { tokens: [], oracles: [] } as DependencyGraph, unknowns: [] }),
  );
  unknowns.push(...dependencyDetection.unknowns);

  if (!code) {
    unknowns.push({ field: "target", reason: "address has no code at the pinned block (EOA or not yet deployed)" });
  }
  if (proxy.pattern === "unknown") {
    unknowns.push({
      field: "proxy.pattern",
      reason: "bytecode contains a DELEGATECALL but matches no known proxy storage pattern",
    });
  }
  // The dangerous misreading this guards against: an upgradeable proxy with
  // owner=null, accessControl.detected=false, and an empty powerHolders[]
  // looks identical, at a glance, to "no privileged power exists here." For
  // a confirmed proxy that is never true — something can upgrade it — we
  // just didn't recognise the mechanism. Say so explicitly rather than let
  // the absence of findings read as a clean bill of health.
  if (proxy.isProxy && !proxy.admin && !ownership.owner.address && !accessControlDetection.result.detected) {
    unknowns.push({
      field: "authority",
      reason:
        "target is a confirmed upgradeable proxy, but no upgrade authority could be identified via owner()/AccessControl — it likely uses a non-standard or custom access-control scheme; the proxy IS upgradeable by someone, manual review required",
    });
  }

  const blockHash = await runStage(
    "block",
    () => chain.getBlockHash(),
    errors,
    () => "0x" as Hex,
  );

  const report: Report = {
    schemaVersion,
    rulesetVersion,
    generatedAt: new Date().toISOString(),
    chainId: chain.chainId,
    block: { number: chain.blockNumber.toString(), hash: blockHash },
    target: {
      address: target,
      hasCode: Boolean(code),
      bytecodeSize,
      bytecodeHash,
    },
    proxy,
    authority: {
      owner: ownership.owner,
      pendingOwner: ownership.pendingOwner,
      accessControl: accessControlDetection.result,
    },
    powerHolders,
    capabilities: capabilityDetection.result,
    dependencies: dependencyDetection.result,
    disclosure: assessDisclosure(capabilityDetection.result, dependencyDetection.result),
    unknowns,
    errors,
  };

  const validated = reportSchema.safeParse(report);
  if (!validated.success) {
    throw new Error(
      `Ripcord produced a report that fails its own schema — this is a Ripcord bug, not a target problem:\n${validated.error.toString()}`,
    );
  }

  return validated.data;
}

async function runStage<T>(
  stage: string,
  fn: () => Promise<T>,
  errors: ErrorEntry[],
  fallback: () => T,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    errors.push({ stage, message: err instanceof Error ? err.message : String(err) });
    return fallback();
  }
}
