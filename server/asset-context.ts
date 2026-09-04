/**
 * POST-ANALYSIS ASSET CONTEXT.
 *
 * Mobula proposes asset identities from its complete holdings response at the
 * wall-clock time of a run. Independently of the UI floor/cap, Ripcord selects
 * a bounded same-chain ERC20 set and asks a separate, pinned question for each
 * Ethereum ERC20 candidate: did this exact token contract report a balance for
 * the analysed target at the report's block?
 *
 * The result is a sidecar keyed by report id. It never enters the deterministic
 * report, never changes the verdict, and never turns a missing candidate into a
 * claim of absence. The browser only sees it after the report has passed the
 * publication gate and through the coverage composer.
 */
import { decodeFunctionResult, encodeFunctionData, getAddress, isAddress, keccak256, type Hex } from "viem";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { erc20Abi } from "../src/chain/abi.js";
import { PinnedChain, type ChainReader, type Evidence } from "../src/chain/client.js";
import { MAJOR_TOKENS } from "../src/chain/majorTokens.js";
import { buildLiveExposure, type LiveCandidateHolding, type LiveExposure } from "../src/live/exposure.js";
import { assetScenarioCandidateCap, runAssetExitScenarios, type AssetScenarioBatch } from "../src/fork/assetScenarios.js";
import type { ForkHandle } from "../src/fork/anvil.js";
import type { Report } from "../src/report/schema.js";
import type { ServerConfig } from "./config.js";
import { sanitize } from "./sanitize.js";
import { JobStore } from "./jobs/store.js";

export const assetContextVersion = "0.2.0";

const NATIVE_SENTINEL = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

export type CandidateVerificationState =
  | "verified_nonzero"
  | "verified_zero"
  | "not_contract_at_block"
  | "balance_call_reverted"
  /**
   * The call RAN and returned nothing.
   *
   * `PinnedChain.call` records `result: "0x"`/undefined for a call that
   * completed without returning data, and a revert separately. Filing the first
   * as `balance_call_reverted` is the conflation KNOWN EDGE #35 documents: a
   * successful, empty-returning call is the strongest kind of observation the
   * probe makes, and describing it as an unreadable revert throws that away.
   */
  | "balance_returned_no_data"
  | "balance_decode_failed"
  | "read_failed";

export interface CandidateVerification {
  chainRef: string;
  address: string;
  account: string;
  block: string;
  state: CandidateVerificationState;
  balanceRaw: string | null;
  /** Small, stable code witness; the full bytecode would make this sidecar unnecessarily huge. */
  codeBytes: number | null;
  codeHash: string | null;
  evidence: Evidence[];
  reason: string;
}

export type CandidateWithheldReason =
  | "native"
  | "other_or_unclear_chain"
  | "malformed_address"
  | "duplicate"
  | "beyond_cap";

export interface CandidateSelection {
  selected: LiveCandidateHolding[];
  proposed: number;
  withheld: { reason: CandidateWithheldReason; count: number }[];
}

export interface AssetContextArtifact {
  assetContextVersion: string;
  reportId: string;
  /**
   * Which refresh produced this record.
   *
   * Present so a stale write is refusable and a reader can tell two refreshes
   * of the same report apart. Optional only because sidecars written before
   * this field existed are still readable.
   */
  runId?: string;
  target: string;
  chainId: number;
  block: { number: string; hash: string | null };
  requestedAt: string;
  completedAt: string | null;
  status: "pending" | "complete" | "partial" | "unavailable";
  /** Fresh per-analysis snapshot. Null only while the request is pending. */
  exposure: LiveExposure | null;
  candidates: CandidateVerification[];
  counts: { displayed: number; eligible: number; verified: number; failed: number };
  candidateSelection?: {
    proposed: number;
    cap: number;
    withheld: { reason: CandidateWithheldReason; count: number }[];
  };
  forkScenarios: {
    requested: boolean;
    status: "not_requested" | "pending" | "complete" | "partial" | "unavailable";
    batch: AssetScenarioBatch | null;
    note: string;
  };
  notes: string[];
}

