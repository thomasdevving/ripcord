import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPublicClient, http, type Hex } from "viem";
import { expect, it } from "vitest";
import { startAnvilFork } from "../src/fork/anvil.js";

// Real EVM regression, no archive RPC or credentials needed. Explicitly skipped
// when Anvil is absent, rather than pretending to have exercised fork replay.
// Match the production preflight's lookup. On macOS Foundry commonly lives in
// ~/.foundry/bin without that directory being exported into a GUI-launched
// editor's PATH; checking only `anvil` made this real-EVM regression silently
// skip on the exact machine that could run the product fork.
const executable = [
  process.env.ANVIL_EXECUTABLE,
  "anvil",
  join(homedir(), ".foundry", "bin", "anvil"),
].filter((candidate): candidate is string => Boolean(candidate))
  .find((candidate) => spawnSync(candidate, ["--version"]).status === 0);
const available = executable !== undefined;
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  return port;
}

it.skipIf(!available)("restores the fork clock so identical branches produce identical real receipts", async () => {
  const port = await freePort();
  const upstream = spawn(executable!, ["--port", String(port), "--timestamp", "1700000000", "--silent"], { stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  const client = createPublicClient({ transport: http(url, { retryCount: 0, timeout: 1000 }) });
  try {
    const deadline = Date.now() + 10000;
    for (;;) {
      try { await client.getBlockNumber(); break; }
      catch (err) { if (Date.now() > deadline) throw err; await new Promise((r) => setTimeout(r, 100)); }
    }
    const fork = await startAnvilFork({ rpcUrl: url, blockNumber: 0n, port: await freePort(), anvilExecutable: executable!, timeoutMs: 10000 });
    try {
      const account: Hex = "0x000000000000000000000000000000000000abc1";
      await fork.client.setBalance({ address: account, value: 10n ** 18n });
      await fork.client.impersonateAccount({ address: account });
      const snap = await fork.snapshot();
      const tx = { to: "0x000000000000000000000000000000000000abc2" as Hex, gas: 21000n };
      const first = await fork.sendFrom(account, tx);
      const firstBlock = await fork.client.getBlock();
      const firstTime = firstBlock.timestamp;
      const invalidatedChild = await fork.snapshot();
      await fork.revert(snap);
      await expect(fork.revert(invalidatedChild)).rejects.toThrow("no matching clock snapshot");
      const second = await fork.sendFrom(account, tx);
      expect(second).toEqual(first);
      expect((await fork.client.getBlock()).timestamp).toBe(firstTime);
    } finally { await fork.stop(); }
  } finally {
    upstream.kill("SIGTERM");
    await new Promise<void>((resolve) => { if (upstream.exitCode !== null) resolve(); else upstream.once("exit", () => resolve()); });
  }
}, 30000);
