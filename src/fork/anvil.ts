/**
 * Spins up an ephemeral anvil mainnet fork pinned to a block and drives it
 * from TypeScript via viem — no forge scripts, no Solidity, no Hardhat. This
 * is the sandbox the proof engine executes in: every simulated transaction
 * happens here and nowhere else. No mainnet transaction is ever sent, no key
 * is ever held.
 *
 * The lifecycle is deliberately explicit (spawn → use → stop) with a hard
 * timeout on readiness and a guaranteed kill on stop, because we are about to
 * execute adversarial-shaped bytecode inside it and a leaked process or a
 * hung fork is exactly the kind of thing that makes a demo look unserious.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createTestClient, http, publicActions, walletActions, type Hex, type TestClient } from "viem";
import { mainnet } from "viem/chains";

export interface ForkHandle {
  client: TestClient & ReturnType<typeof publicActions> & ReturnType<typeof walletActions>;
  rpcUrl: string;
  port: number;
  /** Sends a transaction from an (impersonated) account via eth_sendTransaction and waits for the receipt. */
  sendFrom(from: Hex, tx: { to?: Hex; data?: Hex; value?: bigint; gas?: bigint }): Promise<{ hash: Hex; status: "success" | "reverted" }>;
  /** Take a fork state snapshot (evm_snapshot). Returns the snapshot id. */
  snapshot(): Promise<Hex>;
  /** Restore the fork to a previous snapshot (evm_revert). The differential engine reverts BETWEEN candidates so each is isolated. */
  revert(id: Hex): Promise<void>;
  stop(): Promise<void>;
}

/** Deterministic-ish port in the ephemeral range, derived from pid+block so parallel runs don't collide. */
function pickPort(seed: bigint): number {
  return 8600 + Number((seed + BigInt(process.pid)) % 300n);
}

export interface StartForkOptions {
  rpcUrl: string;
  blockNumber: bigint;
  /** Readiness timeout, ms. */
  timeoutMs?: number;
  /** Cap per-tx gas so a pathological simulated call can't run unbounded. */
  port?: number;
}

export async function startAnvilFork(opts: StartForkOptions): Promise<ForkHandle> {
  const port = opts.port ?? pickPort(opts.blockNumber);
  const rpcUrl = `http://127.0.0.1:${port}`;
  const timeoutMs = opts.timeoutMs ?? 60_000;

  const proc: ChildProcess = spawn(
    "anvil",
    [
      "--fork-url",
      opts.rpcUrl,
      "--fork-block-number",
      opts.blockNumber.toString(),
      "--port",
      String(port),
      "--silent",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  let stderr = "";
  proc.stderr?.on("data", (d) => (stderr += String(d)));
  let exited = false;
  proc.on("exit", () => (exited = true));

  const client = createTestClient({
    mode: "anvil",
    chain: mainnet,
    transport: http(rpcUrl),
  })
    .extend(publicActions)
    .extend(walletActions);

  // Poll until the fork answers, or fail loud with anvil's stderr.
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (exited) {
      throw new Error(`anvil exited before becoming ready. stderr:\n${stderr}`);
    }
    try {
      const bn = await client.getBlockNumber();
      if (bn >= opts.blockNumber) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      proc.kill("SIGKILL");
      throw new Error(`anvil did not become ready within ${timeoutMs}ms. stderr:\n${stderr}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  const stop = async (): Promise<void> => {
    if (exited) return;
    await new Promise<void>((resolve) => {
      proc.once("exit", () => resolve());
      proc.kill("SIGTERM");
      // Hard backstop: if SIGTERM is ignored, SIGKILL shortly after.
      setTimeout(() => {
        if (!exited) proc.kill("SIGKILL");
        resolve();
      }, 2000);
    });
  };

  const sendFrom: ForkHandle["sendFrom"] = async (from, tx) => {
    const params: Record<string, string> = { from };
    if (tx.to) params.to = tx.to;
    if (tx.data) params.data = tx.data;
    if (tx.value !== undefined) params.value = `0x${tx.value.toString(16)}`;
    // Always cap gas: we are executing adversarial-shaped logic.
    params.gas = `0x${(tx.gas ?? 3_000_000n).toString(16)}`;
    const hash = (await client.request({
      method: "eth_sendTransaction" as never,
      params: [params] as never,
    })) as Hex;
    const receipt = await client.waitForTransactionReceipt({ hash });
    return { hash, status: receipt.status };
  };

  const snapshot: ForkHandle["snapshot"] = async () => {
    return (await client.request({ method: "evm_snapshot" as never, params: [] as never })) as Hex;
  };

  const revert: ForkHandle["revert"] = async (id) => {
    // anvil returns true on success; a false here means the id was already
    // consumed, which is a bug in the caller's snapshot discipline — fail loud.
    const ok = (await client.request({ method: "evm_revert" as never, params: [id] as never })) as boolean;
    if (!ok) throw new Error(`evm_revert(${id}) returned false — snapshot already consumed or invalid`);
  };

  return { client, rpcUrl, port, sendFrom, snapshot, revert, stop };
}