/**
 * How long a cancelled run is given to unwind before its slot is returned.
 *
 * Correctness does not depend on this — a cancelled run is sealed and cannot
 * write. It only decides whether an unabortable hang wedges the queue or is
 * reported and stepped over. Injectable so the grace path can be exercised in
 * a test rather than only reasoned about.
 */
export const DEFAULT_SETTLE_GRACE_MS = 10_000;

const emptyCounts = () => ({ displayed: 0, eligible: 0, verified: 0, failed: 0 });

export function pendingAssetContext(
  reportId: string,
  report: Report,
  runForkScenarios = false,
  requestedAt = new Date().toISOString(),
): AssetContextArtifact {
  return {
    assetContextVersion,
    reportId,
    target: report.target.address,
    chainId: report.chainId,
    block: { number: report.block.number, hash: report.block.hash === "0x" ? null : report.block.hash },
    requestedAt,
    completedAt: null,
    status: "pending",
    exposure: null,
    candidates: [],
    counts: emptyCounts(),
    forkScenarios: runForkScenarios
      ? { requested: true, status: "pending", batch: null, note: "Waiting for candidate discovery and pinned balance verification." }
      : { requested: false, status: "not_requested", batch: null, note: "The selected analysis mode did not request additional candidate fork scenarios." },
    notes: [
      "Mobula refresh and pinned candidate verification are running outside the verdict path.",
    ],
  };
}

function normaliseCandidateChain(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().toLowerCase();
  const match = /^(?:evm:)?(\d+)$/.exec(text);
  return match ? `evm:${Number(match[1])}` : null;
}

/**
 * WHAT SURVIVES WHEN THE CAP BITES, AND WHY IT IS NOT VENDOR ORDER.
 *
 * Discovery already consumes every proposed identity rather than the priced,
 * floored display subset — that is what stopped an unpriced new collateral from
 * being invisible. But a cap still has to drop something once there are more
 * eligible identities than slots, and taking them in the order the vendor
 * happened to return is not neutral: these lists are full of airdropped tokens
 * (verified live on Lido's withdrawal queue, whose entries include outright
 * phishing lures), and vendor position would let that spam displace a real
 * collateral asset for no reason anyone could state.
 *
 * Ordering is therefore explicit, and deliberately VALUE-BLIND — reintroducing
 * a value ranking here would rebuild the exclusion this whole layer exists to
 * remove, just one step further down:
 *
 *   1. Curated major tokens for this chain first. Their identity is already
 *      established by an independent, committed list, so including them costs
 *      nothing and excluding one would be indefensible.
 *   2. Everything else, ordered by ADDRESS. Arbitrary, but stable — two
 *      selections over the same identities pick the same set, which vendor
 *      order does not guarantee even between two fetches a second apart.
 *
 * Ordering only ever decides WHO IS DROPPED once the cap is exceeded; with room
 * to spare, every eligible identity is selected either way. Whatever is dropped
 * is counted in `beyond_cap` and rendered, never silently discarded.
 */
export function selectMobulaCandidates(exposure: LiveExposure, chainId: number): CandidateSelection {
  const wanted = `evm:${chainId}`;
  const seen = new Set<string>();
  const eligible: LiveCandidateHolding[] = [];
  const counts = { native: 0, other_or_unclear_chain: 0, malformed_address: 0, duplicate: 0, beyond_cap: 0 };
  const proposed = exposure.candidateHoldings ?? exposure.holdings;
  for (const holding of proposed) {
    const native = holding.isNative || holding.address?.toLowerCase() === NATIVE_SENTINEL;
    if (native) { counts.native++; continue; }
    if (normaliseCandidateChain(holding.chainId) !== wanted) { counts.other_or_unclear_chain++; continue; }
    if (!holding.address || !isAddress(holding.address)) { counts.malformed_address++; continue; }
    const address = holding.address.toLowerCase();
    if (seen.has(address)) { counts.duplicate++; continue; }
    seen.add(address);
    eligible.push(holding as LiveCandidateHolding);
  }

  const curated = new Set((MAJOR_TOKENS[chainId] ?? []).map((token) => token.address.toLowerCase()));
  const ranked = [...eligible].sort((a, b) => {
    const aCurated = curated.has(a.address!.toLowerCase()) ? 0 : 1;
    const bCurated = curated.has(b.address!.toLowerCase()) ? 0 : 1;
    if (aCurated !== bCurated) return aCurated - bCurated;
    return a.address!.toLowerCase().localeCompare(b.address!.toLowerCase());
  });
  counts.beyond_cap = Math.max(0, ranked.length - assetScenarioCandidateCap);

  return {
    selected: ranked.slice(0, assetScenarioCandidateCap),
    proposed: proposed.length,
    withheld: (Object.entries(counts) as [keyof typeof counts, number][])
      .filter(([, count]) => count > 0)
      .map(([reason, count]) => ({ reason, count })),
  };
}

