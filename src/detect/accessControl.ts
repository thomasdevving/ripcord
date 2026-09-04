/**
 * OpenZeppelin AccessControl detection.
 *
 * DEFAULT_ADMIN_ROLE() succeeding is evidence the contract implements
 * AccessControl — universal across versions, including non-Enumerable ones.
 * getRoleMemberCount is an Enumerable-only extension: when present, a
 * RoleGranted/RoleRevoked scan discovers WHICH role hashes exist (a role must
 * have been granted at least once for membership to be non-empty) and current
 * membership is read from the Enumerable getters, which is authoritative.
 * Otherwise membership is reconstructed by replaying those events from the
 * deployment block to the pinned block.
 *
 * The log range is chunked to the provider's PROBED eth_getLogs limit (see
 * rpcPreflight.ts), not a fixed guess. If the full range would exceed the
 * request budget the scan degrades to the most recent affordable window and
 * labels the result `reconstruction.complete = false` with a lowered confidence
 * and the exact window covered — never a silent truncation reading as "no roles
 * found", never full confidence over a partial scan.
 */
import { decodeFunctionResult, encodeFunctionData, type Hex } from "viem";
import type { Evidence, ChainReader } from "../chain/client.js";
import { accessControlAbi } from "../chain/abi.js";
import { KNOWN_ROLE_HASHES, RELEVANT_EVENTS } from "../chain/constants.js";
import { probeMaxLogRange } from "../chain/rpcPreflight.js";
import { findDeploymentBlock } from "./deployment.js";
import type { AccessControlResult, RoleEntry, RoleReconstruction, UnknownEntry } from "../report/schema.js";

/**
 * The maximum number of eth_getLogs REQUESTS the role scan will make before it
 * degrades to a labelled partial reconstruction. This bounds cost on providers
 * with a small getLogs range (each chunk covers fewer blocks, so a full history
 * needs more requests): rather than fire hundreds of thousands of requests — or
 * silently truncate — the scan covers the most recent `budget` chunks and says
 * so, with lowered confidence. On a generous provider a normal contract's whole
 * history fits well inside this budget and the scan is `complete`.
 */
const MAX_LOG_REQUESTS = 1500;

interface RoleEventArgs {
  role?: Hex;
  account?: Hex;
  sender?: Hex;
}
interface RoleEventLog {
  args: RoleEventArgs;
  eventName?: string;
  blockNumber: bigint | null;
  logIndex: number | null;
}

export interface AccessControlDetection {
  result: AccessControlResult;
  unknowns: UnknownEntry[];
}

