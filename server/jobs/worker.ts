import { verifyBlockIdentity } from "../identity.js";
/**
 * THE JOB WORKER — a forked child process that runs the real engine.
 *
 * It imports `buildReport`, `runProofEngine`, `runExitRestrictionEngine` and
 * `applyExitRestriction` DIRECTLY. It does not shell out to the CLI and does not
 * parse its human-readable output: those strings are written for a person, and
 * treating them as a protocol makes every wording change a silent breakage.
 *
 * WHY A CHILD PROCESS. A Comet run is minutes of RPC round-trips, an anvil
 * spawn and heavy synchronous bigint work; on the HTTP event loop that stalls
 * SSE heartbeats and /healthz, and a health check timing out mid-demo restarts
 * the container. Isolation also makes a hard kill a real cancellation.
 *
 * WHAT IT REFUSES TO DO: accept an RPC URL, cache path or anvil argument from
 * the HTTP request (all come from server config, so a request cannot point the
 * fork at an arbitrary endpoint); send unsanitised error text to the parent (a
 * viem or anvil failure routinely embeds the full RPC URL, key included); or
 * invent a phase result.
 *
 * ORDER OF WORK matches the CLI's semantics per mode, deliberately:
 * `scan_withdrawal_test` does NOT run the drain proof while
 * `scan_withdrawal_test_upgrade_proof` does, because the CLI's `restrict` is the
 * superset and quiet drift from the documented command is what CALIBRATION.md
 * §11 exists to catch.
 */
import { resolve } from "node:path";
import { createPublicClient, http, type Hex } from "viem";
import { PinnedChain } from "../../src/chain/client.js";
import { buildReport } from "../../src/report/build.js";
import { reportSchema, type Report } from "../../src/report/schema.js";
import { runProofEngine } from "../../src/fork/proofEngine.js";
import { runExitRestrictionEngine } from "../../src/fork/exitRestriction.js";
import { applyExitRestriction } from "../../src/report/applyExitRestriction.js";
import { classify, sanitize, publicValue, rpcSecrets } from "../sanitize.js";
import { TransportObserver } from "./observer.js";
import type { ParentMessage, StartMessage, WorkerEventPayload, WorkerMessage } from "./protocol.js";

function send(message: WorkerMessage): void {
  // `process.send` is absent if this module is ever run standalone. That is a
  // programming error, not a runtime condition — say so rather than proceeding
  // to do minutes of work whose result nobody will receive.
  if (!process.send) throw new Error("worker started without an IPC channel");
  process.send(message);
}

/**
 * Sends a message and RESOLVES ONLY ONCE IT HAS BEEN FLUSHED to the parent.
 *
 * `process.send` is asynchronous: for a payload above the pipe buffer it queues
 * the write and returns immediately, and `process.exit()` discards whatever is
 * still queued. A finished report is several hundred kilobytes, so exiting
 * straight after sending it dropped the result every time — the parent saw a
 * worker that had completed every phase and then died without delivering
 * anything, and reported "stopped unexpectedly" about an analysis that had in
 * fact succeeded. Found by running a real Comet job end to end.
 *
 * Every TERMINAL message goes through here. Progress events do not need it:
 * they are small, and losing the last one to a shutdown costs a frame, not a
 * result.
 */
function sendAndFlush(message: WorkerMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send) {
      reject(new Error("worker started without an IPC channel"));
      return;
    }
    process.send(message, (err: Error | null) => (err ? reject(err) : resolve()));
  });
}

let secrets: string[] = [];
let activeChain: PinnedChain | null = null;
const emit = (payload: WorkerEventPayload): void => {
  send({ type: "event", payload: publicValue(payload, secrets) });
  if (activeChain && payload.type.startsWith("stage.") && payload.type !== "stage.started") send({ type: "event", payload: { type: "runtime.stats", stats: { scanReadOperations: activeChain.networkCallCount, scanCacheHits: activeChain.cacheHitCount } } });
};

/** Cooperative cancellation. The engine has no cancellation token, so we stop at phase boundaries and the parent's SIGTERM covers the rest. */
let cancelled = false;

function throwIfCancelled(): void {
  if (cancelled) {
    const err = new Error("cancelled");
    err.name = "JobCancelledError";
    throw err;
  }
}

