/**
 * Dispatcher-based selector extraction.
 *
 * A linear `containsOpcode`-style walk has no notion of reachability, so it
 * happily decodes a CODECOPY'd child contract's creation bytecode embedded by
 * `new Foo(...)` and extracts the CHILD's selectors as the parent's — a phantom
 * capability, the worst class of false positive for this tool.
 *
 * The fix is a minimal static reachability walk, not full CFG analysis: from
 * offset 0, follow only JUMP/JUMPI targets pushed by a literal PUSH immediately
 * beforehand that land on a real JUMPDEST, and end each block at its first
 * terminator with no fallthrough. A CODECOPY'd blob is never the target of a
 * real jump and always sits past a terminator, so it is structurally
 * unreachable. This under-approximates (a dynamic jump table is not followed),
 * but solc's own dispatcher always uses static targets.
 *
 * Selector collection: a `PUSH4 <value> EQ PUSHn <dest> JUMPI` window is a real
 * comparison and the value is recorded. GT/LT in the same shape is a
 * binary-search pivot — counted, never added to the selector set — because
 * solc's binary search always terminates each leaf in a direct EQ check.
 */
import type { Hex } from "viem";
import { stripSolidityMetadata } from "./bytecode.js";

const STOP = 0x00;
const CALLDATALOAD = 0x35;
const DIV = 0x04;
const LT = 0x10;
const GT = 0x11;
const EQ = 0x14;
const SHR = 0x1c;
const JUMP = 0x56;
const JUMPI = 0x57;
const JUMPDEST = 0x5b;
const SWAP1 = 0x90;
const RETURN = 0xf3;
const REVERT = 0xfd;
const INVALID = 0xfe;
const SELFDESTRUCT = 0xff;
const PUSH1 = 0x60;
const PUSH4 = 0x63;
const PUSH32 = 0x7f;

const TERMINATORS = new Set([STOP, RETURN, REVERT, INVALID, SELFDESTRUCT]);
const TWO_POW_224 = 1n << 224n;

interface DecodedInstr {
  offset: number;
  opcode: number;
  /** Only set for PUSH1..PUSH32. */
  pushValue?: bigint;
  pushHex?: string;
  len: number;
}

function isPush(opcode: number): boolean {
  return opcode >= PUSH1 && opcode <= PUSH32;
}