export async function detectAccessControl(
  chain: ChainReader,
  target: Hex,
): Promise<AccessControlDetection> {
  const unknowns: UnknownEntry[] = [];

  const defaultAdminRoleCall = encodeFunctionData({ abi: accessControlAbi, functionName: "DEFAULT_ADMIN_ROLE" });
  const { result: defaultAdminRoleRaw, reverted: notAccessControl } = await chain.call(
    target,
    defaultAdminRoleCall,
  );
  if (notAccessControl || !defaultAdminRoleRaw) {
    return { result: { detected: false, method: "not_applicable", roles: [], reconstruction: null }, unknowns };
  }

  const defaultAdminRole = decodeFunctionResult({
    abi: accessControlAbi,
    functionName: "DEFAULT_ADMIN_ROLE",
    data: defaultAdminRoleRaw,
  }) as Hex;

  const memberCountCall = encodeFunctionData({
    abi: accessControlAbi,
    functionName: "getRoleMemberCount",
    args: [defaultAdminRole],
  });
  const { reverted: notEnumerable } = await chain.call(target, memberCountCall);
  const isEnumerable = !notEnumerable;

  const { deploymentBlock } = await findDeploymentBlock(chain, target);
  if (deploymentBlock === null) {
    unknowns.push({
      field: "authority.accessControl.roles",
      reason: "could not determine contract deployment block to bound the RoleGranted/RoleRevoked event scan",
    });
    return { result: { detected: true, method: "not_applicable", roles: [], reconstruction: null }, unknowns };
  }

  const scan = await scanRoleEvents(chain, target, deploymentBlock);

  const roleHashes = new Set<Hex>([defaultAdminRole, ...scan.roleHashes]);

  const roles: RoleEntry[] = [];
  if (isEnumerable) {
    for (const role of roleHashes) {
      roles.push(await readRoleViaEnumerable(chain, target, role, unknowns));
    }
  } else {
    for (const role of roleHashes) {
      roles.push(await readRoleViaReplay(chain, target, role, scan.logs, scan.evidence));
    }
  }

  // Reconstruction confidence: Enumerable membership is authoritative even when
  // the event scan (which only discovers WHICH role hashes exist) was partial,
  // so a partial scan lowers an Enumerable contract to `medium` (a role never
  // touched in the covered window could be missed) but a non-Enumerable one to
  // `low` (both the role set and its membership come from the partial window).
  const reconstruction: RoleReconstruction = scan.complete
    ? {
        complete: true,
        confidence: "high",
        note: isEnumerable
          ? "role membership read from AccessControlEnumerable getters (authoritative); full role-hash discovery scan completed"
          : "role membership reconstructed from a complete RoleGranted/RoleRevoked replay over the full deployment-to-pinned range",
        maxLogRange: scan.maxLogRange?.toString() ?? null,
        scannedFromBlock: scan.scannedFrom.toString(),
        scannedToBlock: scan.scannedTo.toString(),
      }
    : {
        complete: false,
        confidence: isEnumerable ? "medium" : "low",
        note: isEnumerable
          ? `Enumerable membership below is authoritative, but role-hash DISCOVERY was partial: the provider's eth_getLogs range (${scan.maxLogRange} blocks) and the ${MAX_LOG_REQUESTS}-request budget covered only blocks ${scan.scannedFrom}–${scan.scannedTo} of ${deploymentBlock}–${chain.blockNumber}; a role never granted/revoked within that window would be missed`
          : `partial event-reconstruction: the provider's eth_getLogs range (${scan.maxLogRange} blocks) and the ${MAX_LOG_REQUESTS}-request budget covered only blocks ${scan.scannedFrom}–${scan.scannedTo} of ${deploymentBlock}–${chain.blockNumber}; both the role set and its membership below may be incomplete`,
        maxLogRange: scan.maxLogRange?.toString() ?? null,
        scannedFromBlock: scan.scannedFrom.toString(),
        scannedToBlock: scan.scannedTo.toString(),
      };
  if (!scan.complete) {
    unknowns.push({ field: "authority.accessControl.roles", reason: reconstruction.note });
  }

  return {
    result: {
      detected: true,
      method: isEnumerable ? "enumerable" : "event_reconstruction",
      roles,
      reconstruction,
    },
    unknowns,
  };
}

interface RoleScan {
  logs: RoleEventLog[];
  roleHashes: Set<Hex>;
  evidence: Evidence[];
  complete: boolean;
  maxLogRange: bigint | null;
  scannedFrom: bigint;
  scannedTo: bigint;
}

/**
 * Scans RoleGranted/RoleRevoked over [deployment, pinned], chunked to the
 * provider's PROBED eth_getLogs range (not a fixed guess — the day-2 KNOWN
 * EDGE #7 fix). If covering the full range would exceed MAX_LOG_REQUESTS, it
 * scans the most recent `budget` chunks instead and reports `complete: false`
 * with the exact window covered — a labelled partial, never a silent
 * truncation and never a failure that reads as "no roles."
 */
async function scanRoleEvents(chain: ChainReader, target: Hex, deploymentBlock: bigint): Promise<RoleScan> {
  const toBlock = chain.blockNumber;
  const maxLogRange = await probeMaxLogRange(chain); // may throw ChainReadError → build.ts errors[] (fail loud)
  const chunkSpan = maxLogRange < 1n ? 1n : maxLogRange;

  const fullRange = toBlock - deploymentBlock;
  const chunksForFull = fullRange / chunkSpan + 1n;
  // Two events per chunk (RoleGranted + RoleRevoked).
  const requestsForFull = chunksForFull * 2n;

  let scanFrom = deploymentBlock;
  let complete = true;
  if (requestsForFull > BigInt(MAX_LOG_REQUESTS)) {
    complete = false;
    const affordableChunks = BigInt(Math.floor(MAX_LOG_REQUESTS / 2));
    const coveredSpan = affordableChunks * chunkSpan;
    scanFrom = toBlock > coveredSpan ? toBlock - coveredSpan : 0n;
  }

  const evidence: Evidence[] = [];
  const logs: RoleEventLog[] = [];
  const roleHashes = new Set<Hex>();

  for (let start = scanFrom; start <= toBlock; start += chunkSpan) {
    const end = start + chunkSpan - 1n > toBlock ? toBlock : start + chunkSpan - 1n;
    for (const eventSig of [RELEVANT_EVENTS.roleGranted, RELEVANT_EVENTS.roleRevoked]) {
      const { logs: chunkLogs, evidence: chunkEvidence } = await chain.getLogs({
        address: target,
        event: eventSig,
        fromBlock: start,
        toBlock: end,
      });
      evidence.push(chunkEvidence);
      for (const log of chunkLogs as RoleEventLog[]) {
        logs.push(log);
        if (log.args.role) roleHashes.add(log.args.role);
      }
    }
  }

  logs.sort((a, b) => {
    const blockDiff = (a.blockNumber ?? 0n) - (b.blockNumber ?? 0n);
    if (blockDiff !== 0n) return blockDiff < 0n ? -1 : 1;
    return (a.logIndex ?? 0) - (b.logIndex ?? 0);
  });

  return { logs, roleHashes, evidence, complete, maxLogRange, scannedFrom: scanFrom, scannedTo: toBlock };
}