async function run(msg: StartMessage): Promise<void> {
  secrets = rpcSecrets([msg.rpcUrl]);
  const target = msg.address as Hex;
  const blockNumber = BigInt(msg.blockNumber);
  const identityClient = createPublicClient({ transport: http(msg.rpcUrl) });
  const verifyIdentity = (expected?: string | null) => verifyBlockIdentity(identityClient, msg.chainId, blockNumber, expected);
  const blockHash = await verifyIdentity(msg.blockHash);

  const chain = new PinnedChain({
    chainId: msg.chainId,
    rpcUrl: msg.rpcUrl,
    blockNumber,
    // Hash namespace prevents cache reuse across a different canonical block.
    // The CLI's internal key format and determinism semantics remain unchanged.
    cacheDir: resolve(msg.cacheDir, blockHash),
    cacheEnabled: true,
  });

  activeChain = chain;
  const observer = new TransportObserver(msg.address, emit);

  emit({ type: "stage.started", phase: "preflight" });
  const { code } = await chain.getCode(target);
  if (!code || code === "0x") {
    // A structural refusal, not an analysis result. Reporting "no capabilities
    // found" for an EOA would be a clean bill of health for something that was
    // never a contract.
    emit({ type: "stage.failed", phase: "preflight", detail: "no contract code at this address at the pinned block" });
    await sendAndFlush({
      type: "failed",
      code: "no_contract_code",
      message: "There is no contract code at this address at the pinned block.",
      hint: "This is an externally owned account, or the contract was deployed after this block. Try a later block, or a contract address.",
    });
    return;
  }
  emit({
    type: "stage.completed",
    phase: "preflight",
    detail: `contract code present (${(code.length - 2) / 2} bytes) at the pinned block`,
    metrics: { bytecodeSize: (code.length - 2) / 2 },
  });

  throwIfCancelled();

  // --- the static scan, always ---------------------------------------------
  emit({ type: "stage.started", phase: "report" });
  const baseReport = await buildReport(chain, target, observer);
  emit({
    type: "stage.completed",
    phase: "report",
    detail: `report composed and schema-validated; publication gate: ${baseReport.disclosure.publishable ? "publishable" : "BLOCKED"}`,
    metrics: {
      publishable: baseReport.disclosure.publishable,
      unknowns: baseReport.unknowns.length,
      errors: baseReport.errors.length,
      enumerationComplete: baseReport.enumeration.complete,
    },
  });

  let report: Report = baseReport;

  // --- optional: the day-3 upgrade drain proof ------------------------------
  if (baseReport.disclosure.publishable && msg.mode === "scan_withdrawal_test_upgrade_proof") {
    throwIfCancelled();
    emit({ type: "stage.started", phase: "upgradeProof" });
    const proof = await runProofEngine({
      chainId: msg.chainId,
      rpcUrl: msg.rpcUrl,
      blockNumber,
      expectedBlockHash: blockHash,
      target,
      proxy: report.proxy,
      authorityResolution: report.authorityResolution,
      exitWindow: report.exitWindow,
      artifactDir: resolve(msg.artifactDir, "proofs"),
    });
    report = reportSchema.parse({ ...report, proof: { ...proof, traceArtifact: proof.traceArtifact ? `proofs/${target}-${blockNumber}/trace.txt` : null } });
    if (proof.produced) {
      emit({
        type: "stage.completed",
        phase: "upgradeProof",
        detail: proof.headline,
        metrics: { produced: true, totalUsd: proof.totalUsd, noticeSeconds: proof.noticeSeconds },
      });
    } else {
      // `produced: false` is an honest outcome about OUR coverage, never a
      // clean bill for the target — the engine's own failureReason says which.
      emit({ type: "stage.inconclusive", phase: "upgradeProof", detail: proof.failureReason ?? "the proof was not produced" });
    }
  }

  // --- optional: the day-7 withdrawal differential --------------------------
  if (baseReport.disclosure.publishable && msg.mode !== "scan") {
    throwIfCancelled();
    const result = await runExitRestrictionEngine({
      chainId: msg.chainId,
      rpcUrl: msg.rpcUrl,
      blockNumber,
      expectedBlockHash: blockHash,
      target,
      capabilities: report.capabilities,
      enumeration: report.enumeration,
      exitWindow: report.exitWindow,
      authorityResolution: report.authorityResolution,
      observer,
    });
    // applyExitRestriction re-composes the verdict. Re-validating here keeps the
    // same invariant the CLI holds: a merged report that fails its own schema is
    // a Ripcord bug and must surface as one, not be shipped to a browser.
    report = reportSchema.parse(applyExitRestriction(report, result));
  }

  await verifyIdentity(blockHash);
  if (report.block.hash !== blockHash) throw new Error("Report block identity could not be verified");
  await sendAndFlush({
    type: "done",
    report: JSON.stringify(publicValue(report, secrets)),
    publishable: report.disclosure.publishable,
    verdictStatus: report.disclosure.publishable ? report.verdict?.status ?? null : null,
    hasExitRestriction: report.exitRestriction !== null,
    generatedAt: report.generatedAt,
    schemaVersion: report.schemaVersion,
    rulesetVersion: report.rulesetVersion,
    blockHash: report.block.hash === "0x" ? null : report.block.hash,
  });
}

process.on("message", (raw: ParentMessage) => {
  if (raw?.type === "cancel") {
    cancelled = true;
    return;
  }
  if (raw?.type !== "start") return;
  run(raw)
    .then(() => process.exit(0))
    .catch(async (err: unknown) => {
      if ((err as Error)?.name === "JobCancelledError") {
        await sendAndFlush({ type: "failed", code: "cancelled", message: "The analysis was cancelled.", hint: null });
        process.exit(0);
        return;
      }
      // classify() decides the product-level code and next step; sanitize()
      // guarantees no RPC URL rides out in the text either way.
      const api = classify(err);
      // Also log the sanitised detail on the worker's own stderr, which the
      // parent forwards to the server log for correlation by job id.
      console.error(`[worker] job failed: ${sanitize(err)}`);
      await sendAndFlush({ type: "failed", code: api.code, message: api.message, hint: api.hint });
      process.exit(1);
    });
});

// A worker with no parent is a leaked process. Exiting on channel loss is what
// guarantees an anvil child cannot outlive the request that started it.
process.on("disconnect", () => {
  // Production workers are group leaders; a lost parent must not orphan anvil.
  if (process.platform !== "win32") { try { process.kill(-process.pid, "SIGTERM"); } catch { /* group already gone */ } }
  process.exit(0);
});
