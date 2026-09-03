import { expect, it, vi } from "vitest";
import { verifyBlockIdentity } from "../server/identity.js";
import { loadConfig } from "../server/config.js";
const hash = `0x${"ab".repeat(32)}`;
it("checks the selected chain, block number and hash, including when rereading the same block", async () => {
  const client = { getChainId: vi.fn(async () => 1), getBlock: vi.fn(async () => ({ number: 100n, hash })) };
  expect(await verifyBlockIdentity(client, 1, 100n)).toBe(hash);
  expect(await verifyBlockIdentity(client, 1, 100n, hash.toUpperCase())).toBe(hash);
  client.getBlock.mockResolvedValue({ number: 100n, hash: `0x${"cd".repeat(32)}` });
  await expect(verifyBlockIdentity(client, 1, 100n, hash)).rejects.toThrow(/identity changed/);
  client.getBlock.mockResolvedValue({ number: 101n, hash });
  await expect(verifyBlockIdentity(client, 1, 100n)).rejects.toThrow(/requested pinned block/);
  client.getChainId.mockResolvedValue(10);
  await expect(verifyBlockIdentity(client, 1, 100n)).rejects.toThrow(/selected chain/);
});
it("honors the explicit config environment instead of accidentally reading process globals", () => {
  const config = loadConfig({ RIPCORD_ENABLE_LIVE_RUNS: "true", RIPCORD_MAX_QUEUED_JOBS: "2", RPC_URL_1: "https://rpc.invalid" });
  expect(config.enableLiveRuns).toBe(true); expect(config.maxQueuedJobs).toBe(2); expect(config.rpcUrls.get(1)).toBe("https://rpc.invalid");
});
