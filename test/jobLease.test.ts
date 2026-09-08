/**
 * THE OWNERSHIP RULES, in isolation from the store that persists them.
 *
 * These are the decisions that make a second instance safe, and every one of
 * them is asymmetric on purpose. Refusing to claim a job costs a queued run that
 * someone can retry; claiming one that is still executing puts two workers on
 * one analysis, and both write the same report id. So every ambiguous case
 * resolves toward "leave it alone".
 */
import { describe, expect, it } from "vitest";
import {
  claimable,
  createInstanceIdentity,
  heldBy,
  HEARTBEAT_INTERVAL_MS,
  LEASE_DURATION_MS,
  leaseExpired,
  newLease,
  reclaimReason,
  renewLease,
  type JobLease,
} from "../server/jobs/lease.js";

const me = { instanceId: "me", host: "h1", pid: 1, startedAt: "2026-01-01T00:00:00.000Z" };
const peer = { instanceId: "peer", host: "h2", pid: 2, startedAt: "2026-01-01T00:00:00.000Z" };
const T0 = Date.parse("2026-01-01T00:00:00.000Z");

describe("lease timing", () => {
  it("a heartbeat is comfortably inside the lease, so one slow tick is not a loss", () => {
    // If these ever crossed, an instance doing everything right would lose its
    // claim mid-run and the job would be reclaimed under a live worker.
    expect(HEARTBEAT_INTERVAL_MS * 2).toBeLessThan(LEASE_DURATION_MS);
  });

  it("a fresh lease expires one duration out and is not expired now", () => {
    const lease = newLease(me, T0);
    expect(Date.parse(lease.expiresAt) - T0).toBe(LEASE_DURATION_MS);
    expect(leaseExpired(lease, T0)).toBe(false);
    expect(leaseExpired(lease, T0 + LEASE_DURATION_MS)).toBe(true);
  });

  it("renewing pushes the expiry out without changing who holds it", () => {
    const lease = newLease(me, T0);
    const renewed = renewLease(lease, T0 + 30_000);
    expect(renewed.instanceId).toBe("me");
    expect(renewed.claimedAt).toBe(lease.claimedAt);
    expect(leaseExpired(renewed, T0 + LEASE_DURATION_MS)).toBe(false);
  });
});

describe("expiry is fail-closed", () => {
  it("treats an absent lease as free", () => {
    expect(leaseExpired(null)).toBe(true);
    expect(leaseExpired(undefined)).toBe(true);
  });

  it("treats an UNPARSEABLE expiry as NOT expired", () => {
    // The asymmetry that matters: a corrupt record is left for an operator
    // rather than reclaimed into a double execution.
    const corrupt = { ...newLease(me, T0), expiresAt: "not-a-date" } as JobLease;
    expect(leaseExpired(corrupt, T0 + 10 * LEASE_DURATION_MS)).toBe(false);
    expect(claimable(corrupt, peer, T0 + 10 * LEASE_DURATION_MS)).toBe(false);
  });
});

describe("who may claim what", () => {
  it("anyone may claim an unowned job", () => {
    expect(claimable(null, me)).toBe(true);
    expect(claimable(undefined, peer)).toBe(true);
  });

  it("a peer may NOT take a live lease", () => {
    expect(claimable(newLease(me, T0), peer, T0 + 1000)).toBe(false);
  });

  it("a peer MAY take an expired one, or a crash would strand the job forever", () => {
    expect(claimable(newLease(me, T0), peer, T0 + LEASE_DURATION_MS + 1)).toBe(true);
  });

  it("an instance may always retake its own claim, which is what makes a local restart recover", () => {
    expect(claimable(newLease(me, T0), me, T0 + 1000)).toBe(true);
  });

  it("heldBy is true only for a live claim by this instance", () => {
    const lease = newLease(me, T0);
    expect(heldBy(lease, me, T0 + 1000)).toBe(true);
    expect(heldBy(lease, peer, T0 + 1000)).toBe(false);
    expect(heldBy(lease, me, T0 + LEASE_DURATION_MS + 1)).toBe(false);
    expect(heldBy(null, me)).toBe(false);
  });
});

describe("a reclaimed job says which thing happened", () => {
  it("names a local restart as a restart", () => {
    expect(reclaimReason(newLease(me, T0), me)).toMatch(/This instance restarted/);
  });

  it("names a stalled peer as a stalled peer, with its identity", () => {
    const reason = reclaimReason(newLease(peer, T0), me);
    // A crash and a stall both end the job; a reader deserves to know which,
    // and which host to go and look at.
    expect(reason).toMatch(/stopped renewing its lease/);
    expect(reason).toContain("peer");
    expect(reason).toContain("h2");
  });
});

describe("instance identity", () => {
  it("is unique per process by default", () => {
    expect(createInstanceIdentity().instanceId).not.toBe(createInstanceIdentity().instanceId);
  });

  it("honours a configured stable id, which is what makes restart recovery immediate", () => {
    const previous = process.env.RIPCORD_INSTANCE_ID;
    process.env.RIPCORD_INSTANCE_ID = "replica-a";
    try {
      expect(createInstanceIdentity().instanceId).toBe("replica-a");
      expect(createInstanceIdentity().instanceId).toBe("replica-a");
    } finally {
      if (previous === undefined) delete process.env.RIPCORD_INSTANCE_ID;
      else process.env.RIPCORD_INSTANCE_ID = previous;
    }
  });

  it("records pid and host for diagnosis, never for liveness", () => {
    // A pid means nothing on another host and is recycled on this one, which is
    // why nothing in this module reads it to decide whether an owner is alive.
    const identity = createInstanceIdentity();
    expect(identity.pid).toBe(process.pid);
    expect(identity.host.length).toBeGreaterThan(0);
  });
});
