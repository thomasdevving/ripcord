/**
 * Small, dependency-free bytecode helpers shared by detectors. Deliberately
 * not a full disassembler — just enough to (a) match the EIP-1167 clone
 * pattern precisely and (b) check for a DELEGATECALL opcode without being
 * fooled by PUSH immediate data that happens to contain the same byte.
 */
import { zeroAddress, type Hex } from "viem";

export function isZeroValue(hex: Hex): boolean {
  return /^0x0*$/.test(hex);
}

export function slotToAddress(slot: Hex): Hex {
  // Storage slot value is a left-padded 32-byte word; the address is the low 20 bytes.
  const stripped = slot.slice(2).padStart(64, "0");
  return `0x${stripped.slice(24)}` as Hex;
}

/**
 * Matches runtime bytecode against the EIP-1167 minimal proxy pattern and
 * its common single-immediate variant, extracting the embedded target
 * address. Returns null if the code does not match either shape.
 *
 *   Standard: 363d3d373d3d3d363d73<20-byte addr>5af43d82803e903d91602b57fd5bf3
 *   Vanity/CWIA variants sometimes pad differently after the suffix; we only
 *   assert the fixed prefix+suffix around the address, ignoring trailing
 *   bytes, since some clone factories append extra calldata-forwarding logic.
 */
export function matchEip1167Clone(code: Hex): Hex | null {
  const body = code.slice(2).toLowerCase();
  const prefix = "363d3d373d3d3d363d73";
  const suffix = "5af43d82803e903d91602b57fd5bf3";
  if (!body.startsWith(prefix)) return null;
  const afterPrefix = body.slice(prefix.length);
  const address = afterPrefix.slice(0, 40);
  if (address.length !== 40) return null;
  const rest = afterPrefix.slice(40);
  if (!rest.startsWith(suffix)) return null;
  return `0x${address}` as Hex;
}

/**
 * Walks EVM bytecode from offset 0, respecting PUSH1..PUSH32 (0x60-0x7f)
 * immediate-data lengths, and reports whether a given opcode byte appears
 * as a real instruction (not inside push data). Not a full CFG analysis —
 * bytecode reached only via a jump table it can't statically resolve is
 * still walked linearly, which is the standard limitation of this technique.
 */
export function containsOpcode(code: Hex, opcode: number): boolean {
  const bytes = hexToBytes(code);
  let i = 0;
  while (i < bytes.length) {
    const op = bytes[i]!;
    if (op === opcode) return true;
    if (op >= 0x60 && op <= 0x7f) {
      const pushLen = op - 0x5f;
      i += 1 + pushLen;
    } else {
      i += 1;
    }
  }
  return false;
}

function hexToBytes(hex: Hex): Uint8Array {
  const clean = hex.slice(2);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export const DELEGATECALL_OPCODE = 0xf4;
export { zeroAddress };
