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

/**
 * PORT OWNERSHIP, AND WHY ANVIL CHOOSES THE PORT.
 *
 * This used to be `8600 + (blockNumber + pid) % 300` — deterministic, and so
 * COLLIDING for two forks started from one process at the same pinned block.
 * The asset-context layer starts forks outside the job limiter, so that was an
 * ordinary event, and it did not fail loud: the second anvil fails to BIND while
 * the readiness loop polls the port and gets a healthy answer from the FIRST
 * anvil, whose fork block and expected hash are identical. The second engine
 * then drives the first engine's fork, interleaving transactions into someone
 * else's differential.
 *
 * An in-memory reservation set fixes only the one-process case; at least two
 * processes here spawn forks, and there is an unavoidable gap between "this port
 * looks free" and a child owning it. Passing port 0 delegates allocation to the
 * OS inside Anvil's own bind call, and we learn the port only from THIS child's
 * `Listening on 127.0.0.1:<port>` line — no probe/bind window, no cross-process
 * lock. An explicitly requested port follows the same rule: a foreign node
 * answering there is ignored unless our child announced that exact bind.
 *
 * Exact-head and pinned-hash checks remain STATE-identity checks. They no longer
 * double as a fallible substitute for process ownership.
 */
const LISTENING_LINE = /Listening on 127\.0\.0\.1:(\d{1,5})/;

/** Child output may contain the fork URL, which usually contains an API key. */
function safeChildOutput(value: string): string {
  return value
    .replace(/(?:https?|wss?):\/\/[^\s"']+/gi, "[url redacted]")
    .replace(/(api[_-]?key|token|authorization)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .slice(-8192);
}

export interface StartForkOptions {
  rpcUrl: string;
  blockNumber: bigint;
  expectedBlockHash?: Hex;
  /** Executable resolved by the preflight (PATH or Foundry's default install directory). */
  anvilExecutable?: string;
  /** Readiness timeout, ms. */
  timeoutMs?: number;
  /** Cap per-tx gas so a pathological simulated call can't run unbounded. */
  port?: number;
}

export async function startAnvilFork(opts: StartForkOptions): Promise<ForkHandle> {
  const requestedPort = opts.port ?? 0;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  // One deadline covers spawn, ownership handshake and RPC readiness. A slow
  // bind must not earn the process a fresh full timeout for the next phase.
  const deadline = Date.now() + timeoutMs;

  const proc: ChildProcess = spawn(
    opts.anvilExecutable ?? "anvil",
    [
      "--fork-url",
      opts.rpcUrl,
      "--fork-block-number",
      opts.blockNumber.toString(),
      "--host", "127.0.0.1",
      "--port",
      String(requestedPort),
      // All actors are explicitly funded and impersonated. Avoid unrelated
      // archive lookups for Anvil's default ten development accounts.
      "--accounts", "0",
    ],
    // stdout MUST be piped: its listening line is the ownership handshake.
    // Nothing else from stdout is retained or logged, because Anvil may print
    // upstream fork details. stderr is retained only after redaction.
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let stderr = "";
  proc.stderr?.on("data", (d) => (stderr = safeChildOutput(stderr + String(d))));
  let exited = false;
  let exitCode: number | null = null;
  proc.on("exit", () => (exited = true));
  proc.on("exit", (code) => { exitCode = code; });
  proc.on("error", () => { exited = true; stderr = "anvil process could not be spawned"; });

  const stop = async (): Promise<void> => {
    if (exited) return;
    await new Promise<void>((resolve) => {
      const backstop = setTimeout(() => { if (!exited) proc.kill("SIGKILL"); }, 2000);
      proc.once("exit", () => { clearTimeout(backstop); resolve(); });
      proc.kill("SIGTERM");
    });
  };

  let port: number;
  try {
    port = await new Promise<number>((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`anvil did not announce a listening port within ${timeoutMs}ms`));
      }, Math.max(1, deadline - Date.now()));
      const cleanup = () => {
        clearTimeout(timer);
        proc.stdout?.off("data", onData);
        proc.off("exit", onExit);
        proc.off("error", onError);
      };
      const onData = (data: Buffer | string) => {
        // Retain only enough text to bridge a chunk boundary. Never surface it.
        buffer = (buffer + String(data)).slice(-512);
        const match = LISTENING_LINE.exec(buffer);
        if (!match) return;
        const announced = Number(match[1]);
        cleanup();
        if (!Number.isInteger(announced) || announced < 1 || announced > 65535) {
          reject(new Error("anvil announced an invalid listening port"));
        } else if (requestedPort !== 0 && announced !== requestedPort) {
          reject(new Error(`anvil announced port ${announced}, not the explicitly requested port ${requestedPort}`));
        } else {
          resolve(announced);
        }
      };
      const onExit = (code: number | null) => {
        cleanup();
        reject(new Error(`anvil exited before announcing its listening port (exit ${code ?? "unknown"})`));
      };
      const onError = () => {
        cleanup();
        reject(new Error("anvil could not be spawned"));
      };
      proc.stdout?.on("data", onData);
      proc.once("exit", onExit);
      proc.once("error", onError);
    });
  } catch (err) {
    await stop();
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`${detail}. stderr:\n${stderr || `(child exit ${exitCode ?? "unknown"}; no stderr)`}`);
  }

  const rpcUrl = `http://127.0.0.1:${port}`;
  const client = createTestClient({
    mode: "anvil",
    chain: mainnet,
    transport: http(rpcUrl),
  })
    .extend(publicActions)
    .extend(walletActions);

  // Poll until the fork answers, or fail loud with anvil's stderr.
  for (;;) {
    if (exited) {
      throw new Error(`anvil on port ${port} exited before becoming ready. stderr:\n${stderr}`);
    }
    try {
      const bn = await client.getBlockNumber();
      // EXACTLY the fork block, never `>=`. Ownership is already established by
      // the child announcement; this separately proves its initial chain state.
      if (bn === opts.blockNumber) break;
      if (bn > opts.blockNumber) {
        await stop();
        throw new Error(
          `the spawned anvil on port ${port} answered at block ${bn}, past the requested fork block ${opts.blockNumber} — ` +
            "refusing to drive a fork with the wrong initial state",
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("refusing to drive a fork")) throw err;
      // not up yet
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`anvil on port ${port} did not become ready within ${timeoutMs}ms. stderr:\n${stderr}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  // The clock is part of a snapshot. Both counterfactual branches must mine at
  // the same timestamps; monotonicity applies within a branch, not across a
  // revert. Anvil otherwise derives block timestamps from wall-clock time.
  const forkHead = await (async () => {
    try {
      const head = await client.getBlock({ blockNumber: opts.blockNumber });
      if (exited) throw new Error("anvil exited during fork initialization");
      if (opts.expectedBlockHash && head.hash.toLowerCase() !== opts.expectedBlockHash.toLowerCase()) {
        throw new Error("anvil fork block identity differs from the pinned report block");
      }
      return head;
    } catch (err) { await stop(); throw err; }
  })();
  let nextBlockTimestamp = forkHead.timestamp;
  const snapshotClocks = new Map<Hex, bigint>();
  const gasPrice = (forkHead.baseFeePerGas ?? 0n) * 2n + 1_000_000_000n;


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
