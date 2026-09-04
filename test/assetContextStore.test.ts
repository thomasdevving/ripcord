import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JobStore } from "../server/jobs/store.js";

let dir: string;
let store: JobStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ripcord-asset-store-"));
  store = new JobStore(dir);
  await store.init();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("asset-context write ordering", () => {
  it("cannot let an older slow write overwrite a newer write for the same report", async () => {
    // Atomic rename alone is insufficient: whichever rename finishes last
    // wins, even if that write was invoked first. Delay the first physical
    // write so this test deterministically reproduces the stale-overwrite race
    // that per-report serialisation closes.
    const internals = store as unknown as {
      writeAtomic(path: string, contents: string): Promise<void>;
    };
    const realWrite = internals.writeAtomic.bind(store);
    let calls = 0;
    internals.writeAtomic = async (path, contents) => {
      calls++;
      if (calls === 1) await new Promise((resolve) => setTimeout(resolve, 80));
      await realWrite(path, contents);
    };

    await Promise.all([
      store.saveAssetContext("rep_ordered", { runId: "older", status: "pending" }),
      store.saveAssetContext("rep_ordered", { runId: "newer", status: "complete" }),
    ]);

    expect(await store.loadAssetContext("rep_ordered")).toEqual({ runId: "newer", status: "complete" });
  });

  it("does not make writes for unrelated reports wait for each other", async () => {
    const internals = store as unknown as {
      writeAtomic(path: string, contents: string): Promise<void>;
    };
    const realWrite = internals.writeAtomic.bind(store);
    let releaseFirst!: () => void;
    const held = new Promise<void>((resolve) => { releaseFirst = resolve; });
    internals.writeAtomic = async (path, contents) => {
      if (path.endsWith("rep_slow.json")) await held;
      await realWrite(path, contents);
    };

    const slow = store.saveAssetContext("rep_slow", { status: "pending" });
    await store.saveAssetContext("rep_fast", { status: "complete" });
    expect(await store.loadAssetContext("rep_fast")).toEqual({ status: "complete" });
    releaseFirst();
    await slow;
  });
});
