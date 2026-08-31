import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { containsOpcode, matchEip1167Clone, isZeroValue, slotToAddress } from "../src/detect/bytecode.js";

describe("matchEip1167Clone", () => {
  it("matches a canonical EIP-1167 clone and extracts the target address", () => {
    const target = "beefbeefbeefbeefbeefbeefbeefbeefbeefbeef";
    const code = `0x363d3d373d3d3d363d73${target}5af43d82803e903d91602b57fd5bf3` as Hex;
    expect(matchEip1167Clone(code)).toBe(`0x${target}`);
  });

  it("returns null for non-clone bytecode", () => {
    const code = "0x608060405234801561001057600080fd5b50" as Hex;
    expect(matchEip1167Clone(code)).toBeNull();
  });

  it("returns null when the suffix does not match after a plausible prefix", () => {
    const target = "beefbeefbeefbeefbeefbeefbeefbeefbeefbeef";
    const code = `0x363d3d373d3d3d363d73${target}deadbeef` as Hex;
    expect(matchEip1167Clone(code)).toBeNull();
  });
});

describe("containsOpcode", () => {
  it("finds DELEGATECALL as a real instruction", () => {
    // PUSH1 0x00 (x4), DELEGATECALL
    const code = "0x6000600060006000f4" as Hex;
    expect(containsOpcode(code, 0xf4)).toBe(true);
  });

  it("does not false-positive on 0xf4 inside PUSH immediate data", () => {
    // PUSH1 0xf4 (the 0xf4 byte is data, not an opcode), then STOP
    const code = "0x60f400" as Hex;
    expect(containsOpcode(code, 0xf4)).toBe(false);
  });

  it("correctly skips a PUSH32 data blob containing the target byte", () => {
    const push32Data = "f4".repeat(32);
    const code = `0x7f${push32Data}00` as Hex; // PUSH32 <32 bytes of 0xf4>, STOP
    expect(containsOpcode(code, 0xf4)).toBe(false);
  });
});

describe("isZeroValue / slotToAddress", () => {
  it("recognises an all-zero 32-byte slot as zero", () => {
    expect(isZeroValue(`0x${"0".repeat(64)}` as Hex)).toBe(true);
  });

  it("recognises a populated slot as non-zero", () => {
    expect(isZeroValue(`0x${"0".repeat(63)}1` as Hex)).toBe(false);
  });

  it("extracts the low 20 bytes of a storage slot as an address", () => {
    const addr = "beefbeefbeefbeefbeefbeefbeefbeefbeefbeef";
    const slot = `0x${"0".repeat(24)}${addr}` as Hex;
    expect(slotToAddress(slot)).toBe(`0x${addr}`);
  });
});
