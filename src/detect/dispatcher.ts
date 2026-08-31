/**
 * Dispatcher-based selector extraction.
 *
 * Day 1's `containsOpcode` (bytecode.ts) walks bytecode linearly from offset
 * 0 to the end, respecting PUSH-immediate lengths, but with no notion of
 * reachability: it happily "executes" bytes that the contract itself would
 * never reach — most importantly, a CODECOPY'd child contract's creation
 * bytecode embedded inline by `new Foo(...)`. That child blob is itself
 * valid EVM bytecode (it's a real contract's real init code), so a naive
 * linear walk decodes it "successfully" and, if the child has its own
 * selector dispatcher, extracts the CHILD's selectors as if they belonged to
 * the parent. That is a phantom capability — the single worst class of false
 * positive for this tool.
 *
 * The fix here is a minimal static reachability walk, not a full CFG/data-
 * flow analysis: starting at offset 0, follow only JUMP/JUMPI targets that
 * are (a) pushed onto the stack by a literal PUSH immediately beforehand and
 * (b) land on a real JUMPDEST. Any block ends at the first terminator
 * (STOP/RETURN/REVERT/INVALID/SELFDESTRUCT) it hits, with no fallthrough
 * past it. A CODECOPY'd data blob is never the target of a real jump and
 * always sits past a terminator in program order, so it is structurally
 * unreachable from this walk and never gets decoded as if it were code.
 * This under-approximates reachability (a dynamic jump table is not
 * followed) but Solidity's own selector dispatcher — the thing we actually
 * need to read — always uses static PUSH-immediate jump targets, so nothing
 * real is lost for this specific purpose. "Narrow and working beats broad
 * and flaky."
 *
 * Selector collection: within reachable blocks, any `PUSH4 <value> EQ
 * PUSHn <dest> JUMPI` window is a real selector comparison — the value is
 * recorded as a selector. `GT`/`LT` in the same window shape is a binary-
 * search pivot boundary, not necessarily a real function's selector (it may
 * just be the midpoint the compiler chose to split the search space); it is
 * counted but never added to the selector set. This is safe because solc's
 * binary-search dispatch always terminates each leaf with a direct EQ check
 * against the real selector — pivots are redundant with, not a substitute
 * for, the EQ leaves. Verified empirically against a real many-function
 * binary-search contract in dispatcher.test.ts.
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
      //   old (a):     PUSHn[2^224] [SWAP1] DIV        (divisor pushed AFTER calldataload)
      //   old (b):     DIV [AND 0xffffffff]            (divisor already on the stack from
      //                                                  BEFORE calldataload — real shape seen
      //                                                  in WBTC's 2019-era bytecode: PUSH4
      //                                                  0xffffffff PUSH29 2^224 PUSH1 0x00
      //                                                  CALLDATALOAD DIV AND). DIV landing
      //                                                  immediately after CALLDATALOAD is on
      //                                                  its own a strong enough signal — a
      //                                                  false positive here would require an
      //                                                  unrelated DIV coincidentally placed
      //                                                  right after loading calldata, which
      //                                                  real Solidity codegen doesn't produce.
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
