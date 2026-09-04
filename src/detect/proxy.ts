/**
 * Proxy pattern detection. Reads the EIP-1967 implementation/admin/beacon slots,
 * the EIP-1822 PROXIABLE slot and the legacy zos slots, and matches runtime
 * bytecode against the EIP-1167 minimal-proxy shape. For a beacon proxy,
 * resolves one hop through the beacon's `implementation()`.
 *
 * Classification order matters and is deliberate:
 *   1. No code at all           -> not_a_proxy (nothing to be a proxy of)
 *   2. EIP-1167 clone match     -> eip1167_minimal_proxy (the bytecode IS the proof)
 *   3. EIP-1967 beacon slot set -> eip1967_beacon
 *   4. EIP-1967 admin slot set  -> eip1967_transparent
 *   5. EIP-1967 impl slot set   -> eip1967_uups
 *   6. legacy zos slots set     -> legacy_zos_unstructured
 *   7. DELEGATECALL present but nothing above matched -> unknown
 *   8. otherwise                -> not_a_proxy
 */
import { decodeFunctionResult, encodeFunctionData, type Hex } from "viem";
import type { ChainReader, Evidence } from "../chain/client.js";
import { SLOTS } from "../chain/constants.js";
import { beaconAbi } from "../chain/abi.js";
import {
  containsOpcode,
  DELEGATECALL_OPCODE,
  isZeroValue,
  matchEip1167Clone,
  slotToAddress,
  stripSolidityMetadata,
} from "./bytecode.js";
import type { ProxyResult } from "../report/schema.js";

export async function detectProxy(chain: ChainReader, target: Hex): Promise<ProxyResult> {
  const evidence: Evidence[] = [];
  const { code, evidence: codeEvidence } = await chain.getCode(target);
  evidence.push(codeEvidence);

  const empty: ProxyResult = {
    pattern: "not_a_proxy",
    isProxy: false,
    implementation: null,
    beacon: null,
    admin: null,
    slots: {},
    evidence,
  };

  if (!code) {
    return empty;
  }

  // 1. EIP-1167 minimal proxy: the bytecode itself encodes the target, no storage read needed.
  const cloneTarget = matchEip1167Clone(code);
  if (cloneTarget) {
    return {
      pattern: "eip1167_minimal_proxy",
      isProxy: true,
      implementation: cloneTarget,
      beacon: null,
      admin: null,
      slots: {},
      evidence,
    };
  }

  // 2. Read all EIP-1967 + EIP-1822 + legacy slots up front.
  const [implRead, adminRead, beaconRead, proxiableRead, legacyImplRead, legacyAdminRead] =
    await Promise.all([
      chain.getStorageAt(target, SLOTS.eip1967Implementation),
      chain.getStorageAt(target, SLOTS.eip1967Admin),
      chain.getStorageAt(target, SLOTS.eip1967Beacon),
      chain.getStorageAt(target, SLOTS.eip1822Proxiable),
      chain.getStorageAt(target, SLOTS.legacyZosImplementation),
      chain.getStorageAt(target, SLOTS.legacyZosAdmin),
    ]);
  evidence.push(
    implRead.evidence,
    adminRead.evidence,
    beaconRead.evidence,
    proxiableRead.evidence,
    legacyImplRead.evidence,
    legacyAdminRead.evidence,
  );

  const slots: Record<string, Hex | null> = {
    eip1967Implementation: implRead.value,
    eip1967Admin: adminRead.value,
    eip1967Beacon: beaconRead.value,
    eip1822Proxiable: proxiableRead.value,
    legacyZosImplementation: legacyImplRead.value,
    legacyZosAdmin: legacyAdminRead.value,
  };

  const beaconSet = !isZeroValue(beaconRead.value);
  const implSet = !isZeroValue(implRead.value);
  const adminSet = !isZeroValue(adminRead.value);
  const legacyImplSet = !isZeroValue(legacyImplRead.value);

  // 3. Beacon proxy: resolve one hop through the beacon contract.
  if (beaconSet) {
    const beaconAddress = slotToAddress(beaconRead.value);
    const data = encodeFunctionData({ abi: beaconAbi, functionName: "implementation" });
    const { result, reverted, evidence: callEvidence } = await chain.call(beaconAddress, data);
    evidence.push(callEvidence);
    let implementation: Hex | null = null;
    if (!reverted && result) {
      try {
        implementation = decodeFunctionResult({ abi: beaconAbi, functionName: "implementation", data: result }) as Hex;
      } catch {
        // `implementation: null` on a CONFIRMED beacon proxy is not read as
        // "no implementation": the pattern stays `eip1967_beacon` with
        // `isProxy: true`, and capabilities.ts turns exactly that combination
        // into an explicit unknowns[] entry ("confirmed proxy, implementation
        // unresolved — capability detection skipped") rather than an empty
        // capability set. The proxy-ness, which is what drives the exit
        // window, is established by the storage slot and is unaffected.
        implementation = null;
      }
    }
    return {
      pattern: "eip1967_beacon",
      isProxy: true,
      implementation,
      beacon: beaconAddress,
      admin: null,
      slots,
      evidence,
    };
  }

  // 4. Transparent proxy: both implementation and admin slots populated.
  if (implSet && adminSet) {
    return {
      pattern: "eip1967_transparent",
      isProxy: true,
      implementation: slotToAddress(implRead.value),
      beacon: null,
      admin: slotToAddress(adminRead.value),
      slots,
      evidence,
    };
  }

  // 5. UUPS: implementation slot populated, admin slot empty (admin lives in the implementation itself, not the proxy).
  if (implSet && !adminSet) {
    return {
      pattern: "eip1967_uups",
      isProxy: true,
      implementation: slotToAddress(implRead.value),
      beacon: null,
      admin: null,
      slots,
      evidence,
    };
  }

  // 6. Legacy zeppelinos unstructured storage proxy.
  if (legacyImplSet) {
    const legacyAdminSet = !isZeroValue(legacyAdminRead.value);
    return {
      pattern: "legacy_zos_unstructured",
      isProxy: true,
      implementation: slotToAddress(legacyImplRead.value),
      beacon: null,
      admin: legacyAdminSet ? slotToAddress(legacyAdminRead.value) : null,
      slots,
      evidence,
    };
  }

  // 7. None of the known slot patterns matched, but the bytecode contains a real
  // DELEGATECALL instruction — this looks proxy-shaped but we can't identify the pattern.
  if (containsOpcode(stripSolidityMetadata(code), DELEGATECALL_OPCODE)) {
    return {
      pattern: "unknown",
      isProxy: true,
      implementation: null,
      beacon: null,
      admin: null,
      slots,
      evidence,
    };
  }

  // 8. No proxy signal at all.
  return {
    pattern: "not_a_proxy",
    isProxy: false,
    implementation: null,
    beacon: null,
    admin: null,
    slots,
    evidence,
  };
}