/**
 * Pure orchestration over an injected pinned reader, so every edge can be
 * tested without network access. One candidate failing never upgrades or
 * erases another candidate's evidence.
 */
export async function verifyDisplayedCandidates(
  chain: Pick<ChainReader, "getCode" | "call">,
  target: Hex,
  exposure: LiveExposure,
  chainId: number,
  block: string,
): Promise<CandidateVerification[]> {
  const candidates = selectMobulaCandidates(exposure, chainId).selected;
  const out: CandidateVerification[] = [];

  for (const holding of candidates) {
    const address = getAddress(holding.address as string) as Hex;
    const base = { chainRef: `evm:${chainId}`, address: address.toLowerCase(), account: target.toLowerCase(), block };
    try {
      const { code, evidence: codeEvidence } = await chain.getCode(address);
      if (!code) {
        out.push({
          ...base,
          state: "not_contract_at_block",
          balanceRaw: null,
          codeBytes: 0,
          codeHash: null,
          evidence: [codeEvidence],
          reason: "Mobula supplied an address, but no contract code existed there at the pinned analysis block; no ERC20 balance claim was made.",
        });
        continue;
      }

      const codeBytes = (code.length - 2) / 2;
      const codeHash = keccak256(code);
      const data = encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [target] });
      const call = await chain.call(address, data);
      if (call.reverted) {
        out.push({
          ...base,
          state: "balance_call_reverted",
          balanceRaw: null,
          codeBytes,
          codeHash,
          evidence: [codeEvidence, call.evidence],
          reason: "The pinned balanceOf(target) call reverted; the balance is unknown, not zero.",
        });
        continue;
      }
      if (!call.result || call.result === "0x") {
        out.push({
          ...base,
          state: "balance_returned_no_data",
          balanceRaw: null,
          codeBytes,
          codeHash,
          evidence: [codeEvidence, call.evidence],
          reason: "The pinned balanceOf(target) call executed and returned no data, so this contract does not answer balanceOf as an ERC20. That is an observation about the contract, not a failed read and not a zero balance.",
        });
        continue;
      }

      let balance: bigint;
      try {
        balance = decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data: call.result }) as bigint;
      } catch {
        out.push({
          ...base,
          state: "balance_decode_failed",
          balanceRaw: null,
          codeBytes,
          codeHash,
          evidence: [codeEvidence, call.evidence],
          reason: "The pinned balanceOf(target) result did not decode as uint256; the balance is unknown, not zero.",
        });
        continue;
      }

      out.push({
        ...base,
        state: balance === 0n ? "verified_zero" : "verified_nonzero",
        balanceRaw: balance.toString(),
        codeBytes,
        codeHash,
        evidence: [codeEvidence, call.evidence],
        reason:
          balance === 0n
            ? "The candidate token reported a zero target balance at the pinned analysis block. This says nothing about its balance in the later Mobula snapshot."
            : "The candidate token reported a non-zero target balance at the pinned analysis block.",
      });
    } catch (err) {
      out.push({
        ...base,
        state: "read_failed",
        balanceRaw: null,
        codeBytes: null,
        codeHash: null,
        evidence: [],
        reason: `Pinned candidate verification failed because the RPC read did not complete: ${sanitize(err)}`,
      });
    }
  }
  return out;
}

