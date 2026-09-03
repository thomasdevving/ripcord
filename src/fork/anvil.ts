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
  /** Sends a transaction from an (impersonated) account and retains the receipt facts needed for fork evidence. */
  sendFrom(from: Hex, tx: { to?: Hex; data?: Hex; value?: bigint; gas?: bigint }): Promise<ForkTransactionResult>;
  /** Take a fork state snapshot (evm_snapshot). Returns the snapshot id. */
  snapshot(): Promise<Hex>;
  /** Restore the fork to a previous snapshot (evm_revert). The differential engine reverts BETWEEN candidates so each is isolated. */
  revert(id: Hex): Promise<void>;
  stop(): Promise<void>;
}

export interface ForkTransactionResult {
  hash: Hex;
  status: "success" | "reverted";
  blockNumber: bigint;
  blockHash: Hex;
  transactionIndex: number;
  gasUsed: bigint;
  blockTimestamp: bigint;
  baseFeePerGas: bigint | null;
  effectiveGasPrice: bigint;
  /** Raw revert payload recovered by replaying a reverted transaction as eth_call in the same fork state. */
  revertData: Hex | null;
}

function findRevertData(err: unknown, depth = 0): Hex | null {
  if (!err || depth > 8 || typeof err !== "object") return null;
  const value = err as Record<string, unknown>;
  if (typeof value.data === "string" && /^0x[0-9a-fA-F]*$/.test(value.data)) return value.data as Hex;
  for (const key of ["data", "cause", "error"]) {
    const nested = findRevertData(value[key], depth + 1);
    if (nested) return nested;
  }
  return null;
}

/** Deterministic-ish port in the ephemeral range, derived from pid+block so parallel runs don't collide. */
function pickPort(seed: bigint): number {
  return 8600 + Number((seed + BigInt(process.pid)) % 300n);
}

export interface StartForkOptions {
  rpcUrl: string;
  blockNumber: bigint;
  /** Executable resolved by the preflight (PATH or Foundry's default install directory). */
  anvilExecutable?: string;
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
    opts.anvilExecutable ?? "anvil",
    [
      "--fork-url",
      opts.rpcUrl,
      "--fork-block-number",
      opts.blockNumber.toString(),
      "--port",
      String(port),
      // All actors are explicitly funded and impersonated. Avoid unrelated
      // archive lookups for Anvil's default ten development accounts.
      "--accounts", "0",
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

  // The clock is part of a snapshot. Both counterfactual branches must mine at
  // the same timestamps; monotonicity applies within a branch, not across a
  // revert. Anvil otherwise derives block timestamps from wall-clock time.
  const forkHead = await client.getBlock({ blockNumber: opts.blockNumber });
  let nextBlockTimestamp = forkHead.timestamp;
  const snapshotClocks = new Map<Hex, bigint>();
  const gasPrice = (forkHead.baseFeePerGas ?? 0n) * 2n + 1_000_000_000n;

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
    // Anvil's automatic fee suggestion can retain history across evm_revert.
    // Fixed fees keep otherwise identical transactions reproducible as well.
    params.gasPrice = `0x${gasPrice.toString(16)}`;
    // The snapshot restores this counter together with the EVM state.
    nextBlockTimestamp += 1n;
    await client.setNextBlockTimestamp({ timestamp: nextBlockTimestamp });
    // Anvil also retains the next base fee across evm_revert. Freeze this
    // simulation input so the control and mutation run under the same fees.
    await client.setNextBlockBaseFeePerGas({ baseFeePerGas: forkHead.baseFeePerGas ?? 0n });
    const hash = (await client.request({
      method: "eth_sendTransaction" as never,
      params: [params] as never,
    })) as Hex;
    const receipt = await client.waitForTransactionReceipt({ hash });
    const receiptBlock = await client.getBlock({ blockNumber: receipt.blockNumber });
    let revertData: Hex | null = null;
    if (receipt.status === "reverted") {
      try {
        await client.request({
          method: "eth_call" as never,
          params: [params, "latest"] as never,
        });
      } catch (err) {
        // Store only the node's raw revert bytes. Persisting a provider error
        // message could accidentally copy an RPC URL (and its API key) into a
        // report, whereas the payload is deterministic and safe to publish.
        revertData = findRevertData(err);
      }
    }
    return {
      hash,
      status: receipt.status,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      transactionIndex: receipt.transactionIndex,
      gasUsed: receipt.gasUsed,
      blockTimestamp: receiptBlock.timestamp,
      baseFeePerGas: receiptBlock.baseFeePerGas,
      effectiveGasPrice: receipt.effectiveGasPrice,
      revertData,
    };
  };

  const snapshot: ForkHandle["snapshot"] = async () => {
    const id = (await client.request({ method: "evm_snapshot" as never, params: [] as never })) as Hex;
    snapshotClocks.set(id, nextBlockTimestamp);
    return id;
  };

  const revert: ForkHandle["revert"] = async (id) => {
    // anvil returns true on success; a false here means the id was already
    // consumed, which is a bug in the caller's snapshot discipline — fail loud.
    const clock = snapshotClocks.get(id);
    if (clock === undefined) throw new Error(`evm_revert(${id}): no matching clock snapshot`);
    const ok = (await client.request({ method: "evm_revert" as never, params: [id] as never })) as boolean;
    if (!ok) throw new Error(`evm_revert(${id}) returned false — snapshot already consumed or invalid`);
    nextBlockTimestamp = clock;
    // evm_revert also invalidates snapshots taken after this one.
    let discard = false;
    for (const key of snapshotClocks.keys()) {
      if (key === id) discard = true;
      if (discard) snapshotClocks.delete(key);
    }
  };

  return { client, rpcUrl, port, sendFrom, snapshot, revert, stop };
}
