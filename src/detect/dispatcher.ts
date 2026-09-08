/**
 * Function-selector extraction from deployed EVM runtime bytecode.
 *
 * This module deliberately owns only Ripcord's fail-closed result contract.
 * EVM disassembly, control-flow recovery and calldata-flow analysis belong to
 * EVMole: keeping those compiler-sensitive concerns in a maintained static
 * analyser avoids growing another collection of local opcode-window rules.
 */
import { contractInfo } from "evmole";
import type { Hex } from "viem";

/**
 * Part of the report's reproducibility contract. Keep this equal to the exact
 * package.json dependency; test/dispatcher.test.ts fails if the two drift.
 */
export const selectorAnalyzer = {
  name: "evmole",
  version: "0.9.3",
} as const;

export interface DispatcherRecognized {
  recognized: true;
  /** All externally dispatched 4-byte selectors, normalized and sorted. */
  selectors: Hex[];
  /** Normal Solidity/Vyper ABI dispatcher entries reported by EVMole. */
  abiSelectorCount: number;
  /** Selectors routed through fallback dispatch logic reported by EVMole. */
  fallbackSelectorCount: number;
  analyzer: typeof selectorAnalyzer.name;
  analyzerVersion: typeof selectorAnalyzer.version;
}

export interface DispatcherUnrecognized {
  recognized: false;
  reason: string;
}

export type DispatcherResult = DispatcherRecognized | DispatcherUnrecognized;

/**
 * Extracts the externally dispatched selector set from runtime bytecode.
 *
 * An empty result is deliberately not interpreted as proof that a contract has
 * no callable selector surface: it may instead be a dispatcher shape the
 * analyser could not recover. Callers therefore retain their existing
 * `recognized: false` / inconclusive path.
 */
export function extractDispatcherSelectors(code: Hex): DispatcherResult {
  if (code === "0x") {
    return { recognized: false, reason: "no bytecode" };
  }

  try {
    const functions = contractInfo(code, { selectors: true }).functions ?? [];
    if (functions.length === 0) {
      return {
        recognized: false,
        reason: "EVMole recovered no ABI or fallback-dispatched function selectors from the runtime bytecode",
      };
    }

    const malformed = functions.find((fn) => !/^[0-9a-fA-F]{8}$/.test(fn.selector));
    if (malformed) {
      return {
        recognized: false,
        reason: `EVMole returned a malformed function selector: ${malformed.selector}`,
      };
    }

    const selectors = new Set<Hex>();
    let abiSelectorCount = 0;
    let fallbackSelectorCount = 0;

    for (const fn of functions) {
      selectors.add(`0x${fn.selector.toLowerCase()}` as Hex);
      if (fn.dispatch === "abi") abiSelectorCount++;
      else fallbackSelectorCount++;
    }

    return {
      recognized: true,
      selectors: [...selectors].sort(),
      abiSelectorCount,
      fallbackSelectorCount,
      analyzer: selectorAnalyzer.name,
      analyzerVersion: selectorAnalyzer.version,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { recognized: false, reason: `EVMole analysis failed: ${detail}` };
  }
}