/**
 * Owns the asynchronous refresh for a stored, publishable live report.
 *
 * BOUNDED ON PURPOSE, IN THREE DIMENSIONS. These refreshes start AFTER a job's
 * worker has exited, so they are invisible to `maxActiveJobs` — the limiter
 * that exists precisely to stop N anvil forks running at once. Left unbounded,
 * N jobs completing together produced N vendor fetches and N forks with no
 * ceiling, and a fork that hung left its sidecar `pending` forever with every
 * open browser tab polling it.
 *
 *   - CONCURRENCY: `maxActiveAssetContexts` run at a time.
 *   - QUEUE DEPTH: beyond `maxQueuedAssetContexts` waiting, a refresh is
 *     refused immediately and says so, rather than queueing without bound.
 *   - TIME: `assetContextTimeoutMs` caps one refresh end to end, and the fork
 *     batch receives the remaining budget as its own deadline.
 *
 * Every one of those limits produces an explicit `unavailable` sidecar with a
 * stated reason. None of them produces silence.
 */
/**
 * A counted semaphore with a bounded wait queue.
 *
 * Extracted because its one invariant — never more than `maxActive` holders —
 * is not observable through `AssetContextService`'s public surface, and an
 * invariant that cannot be tested directly is one that gets quietly broken.
 * It was: the first version decremented the count in `release()` and let the
 * woken waiter increment it again after its own microtask resumed. Those are
 * two turns of the event loop, and an `acquire()` landing between them takes
 * the slot the waiter is also about to take.
 *
 * THE SLOT IS TRANSFERRED, NEVER RE-TAKEN. `release()` hands its slot straight
 * to the next waiter without the count ever dipping, so the window does not
 * exist rather than being unlikely.
 */
export class BoundedSemaphore {
  private active = 0;
  /** The boolean says whether a SLOT WAS TRANSFERRED, as opposed to being woken to give up. */
  private readonly waiting: ((granted: boolean) => void)[] = [];
  private closed = false;

  constructor(private readonly maxActive: number, private readonly maxQueued: number) {}

  /** For tests and diagnostics: how many holders the semaphore believes it has. */
  get held(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiting.length;
  }

  async acquire(): Promise<boolean> {
    if (this.closed) return false;
    if (this.active < this.maxActive) {
      this.active++;
      return true;
    }
    if (this.waiting.length >= this.maxQueued) return false;
    const granted = await new Promise<boolean>((resolve) => this.waiting.push(resolve));
    // Woken to give up: no slot was transferred, so none is owed back.
    if (!granted) return false;
    // A slot WAS transferred. Refusing now hands it on rather than silently
    // keeping the count high.
    if (this.closed) {
      this.release();
      return false;
    }
    return true;
  }

  release(): void {
    const next = this.waiting.shift();
    if (next) {
      next(true);
      return;
    }
    this.active--;
  }

  /** Refuses every current and future waiter. Holders are unaffected. */
  close(): void {
    this.closed = true;
    while (this.waiting.length) this.waiting.shift()?.(false);
  }
}

/**
 * One refresh, and the two things that make it cancellable.
 *
 * `controller` is how it is told to stop. `sealed` is how its writes are
 * refused AFTER it has been told: cancellation is cooperative, so between the
 * abort and the last `await` unwinding there is a window in which the old run
 * can still reach the store — and that is precisely how a terminal timeout
 * result got overwritten by a late vendor answer.
 */
interface AssetContextRun {
  runId: string;
  reportId: string;
  controller: AbortController;
  /** Once true, this run may no longer write. Set BEFORE the supervisor writes its terminal record. */
  sealed: boolean;
  /** Settles when the underlying work has actually stopped. The slot is held until then. */
  done: Promise<void>;
}

export class AssetContextService {
  private readonly activeForks = new Set<ForkHandle>();
  private readonly slots: BoundedSemaphore;
  private shuttingDown = false;
  /** The run currently permitted to write for a report id. */
  private readonly runs = new Map<string, AssetContextRun>();

