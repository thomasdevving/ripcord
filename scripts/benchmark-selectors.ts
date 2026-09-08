/** A small, repeatable CPU baseline for the selector-analysis boundary. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { Hex } from "viem";
import { extractDispatcherSelectors, selectorAnalyzer } from "../src/detect/dispatcher.js";

const valueAfter = (flag: string): string | null => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
};
const parseBoundedInt = (flag: string, fallback: number, maximum: number): number => {
  const raw = valueAfter(flag);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${flag} must be an integer between 1 and ${maximum}`);
  }
  return value;
};

const iterations = parseBoundedInt("--iterations", 100, 10_000);
const rounds = parseBoundedInt("--rounds", 7, 100);
const fixtureDirectory = join(process.cwd(), "test", "fixtures", "bytecode");
const fixtures = ["aave-pool-addresses-provider", "usdc-impl", "wbtc", "weth9"].map((name) => ({
  name,
  code: readFileSync(join(fixtureDirectory, `${name}.hex`), "utf8").trim() as Hex,
}));

for (const fixture of fixtures) {
  const result = extractDispatcherSelectors(fixture.code);
  if (!result.recognized) throw new Error(`${fixture.name}: ${result.reason}`);
}

// One unmeasured pass lets module setup and first-call allocation settle.
for (const fixture of fixtures) extractDispatcherSelectors(fixture.code);

const samples = [];
for (let round = 0; round < rounds; round++) {
  const started = performance.now();
  for (let iteration = 0; iteration < iterations; iteration++) {
    for (const fixture of fixtures) extractDispatcherSelectors(fixture.code);
  }
  samples.push(performance.now() - started);
}
samples.sort((a, b) => a - b);

const medianMs = samples[Math.floor(samples.length / 2)]!;
const operationsPerRound = iterations * fixtures.length;
const fixtureResults = fixtures.map((fixture) => {
  const result = extractDispatcherSelectors(fixture.code);
  if (!result.recognized) throw new Error(`${fixture.name}: ${result.reason}`);
  return {
    name: fixture.name,
    bytecodeBytes: (fixture.code.length - 2) / 2,
    selectors: result.selectors.length,
    abiSelectors: result.abiSelectorCount,
    fallbackSelectors: result.fallbackSelectorCount,
  };
});

console.log(JSON.stringify({
  format: "ripcord-selector-benchmark/v1",
  analyzer: selectorAnalyzer,
  node: process.version,
  rounds,
  iterations,
  operationsPerRound,
  medianMs: Number(medianMs.toFixed(3)),
  operationsPerSecond: Math.round(operationsPerRound / (medianMs / 1000)),
  fixtures: fixtureResults,
}, null, 2));
