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
import { describeProvider } from "./chain/rpcPreflight.js";
import { buildReport } from "./report/build.js";
import { reportSchema, type Report } from "./report/schema.js";
import { runProofEngine } from "./fork/proofEngine.js";

// .env is optional (RPC URLs may already be set in the shell environment);
// its absence is not an error, but a malformed file should not be swallowed.
try {
  process.loadEnvFile(".env");
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
}

const program = new Command();

program.name("ripcord").description("Who holds privileged power over a contract, and how fast can they use it.");

interface CommonArgs {
  chainId: number;
  blockNumber: bigint;
  rpcUrl: string;
}

/** Validates the shared address/block/chain/RPC args. Returns null (and sets a non-zero exit code) on any usage error. */
function resolveCommon(addressArg: string, opts: { chain: string; block: string }): CommonArgs | null {
  if (!isAddress(addressArg)) {
    console.error(`error: "${addressArg}" is not a valid address`);
    process.exitCode = 1;
    return null;
  }
  const chainId = Number(opts.chain);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    console.error(`error: --chain must be a positive integer, got "${opts.chain}"`);
    process.exitCode = 1;
    return null;
  }
  let blockNumber: bigint;
  try {
    blockNumber = BigInt(opts.block);
  } catch {
    console.error(`error: --block must be an integer, got "${opts.block}"`);
    process.exitCode = 1;
    return null;
  }
  if (blockNumber < 0n) {
    console.error(`error: --block must be non-negative, got "${opts.block}"`);
    process.exitCode = 1;
    return null;
  }
  const rpcEnvVar = `RPC_URL_${chainId}`;
  const rpcUrl = process.env[rpcEnvVar];
  if (!rpcUrl) {
    console.error(
      `error: ${rpcEnvVar} is not set. Copy .env.example to .env and set a real RPC URL for chain ${chainId}.`,
    );
    process.exitCode = 1;
    return null;
  }
  return { chainId, blockNumber, rpcUrl };
}