const DUP1_OPCODE = 0x80;
const DUP16_OPCODE = 0x8f;
function isDup(opcode: number): boolean {
  return opcode >= DUP1_OPCODE && opcode <= DUP16_OPCODE;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Decodes the entire byte range as if every byte were code, respecting
 * PUSH-immediate lengths. This is intentionally the same "trust everything
 * is code" decode day 1 used — the fix is not in decoding, it's in which
 * decoded offsets we later choose to trust as reachable (see walk()).
 */
function decodeAll(bytes: Uint8Array): Map<number, DecodedInstr> {
  const map = new Map<number, DecodedInstr>();
  let i = 0;
  while (i < bytes.length) {
    const opcode = bytes[i]!;
    if (isPush(opcode)) {
      const pushLen = opcode - 0x5f;
      let hex = "";
      for (let j = 0; j < pushLen; j++) {
        const b = bytes[i + 1 + j];
        hex += (b ?? 0).toString(16).padStart(2, "0");
      }
      map.set(i, { offset: i, opcode, pushValue: BigInt("0x" + (hex || "0")), pushHex: hex, len: 1 + pushLen });
      i += 1 + pushLen;
    } else {
      map.set(i, { offset: i, opcode, len: 1 });
      i += 1;
    }
  }
  return map;
}

export interface DispatcherRecognized {
  recognized: true;
  /** 0x-prefixed 4-byte selectors extracted from real EQ leaf comparisons. */
  selectors: Hex[];
  /** GT/LT binary-search pivot comparisons observed — counted, not treated as selectors. See file header. */
  pivotComparisonCount: number;
  blocksVisited: number;
}

export interface DispatcherUnrecognized {
  recognized: false;
  reason: string;
}

export type DispatcherResult = DispatcherRecognized | DispatcherUnrecognized;

/**
 * Extracts the function selector set from runtime bytecode via reachability-
 * limited dispatcher parsing. Returns `recognized: false` (never a guess) if
 * no CALLDATALOAD-based selector-load shape is found at all — e.g. Vyper,
 * hand-written assembly, or a proxy with no selector dispatch of its own.
 */
export function extractDispatcherSelectors(code: Hex): DispatcherResult {
  const stripped = stripSolidityMetadata(code);
  const bytes = hexToBytes(stripped);
  if (bytes.length === 0) {
    return { recognized: false, reason: "no bytecode" };
  }
  const instrs = decodeAll(bytes);

  const selectors = new Set<Hex>();
  let pivotComparisonCount = 0;
  let selectorLoadFound = false;
  const visited = new Set<number>();

  const queue: number[] = [0];
  while (queue.length > 0) {
    const start = queue.shift()!;
    if (visited.has(start)) continue;
    if (!instrs.has(start)) continue; // target doesn't land on a decoded instruction boundary — not a real jump target, skip
    if (start !== 0 && instrs.get(start)!.opcode !== JUMPDEST) continue; // real jumps always land on JUMPDEST

    let pc = start;
    const window: DecodedInstr[] = [];

    while (true) {
      const instr = instrs.get(pc);
      if (!instr || visited.has(pc)) break;
      visited.add(pc);
      window.push(instr);
      if (window.length > 6) window.shift();

      // Selector-load shape: CALLDATALOAD then one of —
      //   modern:      PUSH1 0xe0 SHR
      //   old (a):     PUSHn[2^224] [SWAP1] DIV   (divisor pushed AFTER calldataload)
      //   old (b):     DIV [AND 0xffffffff]       (divisor already on the stack,
      //                the real shape in WBTC's 2019-era bytecode). DIV landing
      //                immediately after CALLDATALOAD is a strong enough signal
      //                on its own — a false positive needs an unrelated DIV
      //                placed right after a calldata load, which real Solidity
      //                codegen does not produce.
      if (instr.opcode === CALLDATALOAD) {
        const next1 = instrs.get(pc + instr.len);
        const next2 = next1 ? instrs.get(pc + instr.len + next1.len) : undefined;
        const next3 = next2 ? instrs.get(pc + instr.len + next1!.len + next2.len) : undefined;
        if (next1 && next1.opcode === PUSH1 && next1.pushValue === 0xe0n && next2 && next2.opcode === SHR) {
          selectorLoadFound = true;
        } else if (next1 && isPush(next1.opcode) && next1.pushValue === TWO_POW_224) {
          if (next2 && next2.opcode === DIV) selectorLoadFound = true;
          else if (next2 && next2.opcode === SWAP1 && next3 && next3.opcode === DIV) selectorLoadFound = true;
        } else if (next1 && next1.opcode === DIV) {
          selectorLoadFound = true;
        }
      }

      // Dispatch comparison shape: PUSH4 <value> (EQ|GT|LT) PUSHn <dest> JUMPI.
      // The usual codegen dups the running selector value BEFORE pushing the
      // comparison constant (DUP1 PUSH4 <sel> EQ ...), which this 4-window
      // tail matches directly (the leading DUP isn't part of the window).
      // Some old-style solc dispatchers instead dup AFTER the push, only for
      // the very first comparison in the chain (PUSH4 <sel> DUP2 EQ ...) —
      // seen live in WBTC's 2019-era bytecode. Both are checked.
      let comparisonMatch: { pushVal: DecodedInstr; cmp: DecodedInstr } | null = null;
      if (window.length >= 4) {
        const [a, b, c, d] = window.slice(-4);
        if (a!.opcode === PUSH4 && (b!.opcode === EQ || b!.opcode === GT || b!.opcode === LT) && isPush(c!.opcode) && d!.opcode === JUMPI) {
          comparisonMatch = { pushVal: a!, cmp: b! };
        }
      }
      if (!comparisonMatch && window.length >= 5) {
        const [a, b, c, d, e] = window.slice(-5);
        if (
          a!.opcode === PUSH4 &&
          isDup(b!.opcode) &&
          (c!.opcode === EQ || c!.opcode === GT || c!.opcode === LT) &&
          isPush(d!.opcode) &&
          e!.opcode === JUMPI
        ) {
          comparisonMatch = { pushVal: a!, cmp: c! };
        }
      }
      if (comparisonMatch) {
        if (comparisonMatch.cmp.opcode === EQ) {
          const sel = ("0x" + (comparisonMatch.pushVal.pushHex ?? "0").padStart(8, "0")) as Hex;
          selectors.add(sel);
        } else {
          pivotComparisonCount++;
        }
      }

      if (TERMINATORS.has(instr.opcode)) {
        break;
      }

      if (instr.opcode === JUMP || instr.opcode === JUMPI) {
        const prev = window[window.length - 2];
        if (prev && isPush(prev.opcode) && prev.pushValue !== undefined) {
          queue.push(Number(prev.pushValue));
        }
        if (instr.opcode === JUMPI) {
          pc = pc + instr.len; // fallthrough branch of JUMPI continues in this block
          continue;
        }
        break; // unconditional JUMP: no fallthrough
      }

      pc = pc + instr.len;
    }
  }

  if (!selectorLoadFound) {
    return {
      recognized: false,
      reason:
        "no CALLDATALOAD-based selector-load shape (PUSH1 0xe0 SHR, or PUSHn[2^224] DIV) found in code reachable from offset 0 — not a recognised Solidity dispatcher (Vyper, hand-written assembly, or unusual compiler)",
    };
  }

  return {
    recognized: true,
    selectors: [...selectors].sort(),
    pivotComparisonCount,
    blocksVisited: visited.size,
  };
}
