#!/usr/bin/env node
/**
 * `pnpm ripcord scan <address> --block <n> --chain <id>`
 *
 * Prints a schema-valid JSON power-map report to stdout. Exits non-zero on
 * any usage error or fatal failure (bad RPC URL, unreachable target block).
 * Per-target detection failures are NOT fatal — they show up as `errors[]`
 * inside the report itself, per the "fail loud, not fail fatal" design.
 */
import { Command } from "commander";
import { isAddress, type Hex } from "viem";
import { resolve } from "node:path";
import { PinnedChain } from "./chain/client.js";
import { buildReport } from "./report/build.js";

// .env is optional (RPC URLs may already be set in the shell environment);
// its absence is not an error, but a malformed file should not be swallowed.
try {
  process.loadEnvFile(".env");
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
}

const program = new Command();

program.name("ripcord").description("Who holds privileged power over a contract, and how fast can they use it.");

program
  .command("scan")
  .description("Scan a contract address at a pinned block and print a power-map report as JSON")
  .argument("<address>", "contract address to scan")
  .requiredOption("--block <number>", "block number to pin the scan to")
  .option("--chain <id>", "chain ID", "1")
  .option("--no-cache", "disable the on-disk RPC cache")
  .option("--cache-dir <dir>", "cache directory", ".cache")
  .action(async (addressArg: string, opts) => {
    if (!isAddress(addressArg)) {
      console.error(`error: "${addressArg}" is not a valid address`);
      process.exitCode = 1;
      return;
    }

    const chainId = Number(opts.chain);
    if (!Number.isInteger(chainId) || chainId <= 0) {
      console.error(`error: --chain must be a positive integer, got "${opts.chain}"`);
      process.exitCode = 1;
      return;
    }

    let blockNumber: bigint;
    try {
      blockNumber = BigInt(opts.block);
    } catch {
      console.error(`error: --block must be an integer, got "${opts.block}"`);
      process.exitCode = 1;
      return;
    }
    if (blockNumber < 0n) {
      console.error(`error: --block must be non-negative, got "${opts.block}"`);
      process.exitCode = 1;
      return;
    }

    const rpcEnvVar = `RPC_URL_${chainId}`;
    const rpcUrl = process.env[rpcEnvVar];
    if (!rpcUrl) {
      console.error(
        `error: ${rpcEnvVar} is not set. Copy .env.example to .env and set a real RPC URL for chain ${chainId}.`,
      );
      process.exitCode = 1;
      return;
    }

    const chain = new PinnedChain({
      chainId,
      rpcUrl,
      blockNumber,
      cacheDir: resolve(opts.cacheDir),
      cacheEnabled: opts.cache !== false,
    });

    try {
      const report = await buildReport(chain, addressArg as Hex);
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    } catch (err) {
      console.error(`fatal: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv);
