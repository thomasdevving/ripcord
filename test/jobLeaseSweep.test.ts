/**
 * THE PERIODIC SWEEP MUST NOT REAP ITS OWN LIVE WORK.
 *
 * `recoverInterruptedJobs` answers "which jobs are abandoned?" for two callers
 * standing in different worlds, and for one input — a record stamped with THIS
 * instance's id — the correct answer is opposite in each. Boot: a previous life
 * left it, reclaim it. Sweep: a worker is running it right now, leave it alone.
 *
 * Collapsing them was a live defect: the reaper interrupted the caller's own
 * running job every 30 seconds and nulled its lease, so the next heartbeat
 * reported the job lost to a competing worker that never existed, and every
 * analysis longer than one sweep interval died. These tests pin both answers,
 * because fixing only the symptom would leave the boot behaviour free to
 * regress in the other direction — where the cost is a restart's own wreckage
 * showing as work still in progress.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore, safeJoin } from "../server/jobs/store.js";
import { createInstanceIdentity, newLease, LEASE_DURATION_MS } from "../server/jobs/lease.js";
import type { JobRecord } from "../server/jobs/store.js";

/**
 * Seeds a job and, separately, its ownership.
 *
 * The lease is written to its OWN file rather than passed through `saveJob`,
 * because `saveJob` deliberately strips it — job state and ownership have
 * different writers and must not share a write. A harness that could seed a
 * lease through the state path would be testing a coupling the code no longer
 * has.
 */
async function storeWith(record: Partial<JobRecord>): Promise<JobStore> {
  const store = new JobStore(mkdtempSync(join(tmpdir(), "ripcord-sweep-")));
  await store.init();
  if (record.lease) {
    writeFileSync(safeJoin(store.leasesDir, "job_live"), JSON.stringify(record.lease, null, 2));
  }
  await store.saveJob({
    jobId: "job_live", controlTokenHash: "x", state: "running", mode: "scan",
    refreshAssetContext: false, address: "0x0", chainId: 1, block: "1",
    blockHash: null, blockSource: "explicit",
    createdAt: new Date().toISOString(), startedAt: new Date().toISOString(),
    endedAt: null, phases: [], structure: null, reportId: null, disclosure: null,
    error: null, lastSeq: 0, idempotencyKey: null, ...record,
  } as JobRecord);
  return store;
}

describe("recoverInterruptedJobs", () => {
  const identity = createInstanceIdentity();
  const now = Date.now();

  it("a sweep leaves this instance's own heartbeated job running", async () => {
    const store = await storeWith({ lease: newLease(identity, now - 1000) });
    const result = await store.recoverInterruptedJobs(identity, now, "sweep");
    expect(result.recovered).toBe(0);
    expect((await store.loadJob("job_live"))?.state).toBe("running");
    // The lease must survive too: nulling it is what made the next heartbeat
    // report the job as lost, which is the message a user actually saw.
    expect((await store.loadJob("job_live"))?.lease).toBeTruthy();
  });

  it("a sweep still reclaims a job whose lease has expired", async () => {
    const store = await storeWith({ lease: newLease(identity, now - LEASE_DURATION_MS - 1000) });
    const result = await store.recoverInterruptedJobs(identity, now, "sweep");
    expect(result.recovered).toBe(1);
    expect((await store.loadJob("job_live"))?.state).toBe("interrupted");
  });

  it("boot still reclaims a job stamped with our own id, since a fresh process owns nothing", async () => {
    const store = await storeWith({ lease: newLease(identity, now - 1000) });
    const result = await store.recoverInterruptedJobs(identity, now, "boot");
    expect(result.recovered).toBe(1);
    expect((await store.loadJob("job_live"))?.state).toBe("interrupted");
  });

  it("neither scope touches a live lease held by a peer", async () => {
    const peer = { ...identity, instanceId: "peer" };
    for (const scope of ["boot", "sweep"] as const) {
      const store = await storeWith({ lease: newLease(peer, now - 1000) });
      const result = await store.recoverInterruptedJobs(identity, now, scope);
      expect(result.skippedLive).toBe(1);
      expect((await store.loadJob("job_live"))?.state).toBe("running");
    }
  });
});


/**
 * THE SECOND HALF OF THE SAME FAILURE.
 *
 * Scoping the sweep stopped the reaper killing its own work every 30 seconds. It
 * did NOT stop the identical message appearing at ~60 seconds, because ownership
 * and job state shared one whole-record write with two writers on very different
 * cadences: the manager persists the entire record on every worker event, and it
 * captured the lease ONCE at claim time — so every event wrote that frozen copy
 * back over the heartbeat's renewal, and the on-disk expiry never advanced past
 * the original claim.
 *
 * The observable consequence was the same sentence the user saw, on any run
 * longer than one lease — which is most real reports. These cases pin the
 * separation that makes the clobber unexpressible rather than merely unlikely.
 */
describe("ownership survives job-state writes", () => {
  const identity = createInstanceIdentity();

  it("a heartbeat renewal is not undone by a later state write", async () => {
    const t0 = Date.now();
    const store = await storeWith({});
    const claimed = await store.claimJob("job_live", identity, t0);
    expect(claimed).not.toBeNull();

    await store.heartbeat("job_live", identity, t0 + 15_000);

    // The manager persists its whole in-memory record, lease and all, exactly as
    // it does on every worker event.
    await store.saveJob({ ...(await store.loadJob("job_live"))!, lease: claimed!.lease });

    const renewed = await store.readLease("job_live");
    expect(Date.parse(renewed!.expiresAt)).toBeGreaterThan(Date.parse(claimed!.lease!.expiresAt));
  });

  it("a long run still holds its lease past the ORIGINAL claim expiry", async () => {
    const t0 = Date.now();
    const store = await storeWith({});
    const claimed = await store.claimJob("job_live", identity, t0);

    // A realistic long run: heartbeats interleaved with event persists.
    for (let elapsed = 15_000; elapsed <= LEASE_DURATION_MS * 2; elapsed += 15_000) {
      expect(await store.heartbeat("job_live", identity, t0 + elapsed)).toBe(true);
      await store.saveJob({ ...(await store.loadJob("job_live"))!, lease: claimed!.lease });
    }

    // Before the split this returned false here, the manager finished the job,
    // and the user was told two workers were competing for it.
    expect(await store.heartbeat("job_live", identity, t0 + LEASE_DURATION_MS * 2 + 1_000)).toBe(true);
    const swept = await store.recoverInterruptedJobs(identity, t0 + LEASE_DURATION_MS * 2 + 1_000, "sweep");
    expect(swept.recovered).toBe(0);
    expect((await store.loadJob("job_live"))?.state).toBe("running");
  });

  it("releasing ownership leaves the job record intact", async () => {
    const store = await storeWith({});
    await store.claimJob("job_live", identity);
    await store.releaseJob("job_live", identity);
    const after = await store.loadJob("job_live");
    // Ownership gone, state untouched — the two are genuinely independent now.
    expect(after?.lease).toBeNull();
    expect(after?.state).toBe("running");
  });

  it("a peer cannot release a lease it does not hold", async () => {
    const store = await storeWith({});
    await store.claimJob("job_live", identity);
    await store.releaseJob("job_live", { instanceId: "peer", host: "h", pid: 2, startedAt: new Date().toISOString() });
    expect((await store.loadJob("job_live"))?.lease?.instanceId).toBe(identity.instanceId);
  });
});