  private readonly settleGraceMs: number;

  constructor(
    private readonly config: ServerConfig,
    private readonly store: JobStore,
    opts: { settleGraceMs?: number } = {},
  ) {
    this.settleGraceMs = opts.settleGraceMs ?? DEFAULT_SETTLE_GRACE_MS;
    this.slots = new BoundedSemaphore(config.maxActiveAssetContexts, config.maxQueuedAssetContexts);
  }

  /**
   * THE GENERATION GUARD.
   *
   * Every sidecar write from inside a run goes through here. A sealed run is
   * refused, and so is a run that is no longer the one registered for this
   * report id. Without it, `Promise.race` gives the illusion of a deadline:
   * the race resolves, the supervisor writes `unavailable`, and the losing
   * promise — which was never cancelled, because a race cannot cancel — comes
   * back later and overwrites a terminal result with a stale one.
   */
  private async saveFrom(run: AssetContextRun, artifact: AssetContextArtifact): Promise<boolean> {
    if (run.sealed || this.runs.get(run.reportId)?.runId !== run.runId) return false;
    await this.store.saveAssetContext(run.reportId, { ...artifact, runId: run.runId });
    return true;
  }

  /** Revokes a run's right to write and tells it to stop. Idempotent. */
  private seal(run: AssetContextRun): void {
    run.sealed = true;
    if (!run.controller.signal.aborted) run.controller.abort();
  }

  private acquire(): Promise<boolean> {
    return this.slots.acquire();
  }

  private release(): void {
    this.slots.release();
  }

  /** Stop only owned fork children; an in-flight vendor fetch has no child process to leak. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    // Refuse every waiter so a queued refresh resolves as refused rather than
    // holding the process open on a promise nothing will ever settle.
    this.slots.close();
    // Seal FIRST: an in-flight run must not be able to write a result after
    // shutdown has begun, and abort is what actually stops its vendor calls.
    const running = [...this.runs.values()];
    for (const run of running) this.seal(run);
    await Promise.allSettled([...this.activeForks].map((fork) => fork.stop()));
    this.activeForks.clear();
    // Then wait for the work itself, so the process does not exit with a run
    // still touching the store.
    await Promise.allSettled(running.map((run) => run.done));
    this.runs.clear();
  }

  /** Persist the intent before launching third-party work, then return quickly. */
  async start(reportId: string, report: Report, runForkScenarios = false): Promise<void> {
    // A previous run for this same report id loses its write rights here, not
    // when it happens to finish.
    const previous = this.runs.get(reportId);
    if (previous) this.seal(previous);

    const run: AssetContextRun = {
      runId: randomUUID(),
      reportId,
      controller: new AbortController(),
      sealed: false,
      done: Promise.resolve(),
    };
    this.runs.set(reportId, run);

    const pending = pendingAssetContext(reportId, report, runForkScenarios);
    await this.saveFrom(run, { ...pending, runId: run.runId });

    // The manager only waits for the durable pending marker, never for Mobula.
    // SIGTERM can therefore finish promptly; boot recovery turns this marker
    // into an explicit unavailable result if the process ended mid-refresh.
    run.done = this.runBounded(run, report, pending)
      .catch(async (err: unknown) => {
        // The supervisor's own terminal write. It seals FIRST so the losing side
        // of any race can no longer reach the store, then writes past the guard
        // deliberately — this record is the one that must survive.
        this.seal(run);
        try {
          if (this.runs.get(reportId)?.runId !== run.runId) return;
          // Written through the STORE, not `saveFrom`: the run is sealed by the
          // line above, which is exactly the point — this record has to land
          // after the seal, and nothing from the sealed run may land after it.
          await this.store.saveAssetContext(reportId, {
            ...pending,
            runId: run.runId,
            completedAt: new Date().toISOString(),
            status: "unavailable",
            forkScenarios: pending.forkScenarios.requested
              ? { ...pending.forkScenarios, status: "unavailable", note: "Asset discovery or verification did not complete, so no candidate fork scenario could run." }
              : pending.forkScenarios,
            notes: [`Unexpected post-analysis asset-context failure: ${sanitize(err)}`],
          });
        } catch (writeErr) {
          console.error(`[ripcord] could not persist failed asset context: ${sanitize(writeErr)}`);
        }
      })
      .finally(() => {
        // A long-lived deployment may produce thousands of reports. Keeping a
        // settled controller and promise for every one grows this map forever
        // and makes shutdown revisit work that ended hours ago. Delete only if
        // this is still the registered generation; a newer run with the same
        // report id must retain its write rights.
        if (this.runs.get(reportId)?.runId === run.runId) this.runs.delete(reportId);
      });
    void run.done;
  }

