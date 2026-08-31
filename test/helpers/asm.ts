/**
 * Minimal two-pass EVM "assembler" for hand-building precise dispatcher
 * bytecode fixtures in tests. Label-referencing pushes are always emitted as
 * PUSH2 (a fixed 2-byte width, exactly what real Solidity dispatchers use
 * for jump destinations), so a single forward pass can record label offsets
 * while emitting placeholder bytes, and a second pass patches them in —
 * no fixed-point iteration needed since instruction lengths never change
 * between passes.
 */
import type { Hex } from "viem";

type Op =
  | { kind: "raw"; bytes: number[] }
  | { kind: "push"; value: bigint; size: number }
  | { kind: "pushLabel"; label: string }
  | { kind: "label"; name: string };

export class Asm {
  private ops: Op[] = [];

  raw(...bytes: number[]): this {
    this.ops.push({ kind: "raw", bytes });
    return this;
  }
  push(size: number, value: bigint | number): this {
    this.ops.push({ kind: "push", value: BigInt(value), size });
    return this;
  }
  pushLabel(label: string): this {
    this.ops.push({ kind: "pushLabel", label });
    return this;
  }
  /** Emits a JUMPDEST and records this position under `name`. */
  label(name: string): this {
    this.ops.push({ kind: "label", name });
    return this;
  }

  stop(): this { return this.raw(0x00); }
  calldataload(): this { return this.raw(0x35); }
  calldatasize(): this { return this.raw(0x36); }
  iszero(): this { return this.raw(0x15); }
  div(): this { return this.raw(0x04); }
  lt(): this { return this.raw(0x10); }
  gt(): this { return this.raw(0x11); }
  eq(): this { return this.raw(0x14); }
  shr(): this { return this.raw(0x1c); }
  jump(): this { return this.raw(0x56); }
  jumpi(): this { return this.raw(0x57); }
  dup1(): this { return this.raw(0x80); }
  swap1(): this { return this.raw(0x90); }
  return_(): this { return this.raw(0xf3); }
  revert_(): this { return this.raw(0xfd); }
  push1(v: bigint | number): this { return this.push(1, v); }
  push4(v: bigint | number): this { return this.push(4, v); }
  push29(v: bigint | number): this { return this.push(29, v); }
  push2Label(label: string): this { return this.pushLabel(label); }

  assemble(): Hex {
    const lengths = this.ops.map((op) => {
      if (op.kind === "raw") return op.bytes.length;
      if (op.kind === "push") return 1 + op.size;
      if (op.kind === "pushLabel") return 1 + 2; // always PUSH2
      return 1; // label -> JUMPDEST byte
    });

    const offsets: number[] = [];
    let running = 0;
    for (const len of lengths) {
      offsets.push(running);
      running += len;
    }

    const labelOffsets = new Map<string, number>();
    this.ops.forEach((op, i) => {
      if (op.kind === "label") labelOffsets.set(op.name, offsets[i]!);
    });

    const bytes: number[] = [];
    this.ops.forEach((op) => {
      if (op.kind === "raw") {
        bytes.push(...op.bytes);
      } else if (op.kind === "push") {
        bytes.push(0x5f + op.size);
        const hex = op.value.toString(16).padStart(op.size * 2, "0");
        for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
      } else if (op.kind === "pushLabel") {
        const target = labelOffsets.get(op.label);
        if (target === undefined) throw new Error(`unresolved label ${op.label}`);
        bytes.push(0x61); // PUSH2
        bytes.push((target >> 8) & 0xff, target & 0xff);
      } else {
        bytes.push(0x5b); // JUMPDEST
      }
    });

    return ("0x" + bytes.map((b) => b.toString(16).padStart(2, "0")).join("")) as Hex;
  }
}
