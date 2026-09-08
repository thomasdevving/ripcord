/**
 * DURABLE JOB OWNERSHIP.
 *
 * `JobManager` keeps its queue, its running set and its admission limits in
 * process memory. That is correct for one instance and wrong for two, and the
 * failure is not merely "they do not share a queue" — it is destructive:
 * `recoverInterruptedJobs` marked EVERY persisted `queued` or `running` job
 * `interrupted` at boot, so a second instance starting up would declare the
 * first instance's in-flight work dead while it was still running, and the
 * browser watching it would be told the analysis had failed.
 *
 * The fix is ownership with a deadline. A job is owned by an instance for a
 * bounded LEASE, renewed by a heartbeat while the work is alive. Recovery then
 * has a precise question to ask — "is this lease expired?" — instead of the
 * unanswerable one it was asking, which was "did anyone restart?".
 *
 * WHAT THIS IS AND IS NOT. It makes the ownership MODEL correct and moves the
 * admission decision onto a durable record, which is the part that has to be
 * right before any storage backend can be swapped in. It does NOT make the file
 * store a distributed database: compare-and-set here rests on atomic
 * temp+rename within one directory, which holds on a local filesystem and on a
 * single shared volume, and does NOT hold across NFS clients or across separate
 * volumes. A genuinely multi-node deployment needs a store with real conditional
 * writes; `ClaimStore` is the seam where that swap happens, and every rule about
 * WHO may run WHAT lives above it rather than inside the file layer.
 *
 * The conservative direction is preserved throughout: a lease that cannot be
 * proven free is not taken, and a job whose owner cannot be proven dead is not
 * reclaimed. Refusing to run a job costs a queued run; stealing one that is
 * still executing costs two workers writing the same report.
 */
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

/** How long a claim is valid without a heartbeat. */
export const LEASE_DURATION_MS = 60_000;
/** How often a live worker renews. Comfortably inside the lease so a slow tick is not a loss. */
export const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Identifies one running process. `pid` is recorded for operator diagnosis only
 * — never for liveness, because a pid means nothing on another host and is
 * recycled on this one. Liveness is the lease, and only the lease.
 */
export interface InstanceIdentity {
  instanceId: string;
  host: string;
  pid: number;
  startedAt: string;
}

export function createInstanceIdentity(): InstanceIdentity {
  return {
    instanceId: process.env.RIPCORD_INSTANCE_ID?.trim() || randomUUID(),
    host: hostname(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
}

/** The ownership stamp persisted on a job. */
export interface JobLease {
  instanceId: string;
  host: string;
  pid: number;
  /** When the claim was first taken. */
  claimedAt: string;
  /** Last heartbeat. */
  renewedAt: string;
  /** After this instant the claim is reclaimable by anyone. */
  expiresAt: string;
}

export function newLease(identity: InstanceIdentity, now = Date.now()): JobLease {
  const at = new Date(now).toISOString();
  return {
    instanceId: identity.instanceId,
    host: identity.host,
    pid: identity.pid,
    claimedAt: at,
    renewedAt: at,
    expiresAt: new Date(now + LEASE_DURATION_MS).toISOString(),
  };
}

export function renewLease(lease: JobLease, now = Date.now()): JobLease {
  return {
    ...lease,
    renewedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + LEASE_DURATION_MS).toISOString(),
  };
}

/**
 * Is this lease expired?
 *
 * FAIL-CLOSED on a malformed or missing timestamp: an unparseable `expiresAt` is
 * treated as NOT expired, so a corrupt record is left alone rather than
 * reclaimed. The two errors are not symmetric — refusing to reclaim leaves a job
 * stuck until an operator looks, while wrongly reclaiming puts two workers on
 * one job and lets them both write its report.
 */
export function leaseExpired(lease: JobLease | null | undefined, now = Date.now()): boolean {
  if (!lease) return true; // no owner at all: free by definition
  const expiry = Date.parse(lease.expiresAt);
  if (!Number.isFinite(expiry)) return false;
  return expiry <= now;
}

/** Held by THIS instance, and still valid. */
export function heldBy(lease: JobLease | null | undefined, identity: InstanceIdentity, now = Date.now()): boolean {
  return Boolean(lease) && lease!.instanceId === identity.instanceId && !leaseExpired(lease, now);
}

/**
 * May this instance take the job?
 *
 * Reclaiming another instance's EXPIRED lease is deliberately allowed: without
 * it a crashed instance's work would be stranded forever, which is the failure
 * this whole mechanism exists to avoid. The safety comes from the lease being
 * long relative to the heartbeat, so an instance that is merely slow keeps its
 * claim.
 */
export function claimable(lease: JobLease | null | undefined, identity: InstanceIdentity, now = Date.now()): boolean {
  if (!lease) return true;
  if (lease.instanceId === identity.instanceId) return true; // re-taking our own claim after a local restart
  return leaseExpired(lease, now);
}

/**
 * How a reclaimed job should be described.
 *
 * Named rather than folded into the generic restart message because they are
 * different facts: one instance losing a job it owned is a crash, while a lease
 * expiring under a still-running worker is a stall. Both end the job, and a
 * reader deserves to know which happened.
 */
export function reclaimReason(lease: JobLease, identity: InstanceIdentity): string {
  return lease.instanceId === identity.instanceId
    ? "This instance restarted while the analysis was in progress, so it did not complete."
    : `The instance running this analysis (${lease.instanceId} on ${lease.host}) stopped renewing its lease, so the work was abandoned rather than left appearing to run.`;
}