  /**
   * Applies the concurrency slot and the wall-clock ceiling around one refresh.
   *
   * The deadline is enforced in two places on purpose: `complete` hands the
   * remaining budget to the fork batch so it can stop cooperatively and keep
   * the evidence it already gathered, and this race is the backstop for
   * anything that cannot be interrupted. Both write a sidecar; neither leaves
   * a `pending` behind.
   */
  private async runBounded(run: AssetContextRun, report: Report, pending: AssetContextArtifact): Promise<void> {
    if (!(await this.acquire())) {
      this.seal(run);
      if (this.runs.get(run.reportId)?.runId !== run.runId) return;
      await this.store.saveAssetContext(run.reportId, {
        ...pending,
        runId: run.runId,
        completedAt: new Date().toISOString(),
        status: "unavailable",
        forkScenarios: pending.forkScenarios.requested
          ? { ...pending.forkScenarios, status: "unavailable", note: "The post-analysis queue was full, so no candidate fork scenario was started." }
          : pending.forkScenarios,
        notes: [
          this.shuttingDown
            ? "The service began shutting down before this asset-context refresh could start."
            : `Too many post-analysis refreshes were already queued (limit ${this.config.maxQueuedAssetContexts}), so this one was refused rather than queued without bound. Re-running the analysis will retry it.`,
        ],
      });
      return;
    }
    const deadlineAt = Date.now() + this.config.assetContextTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Kept so the slot can be released only once this has actually settled.
    // `Promise.race` alone releases the slot while the loser keeps running,
    // which makes `maxActiveAssetContexts` a limit on wrappers rather than on
    // work — and lets the loser write over the terminal record afterwards.
    const work = this.complete(run, report, pending, deadlineAt);
    // Its rejection is handled below; this stops an unhandled rejection if the
    // expiry wins the race first.
    work.catch(() => {});
    try {
      const expiry = new Promise<never>((_, rejectRun) => {
        timer = setTimeout(() => {
          // SEAL BEFORE REJECTING. From this instant the losing side cannot
          // reach the store, so the terminal timeout record is the last word
          // whatever order the remaining awaits unwind in.
          this.seal(run);
          rejectRun(new Error(`the post-analysis refresh exceeded its ${Math.round(this.config.assetContextTimeoutMs / 1000)}s limit`));
        }, this.config.assetContextTimeoutMs);
        timer.unref?.();
      });
      await Promise.race([work, expiry]);
    } finally {
      if (timer) clearTimeout(timer);
      // The abort has been delivered; wait for the work to unwind before the
      // slot is handed to somebody else. A run that ignores its signal would
      // otherwise still be talking to a vendor while a new fork starts.
      //
      // Bounded, and the bound is a liveness decision rather than a correctness
      // one: the run is SEALED, so it can never write whatever it does next.
      // Holding the slot forever on an unabortable hang would wedge the queue,
      // so after the grace period the slot is returned and the drift is logged
      // loudly instead of being absorbed silently.
      let grace: ReturnType<typeof setTimeout> | undefined;
      const settled = await Promise.race([
        work.then(() => true, () => true),
        new Promise<boolean>((r) => {
          grace = setTimeout(() => r(false), this.settleGraceMs);
          grace.unref?.();
        }),
      ]);
      clearTimeout(grace);
      if (!settled) {
        console.error(
          `[ripcord] asset context ${run.reportId} did not stop within ${this.settleGraceMs}ms of being cancelled; ` +
            "its slot is being returned and it remains sealed, so it can no longer write a result",
        );
      }
      this.release();
    }
  }

