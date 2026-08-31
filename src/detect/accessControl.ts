/**
 * OpenZeppelin AccessControl detection.
 *
 * Detection: DEFAULT_ADMIN_ROLE() succeeding is treated as evidence the
 * contract implements AccessControl (it is universal across all versions,
 * including non-Enumerable ones).
 *
 * Method selection: getRoleMemberCount(DEFAULT_ADMIN_ROLE) is an
 * Enumerable-only extension. If it succeeds, the contract is
 * AccessControlEnumerable and we discover the full set of roles ever
 * touched via a RoleGranted/RoleRevoked event scan (just to learn *which*
 * role hashes exist — event scanning can't miss a role, since every role
 * must have been granted at least once for membership to be non-empty),
 * then read *current* membership straight from the Enumerable getters,
 * which is authoritative and doesn't require replaying history by hand.
 *
 * If Enumerable is absent, current membership is reconstructed by replaying
 * RoleGranted/RoleRevoked in order from the contract's deployment block to
 * the pinned block.
 *
 * The log range [deploymentBlock, pinnedBlock] is chunked so a large range
 * cannot blow up the RPC in one request. If the range is large enough that
 * chunking it would take an impractical number of requests, the scan is
 * abandoned and recorded as an explicit `unknowns[]` entry — never silently
 * truncated, which would look like "no roles found."
 */
import { decodeFunctionResult, encodeFunctionData, type Hex } from "viem";
import type { Evidence, ChainReader } from "../chain/client.js";
import { accessControlAbi } from "../chain/abi.js";
import { KNOWN_ROLE_HASHES, RELEVANT_EVENTS } from "../chain/constants.js";
import { findDeploymentBlock } from "./deployment.js";
import type { AccessControlResult, RoleEntry, UnknownEntry } from "../report/schema.js";

const LOG_CHUNK_SIZE = 10_000n;
const MAX_CHUNKS = 500;

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
    return { result: { detected: false, method: "not_applicable", roles: [] }, unknowns };
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
    return { result: { detected: true, method: "not_applicable", roles: [] }, unknowns };
  }

  const scan = await scanRoleEvents(chain, target, deploymentBlock, unknowns);
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

  return {
    result: {
      detected: true,
      method: isEnumerable ? "enumerable" : "event_reconstruction",
      roles,
    },
    unknowns,
  };
}

async function scanRoleEvents(
  chain: ChainReader,
  target: Hex,
  fromBlock: bigint,
  unknowns: UnknownEntry[],
): Promise<{ logs: RoleEventLog[]; roleHashes: Set<Hex>; evidence: Evidence[] }> {
  const toBlock = chain.blockNumber;
  const totalRange = toBlock - fromBlock;
  const chunkCount = totalRange / LOG_CHUNK_SIZE + 1n;

  if (chunkCount > BigInt(MAX_CHUNKS)) {
    unknowns.push({
      field: "authority.accessControl.roles",
      reason: `RoleGranted/RoleRevoked scan range (${totalRange} blocks, ~${chunkCount} chunks at ${LOG_CHUNK_SIZE}-block chunks) exceeds the ${MAX_CHUNKS}-chunk day-1 budget; role membership below may be incomplete or based on the Enumerable getters only`,
    });
    return { logs: [], roleHashes: new Set(), evidence: [] };
  }

  const evidence: Evidence[] = [];
  const logs: RoleEventLog[] = [];
  const roleHashes = new Set<Hex>();

  for (let start = fromBlock; start <= toBlock; start += LOG_CHUNK_SIZE) {
    const end = start + LOG_CHUNK_SIZE - 1n > toBlock ? toBlock : start + LOG_CHUNK_SIZE - 1n;
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

  return { logs, roleHashes, evidence };
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
  if (reverted || !result) return null;
  return decodeFunctionResult({ abi: accessControlAbi, functionName: "getRoleAdmin", data: result }) as Hex;
}
