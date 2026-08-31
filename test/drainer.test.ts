import { describe, expect, it } from "vitest";
import { toFunctionSelector, type Hex } from "viem";
import { drainerRuntime, drainerInitcode } from "../src/fork/drainer.js";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Hex;
const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7" as Hex;
const RECIP = "0x000000000000000000000000000000000000dEaD" as Hex;

const BALANCE_OF = toFunctionSelector("balanceOf(address)").slice(2); // 70a08231
const TRANSFER = toFunctionSelector("transfer(address,uint256)").slice(2); // a9059cbb

describe("drainer bytecode assembler", () => {
  it("embeds the balanceOf and transfer selectors, the token, and the recipient", () => {
    const rt = drainerRuntime([USDC], RECIP).toLowerCase();
    expect(rt).toContain(BALANCE_OF);
    expect(rt).toContain(TRANSFER);
    expect(rt).toContain(USDC.slice(2).toLowerCase());
    expect(rt).toContain(RECIP.slice(2).toLowerCase());
    expect(rt.endsWith("00")).toBe(true); // trailing STOP
  });

  it("emits one drain block per token (length scales linearly, plus the STOP)", () => {
    const one = (drainerRuntime([USDC], RECIP).length - 2) / 2;
    const two = (drainerRuntime([USDC, USDT], RECIP).length - 2) / 2;
    // Two identically-shaped blocks differ only by the token immediate, so the
    // two-token runtime is exactly one block longer than the one-token runtime.
    expect(two - one).toBe(one - 1); // -1 accounts for the single shared STOP
  });

  it("initcode is a constructor that returns exactly the runtime", () => {
    const runtime = drainerRuntime([USDC, USDT], RECIP).slice(2);
    const ic = drainerInitcode([USDC, USDT], RECIP).slice(2);
    const len = runtime.length / 2;
    const lenHex = len.toString(16).padStart(4, "0");
    // PUSH2 len; PUSH1 0x0e; PUSH1 0x00; CODECOPY; PUSH2 len; PUSH1 0x00; RETURN
    const expectedPrefix = `61${lenHex}600e6000396100${lenHex.slice(2)}6000f3`;
    // The prefix uses PUSH2 for both lengths; assert the runtime is appended verbatim.
    expect(ic.endsWith(runtime)).toBe(true);
    expect(ic.slice(0, ic.length - runtime.length)).toBe(expectedPrefix);
    // Prefix length is 14 bytes, matching the 0x0e CODECOPY offset.
    expect((ic.length - runtime.length) / 2).toBe(14);
  });

  it("rejects a malformed (non-20-byte) address rather than silently mis-assembling", () => {
    expect(() => drainerRuntime(["0x1234" as Hex], RECIP)).toThrow();
  });
});