  private async complete(run: AssetContextRun, report: Report, pending: AssetContextArtifact, deadlineAt: number): Promise<void> {
    const signal = run.controller.signal;
    /** Every phase boundary asks the same question: is this run still the one that matters? */
    const abandoned = () => signal.aborted || run.sealed || this.runs.get(run.reportId)?.runId !== run.runId;
    const rpcUrl = this.config.rpcUrls.get(report.chainId);
    const blockHash = pending.block.hash;
    if (!rpcUrl || !blockHash) {
      await this.saveFrom(run, {
        ...pending,
        completedAt: new Date().toISOString(),
        status: "unavailable",
        forkScenarios: pending.forkScenarios.requested
          ? { ...pending.forkScenarios, status: "unavailable", note: "A pinned RPC endpoint and block hash are required before candidate fork scenarios can run." }
          : pending.forkScenarios,
        notes: [
          !rpcUrl
            ? "No RPC endpoint was configured for the analysed chain, so Mobula candidates could not be verified."
            : "The report has no usable block hash, so candidate verification was refused rather than attached to an ambiguous block.",
        ],
      });
      return;
    }

    let exposure: LiveExposure;
    try {
      exposure = await buildLiveExposure(report.target.address, report.chainId, { signal });
      // Remote logos are presentation metadata and must not turn opening a
      // stored report into a third-party request. The React coverage panel does
      // not render them; removing them here also prevents future accidental use.
      exposure = { ...exposure, holdings: exposure.holdings.map((holding) => ({ ...holding, logo: null })) };
    } catch (err) {
      await this.saveFrom(run, {
        ...pending,
        completedAt: new Date().toISOString(),
        status: "unavailable",
        forkScenarios: pending.forkScenarios.requested
          ? { ...pending.forkScenarios, status: "unavailable", note: "Candidate discovery failed, so no candidate fork scenario could run." }
          : pending.forkScenarios,
        notes: [`Mobula refresh failed: ${sanitize(err)}`],
      });
      return;
    }

    if (exposure.status !== "ok") {
      await this.saveFrom(run, {
        ...pending,
        completedAt: new Date().toISOString(),
        status: "unavailable",
        exposure,
        forkScenarios: pending.forkScenarios.requested
          ? { ...pending.forkScenarios, status: "unavailable", note: "Candidate discovery was unavailable, so no candidate fork scenario could run." }
          : pending.forkScenarios,
        counts: { ...emptyCounts(), displayed: exposure.holdings.length },
        notes: [
          `Mobula refresh was unavailable: ${exposure.reason ?? "no reason returned"}. No candidate verification was attempted.`,
        ],
      });
      return;
    }

    // Phase gate: a cancelled run stops here rather than opening an RPC client
    // and spending a provider's budget on a result nobody will accept.
    if (abandoned()) return;

    const chain = new PinnedChain({
      chainId: report.chainId,
      rpcUrl,
      blockNumber: BigInt(report.block.number),
      cacheDir: resolve(this.store.cacheDir, blockHash),
      cacheEnabled: true,
    });

    try {
      const before = await chain.getBlockHash();
      if (before.toLowerCase() !== blockHash.toLowerCase()) {
        throw new Error("the pinned block hash no longer matches the report");
      }
      if (abandoned()) return;
      const selection = selectMobulaCandidates(exposure, report.chainId);
      const candidates = await verifyDisplayedCandidates(
        chain,
        getAddress(report.target.address) as Hex,
        exposure,
        report.chainId,
        report.block.number,
      );
      const after = await chain.getBlockHash();
      if (after.toLowerCase() !== blockHash.toLowerCase()) {
        throw new Error("the pinned block identity changed during candidate verification");
      }

      const verified = candidates.filter((candidate) =>
        candidate.state === "verified_nonzero" || candidate.state === "verified_zero",
      ).length;
      const failed = candidates.length - verified;
      const verifiedContext: AssetContextArtifact = {
        ...pending,
        completedAt: new Date().toISOString(),
        status: failed === 0 ? "complete" : "partial",
        exposure,
        candidates,
        candidateSelection: {
          proposed: selection.proposed,
          cap: assetScenarioCandidateCap,
          withheld: selection.withheld,
        },
        counts: {
          displayed: exposure.holdings.length,
          eligible: candidates.length,
          verified,
          failed,
        },
        notes: [
          `Mobula proposed identities from its complete fresh holdings response. Ripcord independently selected and verified up to ${assetScenarioCandidateCap} unique same-chain ERC20 candidates at the report's pinned block; UI display floors and caps do not control discovery.`,
          "This sidecar can expand asset coverage, but it cannot change the report, its verdict, or any fork-experiment claim.",
          selection.withheld.length === 0
            ? "No proposed identity was withheld from pinned candidate verification."
            : `Candidate verification withheld: ${selection.withheld.map((item) => `${item.count} ${item.reason.replaceAll("_", " ")}`).join(", ")}.`,
        ],
      };
      // Publish the completed balance pass before starting the slower fork so
      // the UI can show useful evidence while the scenario batch is pending.
      if (!(await this.saveFrom(run, verifiedContext))) return;
      if (!pending.forkScenarios.requested || abandoned()) return;

      if (report.exitRestriction?.exitAction.interfaceName !== "compound-comet-base") {
        await this.saveFrom(run, {
          ...verifiedContext,
          forkScenarios: {
            requested: true,
            status: "unavailable",
            batch: null,
            note: "No supported Compound III exit interface was established by the primary report, so per-asset fork calls were refused rather than guessed.",
          },
        });
        return;
      }

      const assets = candidates
        // A zero target balance can still be registered collateral and is
        // precisely the newly-added-market case the old Comet-funding setup
        // could never test. The fork now seeds an isolated holder directly.
        .filter((candidate) =>
          (candidate.state === "verified_nonzero" || candidate.state === "verified_zero") &&
          candidate.balanceRaw !== null,
        )
        .map((candidate) => ({ address: getAddress(candidate.address) as Hex, balanceRaw: candidate.balanceRaw as string }));
      // Last gate before an anvil process is spawned. A run that has already
      // been given up on must never start one.
      if (abandoned()) return;
      try {
        const scenarioBatch = await runAssetExitScenarios({
          chainId: report.chainId,
          rpcUrl,
          blockNumber: BigInt(report.block.number),
          expectedBlockHash: blockHash as Hex,
          target: getAddress(report.target.address) as Hex,
          assets,
          // Whatever is left of this refresh's budget. The batch stops
          // cooperatively at a candidate boundary and keeps the evidence it
          // already has, rather than being killed mid-differential.
          deadlineAt,
          signal,
        }, {
          onForkStarted: (fork) => this.activeForks.add(fork),
          onForkStopped: (fork) => this.activeForks.delete(fork),
        });
        await this.saveFrom(run, {
          ...verifiedContext,
          forkScenarios: {
            requested: true,
            status: scenarioBatch.status,
            batch: scenarioBatch,
            note: scenarioBatch.notes.join(" "),
          },
        });
      } catch (err) {
        await this.saveFrom(run, {
          ...verifiedContext,
          forkScenarios: {
            requested: true,
            status: "unavailable",
            batch: null,
            note: `Candidate fork scenarios failed as infrastructure work: ${sanitize(err)}`,
          },
        });
      }
    } catch (err) {
      await this.saveFrom(run, {
        ...pending,
        completedAt: new Date().toISOString(),
        status: "unavailable",
        exposure,
        forkScenarios: pending.forkScenarios.requested
          ? { ...pending.forkScenarios, status: "unavailable", note: "Pinned balance verification failed before candidate fork scenarios could begin." }
          : pending.forkScenarios,
        notes: [`Pinned candidate verification was refused or failed: ${sanitize(err)}`],
      });
    }
  }
}