async function readRoleViaEnumerable(
  chain: ChainReader,
  target: Hex,
  role: Hex,
  unknowns: UnknownEntry[],
): Promise<RoleEntry> {
  const evidence: Evidence[] = [];

  const countCall = encodeFunctionData({ abi: accessControlAbi, functionName: "getRoleMemberCount", args: [role] });
  const { result: countRaw, reverted: countReverted, evidence: countEvidence } = await chain.call(target, countCall);
  evidence.push(countEvidence);

  const members: Hex[] = [];
  // A revert HERE is not the ordinary "this contract isn't Enumerable" case —
  // that was already settled, positively, by getRoleMemberCount succeeding on
  // DEFAULT_ADMIN_ROLE before this function was ever called. So a failure at
  // this point leaves the membership of THIS role unknown, and an empty
  // `members` array would read as "nobody holds it" — a role that vanishes
  // from the report is a route that vanishes from the exit window's minimum.
  // Recorded as an unknown so it reaches the report rather than the floor.
  if (countReverted || !countRaw) {
    unknowns.push({
      field: `authority.accessControl.roles[${role}].members`,
      reason:
        "getRoleMemberCount reverted for this role on a contract already established as AccessControlEnumerable — its membership is UNKNOWN, not empty",
    });
  }
  if (!countReverted && countRaw) {
    const count = decodeFunctionResult({ abi: accessControlAbi, functionName: "getRoleMemberCount", data: countRaw }) as bigint;
    for (let i = 0n; i < count; i++) {
      const memberCall = encodeFunctionData({ abi: accessControlAbi, functionName: "getRoleMember", args: [role, i] });
      const { result: memberRaw, reverted: memberReverted, evidence: memberEvidence } = await chain.call(target, memberCall);
      evidence.push(memberEvidence);
      if (memberReverted || !memberRaw) {
        unknowns.push({
          field: `authority.accessControl.roles[${role}].members[${i}]`,
          reason: "getRoleMember reverted mid-enumeration",
        });
        continue;
      }
      members.push(decodeFunctionResult({ abi: accessControlAbi, functionName: "getRoleMember", data: memberRaw }) as Hex);
    }
  }

  const adminRole = await readRoleAdmin(chain, target, role, evidence);

  return {
    role,
    name: KNOWN_ROLE_HASHES[role] ?? null,
    members,
    adminRole,
    evidence,
  };
}

async function readRoleViaReplay(
  chain: ChainReader,
  target: Hex,
  role: Hex,
  logs: RoleEventLog[],
  scanEvidence: Evidence[],
): Promise<RoleEntry> {
  const members = new Set<Hex>();
  for (const log of logs) {
    if (log.args.role !== role || !log.args.account) continue;
    if (log.eventName === "RoleGranted") members.add(log.args.account);
    else if (log.eventName === "RoleRevoked") members.delete(log.args.account);
  }

  const evidence: Evidence[] = [...scanEvidence];
  const adminRole = await readRoleAdmin(chain, target, role, evidence);

  return {
    role,
    name: KNOWN_ROLE_HASHES[role] ?? null,
    members: [...members],
    adminRole,
    evidence,
  };
}

async function readRoleAdmin(chain: ChainReader, target: Hex, role: Hex, evidence: Evidence[]): Promise<Hex | null> {
  const data = encodeFunctionData({ abi: accessControlAbi, functionName: "getRoleAdmin", args: [role] });
  const { result, reverted, evidence: callEvidence } = await chain.call(target, data);
  evidence.push(callEvidence);
  // `null` here means "this role's admin was not established", never "this role
  // has no admin". The day-4 rolePrivilege gate reads adminRole as one of three
  // ways a role can earn privilege, so a null costs the role that evidence and
  // pushes the route toward `unverified` — which blocks a `binding` window
  // rather than enabling one (KNOWN EDGE #18). The failure direction is
  // therefore conservative by construction, which is why this stays a plain
  // null rather than an unknowns[] entry on every non-AccessControl contract.
  if (reverted || !result) return null;
  return decodeFunctionResult({ abi: accessControlAbi, functionName: "getRoleAdmin", data: result }) as Hex;
}
