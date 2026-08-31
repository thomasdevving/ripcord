/**
 * Guard attribution by probing, not by static analysis. We do not look for
 * hasRole/onlyOwner byte patterns near a function's jump destination — that
 * approach looks clever and produces silent wrong answers, since a modifier
 * check can be arranged in bytecode in more shapes than are worth
 * enumerating, and getting it wrong there fails silently (a false "no
 * guard" or a false attribution) rather than loud.
 *
 * Instead we ask the contract: perform a real `eth_call` at the pinned
 * block, `from` a probe address with no relationship to the protocol, with
 * zero-valued arguments for the capability's known signature, and read the
 * revert:
 *   - OZ v4 AccessControl: Error(string) "AccessControl: account 0x... is
 *     missing role 0x..." — the role hash is parsed out of the message.
 *   - OZ v5 AccessControl: custom error
 *     AccessControlUnauthorizedAccount(address,bytes32) — role is the 2nd arg.
 *   - OZ v4 Ownable: Error(string) "Ownable: caller is not the owner".
 *   - OZ v5 Ownable: custom error OwnableUnauthorizedAccount(address).
 * All four selectors are derived from their signatures via viem (see
 * `test/guardProbe.test.ts`), never hardcoded from memory — same discipline
 * day 1 applied to storage slots.
 *
 * This is a plain historical read pinned to the report's block, not a fork
 * simulation, so it goes through PinnedChain's ordinary disk cache exactly
 * like every other read in this codebase (see ChainReader.probeCall).
 *
 * Every capability is probed from (at least) three deterministic, unrelated
 * addresses (derived by hashing a fixed label — never random, to preserve
 * reproducibility). A recognized auth-shaped revert from any one probe is
 * sufficient evidence of a guard; the three-probe protocol exists for the
 * opposite case — concluding "no auth-shaped revert was observed" — which
 * is never reported as "unguarded" (a vulnerability claim), only as an
 * observation routed to manual verification.
 */
import {
  decodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbiItem,
  toBytes,
  toFunctionSelector,
  zeroAddress,
  type Hex,
} from "viem";
import type { ChainReader, Evidence } from "../chain/client.js";
import { slotToAddress } from "./bytecode.js";
import type { RoleEntry } from "../report/schema.js";

/** Same math as a function selector (keccak256(signature)[0:4]) — Solidity doesn't distinguish error/function selector derivation. */
const errorSelector = toFunctionSelector;

export const ERROR_STRING_SELECTOR = toFunctionSelector("Error(string)"); // 0x08c379a0, standard Solidity revert-reason encoding
export const OWNABLE_UNAUTHORIZED_SELECTOR = errorSelector("OwnableUnauthorizedAccount(address)");
export const ACCESS_CONTROL_UNAUTHORIZED_SELECTOR = errorSelector("AccessControlUnauthorizedAccount(address,bytes32)");

const OWNABLE_V4_MESSAGE = "Ownable: caller is not the owner";
const ACCESS_CONTROL_V4_PATTERN = /^AccessControl: account 0x[0-9a-fA-F]{40} is missing role (0x[0-9a-fA-F]{64})$/;

/** Deterministic, protocol-unrelated probe addresses — never random, so a scan stays reproducible. */
export const PROBE_ADDRESSES: readonly Hex[] = [0, 1, 2].map(
  (i) => slotToAddress(keccak256(toBytes(`ripcord.probe.${i}`))),
);

export type AuthShape =
  | { kind: "ownable" }
  | { kind: "accessControlRole"; role: Hex }
  | null;

/** Parses one probe's revert bytes for a recognized OZ Ownable/AccessControl auth shape. Returns null if unparseable or not auth-shaped. */
export function parseAuthShape(revertData: Hex | undefined): AuthShape {
  if (!revertData || revertData.length < 10) return null;
  const selector = revertData.slice(0, 10).toLowerCase();

  if (selector === ERROR_STRING_SELECTOR.toLowerCase()) {
    try {
      const [message] = decodeAbiParameters([{ type: "string" }], `0x${revertData.slice(10)}` as Hex);
      if (message === OWNABLE_V4_MESSAGE) return { kind: "ownable" };
      const match = ACCESS_CONTROL_V4_PATTERN.exec(message as string);
      if (match) return { kind: "accessControlRole", role: match[1] as Hex };
    } catch {
      return null;
    }
    return null;
  }

  if (selector === OWNABLE_UNAUTHORIZED_SELECTOR.toLowerCase()) {
    return { kind: "ownable" };
  }

  if (selector === ACCESS_CONTROL_UNAUTHORIZED_SELECTOR.toLowerCase()) {
    try {
      const [, role] = decodeAbiParameters([{ type: "address" }, { type: "bytes32" }], `0x${revertData.slice(10)}` as Hex);
      return { kind: "accessControlRole", role: role as Hex };
    } catch {
      return null;
    }
  }

  return null;
}

