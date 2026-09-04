/**
 * THE PORT-COLLISION REGRESSION.
 *
 * `startAnvilFork` used to derive its port from the block number and pid, so two
 * forks started from one process at one pinned block chose the SAME port — an
 * ordinary event once asset-context runs began starting forks outside the
 * job-capacity limiter.
 *
 * The collision was survivable; the silence was not. The second anvil fails to
 * bind, but the readiness poll gets a healthy answer from the FIRST, whose fork
 * block and `expectedBlockHash` are identical, so the second engine drove the
 * first's fork and interleaved transactions into somebody else's comparison.
 *
 * These tests need no real Anvil and no upstream RPC: a tiny child fixture does
 * the bind, announces only after it owns the socket, and serves the two JSON-RPC
 * reads used during readiness.
 */
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { startAnvilFork } from "../src/fork/anvil.js";

const FORK_BLOCK = 25_800_000n;

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return port;
}

const FOREIGN_HASH = `0x${"ab".repeat(32)}`;

/** A JSON-RPC endpoint standing in for somebody else's already-running node. */
async function fakeNode(port: number, blockNumber: bigint): Promise<Server> {
  const server = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let id: unknown = 1;
      let method = "";
      try {
        const parsed = JSON.parse(body);
        id = parsed.id;
        method = parsed.method;
      } catch { /* keep the defaults */ }
      const result = method === "eth_getBlockByNumber"
        ? {
            number: `0x${blockNumber.toString(16)}`,
            hash: FOREIGN_HASH,
            timestamp: "0x65000000",
            baseFeePerGas: "0x1",
            transactions: [],
          }
        : `0x${blockNumber.toString(16)}`;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return server;
}

const STUB_ANVIL = fileURLToPath(new URL("./fixtures/fake-anvil.mjs", import.meta.url));
let node: Server | null = null;

afterEach(async () => {
  if (node) await new Promise<void>((resolve) => node!.close(() => resolve()));
  node = null;
});

describe("fork port ownership", () => {
  it("refuses an occupied explicit port before reading from the foreign node", async () => {
    const port = await freePort();
    // The shape of the bug: another fork of the SAME block, already mining.
    node = await fakeNode(port, FORK_BLOCK + 4n);

    await expect(
      startAnvilFork({
        rpcUrl: "http://unused.invalid",
        blockNumber: FORK_BLOCK,
        anvilExecutable: STUB_ANVIL,
        port,
        timeoutMs: 3_000,
      }),
    ).rejects.toThrow(/exited before announcing|EADDRINUSE/i);
  }, 15_000);

  it("rejects a foreign node sitting at the exact fork block when the block identity is pinned", async () => {
    const port = await freePort();
    // The harder case: a foreign node whose head has NOT moved, so the block
    // number alone cannot tell it apart. The pinned block hash is what does.
    node = await fakeNode(port, FORK_BLOCK);

    await expect(
      startAnvilFork({
        rpcUrl: "http://unused.invalid",
        blockNumber: FORK_BLOCK,
        expectedBlockHash: `0x${"11".repeat(32)}`,
        anvilExecutable: STUB_ANVIL,
        port,
        timeoutMs: 2_000,
      }),
    ).rejects.toThrow(/exited before announcing|EADDRINUSE/i);
  }, 15_000);

  it("rejects the spawned child's state when its block hash differs from the pin", async () => {
    await expect(
      startAnvilFork({
        rpcUrl: "http://unused.invalid",
        blockNumber: FORK_BLOCK,
        expectedBlockHash: `0x${"11".repeat(32)}`,
        anvilExecutable: STUB_ANVIL,
        timeoutMs: 3_000,
      }),
    ).rejects.toThrow(/block identity differs from the pinned report block/i);
  }, 15_000);

  it("never includes an upstream RPC secret from child output in an error", async () => {
    let message = "";
    try {
      await startAnvilFork({
        rpcUrl: "https://emit-secret.invalid/v2/private-api-key",
        blockNumber: FORK_BLOCK,
        anvilExecutable: STUB_ANVIL,
        timeoutMs: 3_000,
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/url redacted|redacted/i);
    expect(message).not.toContain("private-api-key");
    expect(message).not.toContain("super-secret-token");
    expect(message).not.toContain("emit-secret.invalid");
  }, 15_000);

  it("still refuses an occupied port when no expected block hash was supplied", async () => {
    // Ownership no longer depends on block identity. Only this spawned child
    // may announce the port, so an existing exact-head node is never adopted.
    const port = await freePort();
    node = await fakeNode(port, FORK_BLOCK);

    await expect(startAnvilFork({
        rpcUrl: "http://unused.invalid",
        blockNumber: FORK_BLOCK,
        anvilExecutable: STUB_ANVIL,
        port,
        timeoutMs: 2_000,
      }),
    ).rejects.toThrow(/exited before announcing|EADDRINUSE/i);
  }, 15_000);

  it("lets the OS hand concurrent child processes distinct ports", async () => {
    // The old derivation returned ONE number for one (pid, block) pair, so
    // three concurrent starts at the same block collided by construction.
    //
    // The first version only asserted that all three attempts rejected. This
    // version obtains three working handles and compares the bound ports.
    const forks = await Promise.all(
      [0, 1, 2].map(() => startAnvilFork({
          rpcUrl: "http://unused.invalid",
          blockNumber: FORK_BLOCK,
          anvilExecutable: STUB_ANVIL,
          timeoutMs: 3_000,
        })),
    );
    expect(new Set(forks.map((fork) => fork.port)).size).toBe(3);
    expect(forks.every((fork) => fork.port > 0 && fork.rpcUrl === `http://127.0.0.1:${fork.port}`)).toBe(true);
    await Promise.all(forks.map((fork) => fork.stop()));
  }, 20_000);

  it("releases an explicit port after stop so a later child can bind it", async () => {
    const port = await freePort();
    const first = await startAnvilFork({
      rpcUrl: "http://unused.invalid",
      blockNumber: FORK_BLOCK,
      anvilExecutable: STUB_ANVIL,
      port,
      timeoutMs: 3_000,
    });
    await first.stop();

    const second = await startAnvilFork({
      rpcUrl: "http://unused.invalid",
      blockNumber: FORK_BLOCK,
      anvilExecutable: STUB_ANVIL,
      port,
      timeoutMs: 3_000,
    });
    expect(second.port).toBe(port);
    await second.stop();
    await expect(second.stop()).resolves.toBeUndefined();
  }, 15_000);
});