program
  .command("scan")
  .description("Scan a contract address at a pinned block and print a power-map report as JSON")
  .argument("<address>", "contract address to scan")
  .requiredOption("--block <number>", "block number to pin the scan to")
  .option("--chain <id>", "chain ID", "1")
  .option("--no-cache", "disable the on-disk RPC cache")
  .option("--cache-dir <dir>", "cache directory", ".cache")
  .action(async (addressArg: string, opts) => {
    const common = resolveCommon(addressArg, opts);
    if (!common) return;
    const { chainId, blockNumber, rpcUrl } = common;

    const chain = new PinnedChain({
      chainId,
      rpcUrl,
      blockNumber,
      cacheDir: resolve(opts.cacheDir),
      cacheEnabled: opts.cache !== false,
    });

    const provider = describeProvider(rpcUrl);
    console.error(`provider: ${provider.name} (${provider.host}), chain ${chainId}, block ${blockNumber}`);

    try {
      const report = await buildReport(chain, addressArg as Hex);
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      printVerdict(report);
      // The disclosure gate goes to stderr, not stdout: stdout stays clean,
      // pipeable JSON, while a human running this interactively cannot miss
      // that the report must not be published as-is. Silence here would make
      // the gate easy to walk past on calibration day, which is exactly when
      // it matters.
      if (!report.disclosure.publishable) {
        console.error("\n⚠  DO NOT PUBLISH THIS REPORT");
        console.error(`   ${report.disclosure.reason}`);
        for (const b of report.disclosure.blockedBy) {
          console.error(`   - ${b.signature} (${b.category}) in ${b.location}`);
        }
      }
    } catch (err) {
      console.error(`fatal: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

program
  .command("prove")
  .description(
    "Build the power map, then FORK-SIMULATE the resolved upgrade authority draining the target's holdings (CODE_CHANGE→drain archetype). Sandbox only — no mainnet tx is ever sent.",
  )
  .argument("<address>", "proxy contract address to prove against")
  .requiredOption("--block <number>", "block number to pin the scan and fork to")
  .option("--chain <id>", "chain ID", "1")
  .option("--no-cache", "disable the on-disk RPC cache")
  .option("--cache-dir <dir>", "cache directory", ".cache")
  .option("--artifact-dir <dir>", "where to write proof trace/reproduce artifacts", ".ripcord/proofs")
  .action(async (addressArg: string, opts) => {
    const common = resolveCommon(addressArg, opts);
    if (!common) return;
    const { chainId, blockNumber, rpcUrl } = common;

    const chain = new PinnedChain({
      chainId,
      rpcUrl,
      blockNumber,
      cacheDir: resolve(opts.cacheDir),
      cacheEnabled: opts.cache !== false,
    });

    const provider = describeProvider(rpcUrl);
    console.error(`provider: ${provider.name} (${provider.host}), chain ${chainId}, block ${blockNumber}`);

    try {
      const baseReport = await buildReport(chain, addressArg as Hex);
      const proof = await runProofEngine({
        chainId,
        rpcUrl,
        blockNumber,
        target: addressArg as Hex,
        proxy: baseReport.proxy,
        authorityResolution: baseReport.authorityResolution,
        exitWindow: baseReport.exitWindow,
        artifactDir: resolve(opts.artifactDir),
      });

      // Re-validate: attaching the proof must still produce a schema-valid report.
      const report = reportSchema.parse({ ...baseReport, proof });
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      printVerdict(report);

      // Human-facing summary on stderr (stdout stays clean JSON).
      if (proof.produced) {
        console.error("\n✓ PROOF PRODUCED (sandbox fork — no mainnet tx sent)");
        console.error(`   ${proof.headline}`);
        console.error(`   impersonated: ${proof.impersonatedVia}`);
        console.error(`   notice:       ${proof.noticeSeconds === null ? "not established" : proof.noticeSeconds + "s"} — ${proof.noticeNote}`);
        for (const d of proof.deltas) {
          const usd = d.usd === null ? "USD undetermined" : `$${d.usd.toFixed(2)}`;
          console.error(`   - ${d.symbol}: moved ${d.delta} (${usd}) via ${d.priceSource}`);
        }
        if (proof.traceArtifact) console.error(`   trace: ${proof.traceArtifact}`);
        if (proof.reproduceCommand) console.error(`   reproduce: ${proof.reproduceCommand}`);
      } else {
        console.error("\n○ PROOF NOT PRODUCED (this is honest, not a failure of the target)");
        console.error(`   ${proof.failureReason}`);
      }

      if (!report.disclosure.publishable) {
        console.error("\n⚠  DO NOT PUBLISH THIS REPORT");
        console.error(`   ${report.disclosure.reason}`);
        for (const b of report.disclosure.blockedBy) {
          console.error(`   - ${b.signature} (${b.category}) in ${b.location}`);
        }
      }
    } catch (err) {
      console.error(`fatal: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });


/**
 * The day-4 headline, on stderr so stdout stays clean pipeable JSON.
 *
 * Prints the verdict, both sides, and — always — what is MISSING when the
 * verdict degrades. A reader skimming the terminal must not be able to see a
 * confident-looking status without also seeing the gaps behind it, which is
 * why `missing` and the unmeasured legs are printed at the same level as the
 * headline rather than left in the JSON.
 */
function printVerdict(report: Report): void {
  const v = report.verdict;
  if (!v) return;
  const mark =
    v.status === "trapped" || v.status === "no_notice"
      ? "\u2716"
      : v.status === "can_exit_in_time" || v.status === "no_rule_change_route_found"
        ? "\u2713"
        : "\u25cb";
  console.error(`\n${mark} EXIT WINDOW VERDICT: ${v.status.toUpperCase().replace(/_/g, " ")} (confidence: ${v.confidence})`);
  console.error(`   ${v.statement}`);
  const ew = report.exitWindow;
  if (ew) {
    console.error(`   exit window   : ${ew.assessment.status}${v.exitWindowSeconds ? ` (${v.exitWindowSeconds}s)` : ""}`);
    for (const route of ew.routes) {
      console.error(
        `     - ${route.label} → ${route.effectiveControllerType ?? "unresolved"} ${route.effectiveController ?? ""}: ${route.noticeStatus}${
          route.noticeSeconds !== null ? ` (${route.noticeSeconds}s)` : route.nominalDelaySeconds !== null ? ` (nominal ${route.nominalDelaySeconds}s, NOT proven binding)` : ""
        }`,
      );
    }
    for (const bypass of ew.bypasses) console.error(`     ! bypass: ${bypass.kind} on ${bypass.route ?? "protocol"}`);
    if (ew.bypasses.length === 0 && ew.routes.length > 0) {
      console.error(
        `     (no bypasses found; ${ew.checksPerformed.filter((c) => c.performed).length}/${ew.checksPerformed.length} checks were performed — see exitWindow.checksPerformed for what was NOT checked)`,
      );
    }
  }
  const tte = report.timeToExit;
  if (tte) {
    console.error(`   time to exit  : ${tte.status}${tte.atLeastSeconds !== null ? ` (${tte.tight ? "" : "at least "}${tte.atLeastSeconds}s)` : ""}`);
    for (const leg of tte.legs) {
      console.error(`     - ${leg.kind}: ${leg.name} = ${leg.seconds === null ? "UNKNOWN duration" : `${leg.seconds}s`}${leg.mutableBy ? ` [settable via ${leg.mutableBy}]` : ""}`);
    }
    if (tte.blockable.status !== "not_observed") console.error(`     ! exit blockability: ${tte.blockable.status}`);
    console.error(`     - liquidity depth: NOT MODELLED (see timeToExit.liquidity.reason)`);
  }
  if (v.missing.length > 0) {
    console.error(`   MISSING (why this verdict is not crisper):`);
    for (const m of v.missing) console.error(`     - ${m}`);
  }
}

program.parseAsync(process.argv);
