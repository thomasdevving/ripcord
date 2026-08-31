import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { containsOpcode, matchEip1167Clone, isZeroValue, slotToAddress, stripSolidityMetadata } from "../src/detect/bytecode.js";

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

describe("stripSolidityMetadata", () => {
  it("strips a well-formed trailing CBOR metadata blob", () => {
    // real code: PUSH1 0x00, STOP (3 bytes) + a 5-byte fake metadata blob + 2-byte length prefix (0x0005)
    const realCode = "600000";
    const metadata = "aabbccddee"; // 5 bytes, deliberately contains no push/delegatecall meaning
    const code = `0x${realCode}${metadata}0005` as Hex;
    expect(stripSolidityMetadata(code)).toBe(`0x${realCode}`);
  });

  it("is the regression case for WETH9-shaped bytecode: a DELEGATECALL byte inside the metadata trailer is not a false positive", () => {
    const realCode = "600000"; // no real DELEGATECALL in the executable part
    const metadataContainingF4Byte = "f4f4f4"; // 3 bytes of coincidental 0xf4 inside metadata
    const code = `0x${realCode}${metadataContainingF4Byte}0003` as Hex;
    expect(containsOpcode(code, 0xf4)).toBe(true); // unstripped: false positive, as seen with real WETH9 bytecode
    expect(containsOpcode(stripSolidityMetadata(code), 0xf4)).toBe(false); // stripped: correct
  });

  it("returns bytecode unchanged when there is no plausible metadata trailer (declared length exceeds the bytecode)", () => {
    const code = "0x6000ffff" as Hex; // last 2 bytes as a length would be 0xffff, far longer than the bytecode itself
    expect(stripSolidityMetadata(code)).toBe(code);
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
