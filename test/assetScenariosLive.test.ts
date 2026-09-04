/**
 * Optional real-bytecode integration for the experimental Compound III asset
 * pass. It is discovered by the normal suite but skipped unless explicitly
 * enabled, because it needs an archive RPC and starts a historical Anvil fork.
 *
 * Run with: pnpm test:live:assets
 */
import { createPublicClient, http, type Hex } from "viem";
import { mainnet } from "viem/chains";
import { expect, it } from "vitest";
import { erc20Abi } from "../src/chain/abi.js";
import { runAssetExitScenarios } from "../src/fork/assetScenarios.js";

const enabled = process.env.RIPCORD_RUN_LIVE_FORK_TESTS === "true";
if (enabled && !process.env.RPC_URL_1) {
  try { process.loadEnvFile(".env"); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
}

const RPC_URL = process.env.RPC_URL_1;
const BLOCK = 25_800_000n;
const TARGET = "0xc3d688B66703497DAA19211EEdff47f25384cdc3" as Hex;
const ASSETS = [
  // Base token, then three registered collateral assets. The base row proves
  // linkage to the primary report; the remaining rows exercise real setup,
  // baseline withdrawal and an isolated guardian mutation per candidate.
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
  "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",
  "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
] as const satisfies readonly Hex[];

it.skipIf(!enabled)("runs a real multi-asset Compound III pause differential", async () => {
  if (!RPC_URL) throw new Error("RIPCORD_RUN_LIVE_FORK_TESTS=true requires RPC_URL_1 in the environment or .env");
  const client = createPublicClient({ chain: mainnet, transport: http(RPC_URL) });

  let blockHash: Hex;
  let assets: { address: Hex; balanceRaw: string }[];
  try {
    const block = await client.getBlock({ blockNumber: BLOCK });
    if (!block.hash) throw new Error("archive provider returned no block hash");
    blockHash = block.hash;
    assets = await Promise.all(ASSETS.map(async (address) => ({
      address,
      balanceRaw: String(await client.readContract({
        address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [TARGET],
        blockNumber: BLOCK,
      })),
    })));
  } catch {
    // Do not let viem's provider error (which embeds the full URL/API key) reach
    // test output or a screen-shared terminal.
    throw new Error("The archive-RPC preflight for the live asset test failed (provider details redacted).");
  }

  expect(assets.every((asset) => BigInt(asset.balanceRaw) > 0n)).toBe(true);
  const result = await runAssetExitScenarios({
    chainId: 1,
    rpcUrl: RPC_URL,
    blockNumber: BLOCK,
    expectedBlockHash: blockHash,
    target: TARGET,
    assets,
    deadlineAt: Date.now() + 8 * 60_000,
  });

  expect(result.scenarios).toHaveLength(ASSETS.length);
  expect(result.scenarios[0]).toMatchObject({ address: ASSETS[0].toLowerCase(), state: "covered_by_primary_report" });
  expect(result.scenarios.slice(1).every((scenario) => scenario.assetRole === "collateral")).toBe(true);
  expect(result.evaluated).toBeGreaterThanOrEqual(2);
  expect(result.restrictorsConfirmed).toBe(result.evaluated);
  expect(result.notes.join(" ")).toMatch(/own pre-candidate fork snapshot/i);
  for (const scenario of result.scenarios.slice(1).filter((item) => item.state === "restrictor_confirmed")) {
    expect(scenario.evidence.some((entry) => entry.params.method === "anvil_setStorageAt")).toBe(true);
    expect(scenario.caveats.join(" ")).toMatch(/without taking assets from the analysed contract/i);
  }
}, 10 * 60_000);