/** Builds zero-valued calldata for a known full signature (address/uintN/bool/string/bytes/bytesN — the only types the taxonomy uses). */
export function zeroCalldataForSignature(signature: string): Hex {
  const item = parseAbiItem(`function ${signature}`);
  if (item.type !== "function") throw new Error(`not a function signature: ${signature}`);
  const args = item.inputs.map((input) => zeroValueForType(input.type));
  return encodeFunctionData({ abi: [item], args }) as Hex;
}

function zeroValueForType(type: string): unknown {
  if (type === "address") return zeroAddress;
  if (type === "bool") return false;
  if (type === "string") return "";
  if (type === "bytes") return "0x";
  if (/^bytes\d+$/.test(type)) return ("0x" + "00".repeat(Number(type.slice(5)))) as Hex;
  if (/^u?int\d*$/.test(type)) return 0n;
  throw new Error(`zeroCalldataForSignature: unsupported type "${type}" — taxonomy should only use address/bool/string/bytes/bytesN/uintN/intN`);
}

export interface GuardProbeContext {
  authorityOwner: Hex | null;
  accessControlRoles: RoleEntry[];
}

export type GuardProbeResult =
  | { status: "attributed"; holders: Hex[]; authSource: "owner" | "accessControlRole"; role: Hex | null; evidence: Evidence[] }
  | { status: "guarded_unknown_holder"; note: string; evidence: Evidence[] }
  | { status: "inconclusive"; note: string; evidence: Evidence[] }
  | { status: "no_auth_revert_observed"; note: string; evidence: Evidence[] };

export async function probeGuard(
  chain: ChainReader,
  scannedAddress: Hex,
  signature: string,
  context: GuardProbeContext,
): Promise<GuardProbeResult> {
  let calldata: Hex;
  try {
    calldata = zeroCalldataForSignature(signature);
  } catch (err) {
    return {
      status: "inconclusive",
      note: `could not construct a probe call: ${err instanceof Error ? err.message : String(err)}`,
      evidence: [],
    };
  }

  const evidence: Evidence[] = [];
  const interpretable: { shape: AuthShape }[] = [];

  for (const probeAddress of PROBE_ADDRESSES) {
    const { revertData, reverted, evidence: probeEvidence } = await chain.probeCall(scannedAddress, calldata, probeAddress);
    evidence.push(probeEvidence);
    if (!reverted) {
      interpretable.push({ shape: null }); // a clean, non-reverting call is itself interpretable — see NO_AUTH_REVERT_OBSERVED below
      continue;
    }
    if (revertData === undefined) continue; // provider gave us nothing to interpret at all — not counted either way
    const shape = parseAuthShape(revertData);
    interpretable.push({ shape });
    if (shape) break; // one recognized auth-shaped revert is sufficient evidence
  }

  const authHit = interpretable.find((r) => r.shape !== null);
  if (authHit?.shape) {
    if (authHit.shape.kind === "ownable") {
      if (context.authorityOwner) {
        return {
          status: "attributed",
          holders: [context.authorityOwner],
          authSource: "owner",
          role: null,
          evidence,
        };
      }
      return {
        status: "guarded_unknown_holder",
        note: "Ownable-shaped auth revert observed on probe, but day-1 owner() detection found no owner — likely a custom Ownable variant not exposing the standard owner() selector",
        evidence,
      };
    }
    // accessControlRole
    const role = authHit.shape.role;
    const roleEntry = context.accessControlRoles.find((r) => r.role.toLowerCase() === role.toLowerCase());
    if (roleEntry && roleEntry.members.length > 0) {
      return {
        status: "attributed",
        holders: roleEntry.members as Hex[],
        authSource: "accessControlRole",
        role,
        evidence,
      };
    }
    return {
      status: "guarded_unknown_holder",
      note: `AccessControl-shaped auth revert observed for role ${role}, but that role was not found (or has no members) in Ripcord's day-1 role reconstruction`,
      evidence,
    };
  }

  if (interpretable.length === 0) {
    return {
      status: "inconclusive",
      note: "no probe returned an interpretable result — the RPC provider did not return revert data on any of the probes",
      evidence,
    };
  }

  return {
    status: "no_auth_revert_observed",
    note: "probed from three unrelated addresses with zero-valued arguments and observed no AccessControl/Ownable-shaped auth revert from any of them — this does not prove the function is unguarded (it may use a custom scheme, or revert for an unrelated reason before reaching an auth check), but it could not be attributed to a known guard either; manual review required",
    evidence,
  };
}
