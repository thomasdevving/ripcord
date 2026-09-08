import { verifyBlockIdentity } from "./identity.js";
/**
 * The HTTP surface. The choices that are not obvious:
 *
 *  - `POST /api/jobs` answers 202 with a job id immediately. The analysis is
 *    minutes long, and holding a request open would tie the run's lifetime to
 *    one TCP connection, so a browser refresh would look like a cancelled scan.
 *  - SSE is the progress channel and POLLING IS A FIRST-CLASS FALLBACK, not a
 *    degraded mode: corporate proxies buffer text/event-stream. Both read the
 *    same event log through the same cursor, so they cannot disagree.
 *  - Every report body goes through `ReportService.loadPublishable`; no route
 *    reads a report file directly.
 *  - `/healthz` touches no chain — it answers whether THIS PROCESS is healthy.
 *    Probing mainnet would bill an RPC call per check and restart the container
 *    whenever the provider hiccups. Whether live analysis can run is a separate
 *    field in /api/config.
 */
import { reportStructure } from "./report-structure.js";
import type { Report } from "../src/report/schema.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createPublicClient, http } from "viem";
import type { ServerConfig } from "./config.js";
import { availableModes, liveRunsBlockedReason, providerHostFor, rpcUrlFor } from "./config.js";
import { JobManager, QueueFullError, IdempotencyConflictError, SubmissionRateError } from "./jobs/manager.js";
import { ReportService, BLOCKED_MESSAGE } from "./reports.js";
import { buildAssetCoverage } from "./coverage.js";
import { buildEnrichedAssessment } from "./enriched.js";
import type { LiveExposure } from "../src/live/exposure.js";
import { validateCreateJob } from "./validate.js";
import { classify } from "./sanitize.js";
import { schemaVersion, rulesetVersion } from "../src/report/schema.js";
import { selectorAnalyzer } from "../src/detect/dispatcher.js";
import { buildEvidenceIndex } from "../src/report/evidenceIndex.js";
import type { ApiError, ConfigResponse, CreateJobRequest, CreateJobResponse, JobEvent, PresetDescriptor } from "./shared/dto.js";
import { ProtocolStore, validateProtocolInput } from "./protocol-store.js";
import { ProtocolService } from "./protocol-service.js";

export interface RouteDeps {
  config: ServerConfig;
  manager: JobManager;
  reports: ReportService;
  protocolStore: ProtocolStore;
  anvil: { available: boolean; version: string | null };
}

/**
 * Presets fill the form in. They carry a REASON TO LOOK, never an expected
 * result: no verdict, no party, no figure. Hardcoding an outcome beside an input
 * turns the demo into a recording, and the first thing a technical reviewer does
 * is check whether what appeared on screen actually came from the run.
 */
function presets(defaultBlock: bigint): PresetDescriptor[] {
  return [
    {
      id: "comet",
      label: "Compound III (Comet) cUSDCv3",
      address: "0xc3d688B66703497DAA19211EEdff47f25384cdc3",
      chainId: 1,
      block: defaultBlock.toString(),
      note: "An upgrade path behind a timelock, and a separate pause path. The withdrawal experiment tests whether the delay on one protects the other.",
      suggestedMode: "scan_withdrawal_test",
    },
    {
      id: "weth9",
      label: "WETH9",
      address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      chainId: 1,
      block: defaultBlock.toString(),
      note: "No owner, no roles, no proxy. A control case for what a scan looks like when there is no privileged party to find.",
      suggestedMode: "scan",
    },
  ];
}

const sendError = (reply: FastifyReply, status: number, error: ApiError): FastifyReply => reply.status(status).send({ error });

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { config, manager, reports, protocolStore, anvil } = deps;
  const protocols = new ProtocolService(protocolStore, manager, reports);

  /** A public client for the validator's two reads. Created per call — these are single reads, not a hot path. */
  const clientFor = (chainId: number) => {
    const url = rpcUrlFor(config, chainId);
    if (!url) return null;
    return createPublicClient({ transport: http(url) });
  };

  /** One admission path for the single-address form and protocol batches. */
  const submitJob = (raw: CreateJobRequest, expectedBlockHash: string | null = null) => manager.admit(raw, async () => {
    const validation = await validateCreateJob(raw, {
      supportedChainIds: [1],
      blockIdentity: async (chainId, blockNumber) => {
        const client = clientFor(chainId);
        if (!client) throw new Error("no RPC configured");
        return verifyBlockIdentity(client, chainId, blockNumber, expectedBlockHash);
      },
      availableModes: availableModes(config, anvil.available),
      resolveLatestBlock: async chainId => {
        const client = clientFor(chainId);
        if (!client) throw new Error("no RPC configured for this chain");
        return client.getBlockNumber();
      },
      codeSizeAt: async (chainId, address, block) => {
        const client = clientFor(chainId);
        if (!client) throw new Error("no RPC configured for this chain");
        const code = await client.getCode({ address: address as `0x${string}`, blockNumber: block });
        return code && code !== "0x" ? (code.length - 2) / 2 : 0;
      },
    });
    if (!validation.ok) throw new RequestValidationError(validation.error);
    return manager.createJob(
      {
        address: validation.value.address,
        chainId: validation.value.chainId,
        block: validation.value.blockSource === "resolved_latest" ? "latest" : validation.value.block.toString(),
        ...(validation.value.controlToken ? { controlToken: validation.value.controlToken } : {}),
        mode: validation.value.mode,
        refreshAssetContext: validation.value.refreshAssetContext,
        ...(validation.value.idempotencyKey ? { idempotencyKey: validation.value.idempotencyKey } : {}),
      },
      validation.value.block,
      validation.value.blockSource,
      validation.value.blockHash ?? null,
    );
  });

  /** Serialises batch admission per protocol, including simultaneous HTTP retries. */
  const protocolAdmissionTails = new Map<string, Promise<void>>();
  const withProtocolAdmission = async <T>(protocolId: string, task: () => Promise<T>): Promise<T> => {
    const previous = protocolAdmissionTails.get(protocolId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    const tail = previous.catch(() => undefined).then(() => gate);
    protocolAdmissionTails.set(protocolId, tail);
    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (protocolAdmissionTails.get(protocolId) === tail) protocolAdmissionTails.delete(protocolId);
    }
  };

  // --- health ---------------------------------------------------------------

  app.get("/healthz", async (_req, reply) => {
    // Cheap and chain-free ON PURPOSE. See the module comment.
    const writable = await manager.stats();
    return reply.send({ status: "ok", jobs: writable, uptimeSeconds: Math.round(process.uptime()) });
  });

  // --- config ---------------------------------------------------------------

  app.get("/api/config", async (_req, reply) => {
    const blockedReason = liveRunsBlockedReason(config);
    const body: ConfigResponse = {
      liveRuns: { enabled: blockedReason === null, reason: blockedReason },
      availableModes: availableModes(config, anvil.available),
      supportedChains: [{ id: 1, name: "Ethereum Mainnet", hasRpc: config.rpcUrls.has(1) }],
      defaultBlock: config.defaultBlock.toString(),
      limits: { maxActiveJobs: config.maxActiveJobs, maxQueuedJobs: config.maxQueuedJobs, jobTimeoutMs: config.jobTimeoutMs },
      // HOST ONLY. The full URL is the API key on every mainstream provider.
      providerHost: providerHostFor(config, 1),
      anvil,
      presets: presets(config.defaultBlock),
      engine: { schemaVersion, rulesetVersion, selectorAnalyzer },
    };
    return reply.send(body);
  });

  // --- jobs -----------------------------------------------------------------

  app.post("/api/jobs", async (req: FastifyRequest, reply) => {
    const blockedReason = liveRunsBlockedReason(config);
    if (blockedReason) {
      return sendError(reply, 503, {
        code: config.enableLiveRuns ? "rpc_unconfigured" : "live_runs_disabled",
        message: blockedReason,
        hint: "Saved reports are still fully readable.",
      });
    }

    try {
      const outcome = await submitJob(req.body as CreateJobRequest);
      const body: CreateJobResponse = {
        jobId: outcome.record.jobId,
        // Only its hash is stored. A retry recovers a supplied client capability.
        controlToken: outcome.controlToken,
        state: outcome.record.state,
        queuePosition: manager.toSummary(outcome.record).queuePosition,
        deduplicated: outcome.deduplicated,
      };
      return reply.status(202).send(body);
    } catch (err) {
      if (err instanceof IdempotencyConflictError) return sendError(reply, 409, { code: "idempotency_conflict", message: err.message, hint: "Use a new key for a different analysis." });
      if (err instanceof SubmissionRateError) return sendError(reply, 429, { code: "submission_rate_limited", message: err.message, hint: "Existing analyses continue; this deployment admits at most 12 new requests per minute." });
      if (err instanceof RequestValidationError) return sendError(reply, err.api.code === "no_contract_code" ? 422 : 400, err.api);
      if (err instanceof QueueFullError) {
        return sendError(reply, 429, {
          code: "queue_full",
          message: `The analysis queue is full (${err.queued} of ${err.max} waiting).`,
          hint: "One analysis runs at a time so results stay reproducible. Try again shortly.",
        });
      }
      return sendError(reply, 500, classify(err));
    }
  });

  app.get("/api/jobs/:id", async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const record = await manager.getRecord(req.params.id);
    if (!record) return sendError(reply, 404, { code: "not_found", message: "No such analysis.", hint: null });
    return reply.send(manager.toSummary(record));
  });

  /**
   * Polling fallback. Same cursor semantics as SSE, same event log.
   *
   * `truncated` is surfaced rather than hidden: a client whose cursor fell off
   * the retained history must re-take a snapshot, because silently returning
   * only the surviving tail would render as a timeline in which the missing
   * events simply never happened.
   */
  app.get("/api/jobs/:id/events/poll", async (req: FastifyRequest<{ Params: { id: string }; Querystring: { after?: string } }>, reply) => {
    const record = await manager.getRecord(req.params.id);
    if (!record) return sendError(reply, 404, { code: "not_found", message: "No such analysis.", hint: null });
    const after = Number(req.query.after ?? 0);
    const { events, truncated } = manager.eventsSince(req.params.id, Number.isFinite(after) ? after : 0);
    return reply.send({ events, truncated, summary: manager.toSummary(record) });
  });

  app.get("/api/jobs/:id/events", async (req: FastifyRequest<{ Params: { id: string }; Headers: { "last-event-id"?: string } }>, reply) => {
    const jobId = req.params.id;
    const record = await manager.getRecord(jobId);
    if (!record) return sendError(reply, 404, { code: "not_found", message: "No such analysis.", hint: null });

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Nginx and several platform proxies buffer event streams by default,
      // which turns a live timeline into one burst at the end.
      "X-Accel-Buffering": "no",
    });

    const write = (event: JobEvent) => {
      // `id:` is the resume cursor the browser sends back as Last-Event-ID.
      reply.raw.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    // Resume from the client's cursor, from either the standard header or the
    // query parameter (EventSource cannot set headers on first connect).
    const headerCursor = Number(req.headers["last-event-id"] ?? 0);
    const queryCursor = Number((req.query as { after?: string } | undefined)?.after ?? 0);
    const cursor = Math.max(Number.isFinite(headerCursor) ? headerCursor : 0, Number.isFinite(queryCursor) ? queryCursor : 0);

    const { events, truncated } = manager.eventsSince(jobId, cursor);
    if (truncated) {
      // The cursor is older than the retained history. Rather than send a
      // partial tail the client would render as a complete story, tell it to
      // re-snapshot from /api/jobs/:id.
      reply.raw.write(`event: resync\ndata: ${JSON.stringify({ reason: "cursor older than retained history" })}\n\n`);
    }
    for (const event of events) write(event);

    const unsubscribe = manager.subscribe(jobId, write);
    // A comment frame every 15s keeps intermediaries from timing the
    // connection out during the long, quiet phases (a role reconstruction on a
    // range-capped provider is minutes with nothing to say).
    const heartbeat = setInterval(() => reply.raw.write(`event: heartbeat\ndata: {}\n\n`), 15_000);

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    // A closed browser tab detaches the LISTENER ONLY. The job keeps running:
    // a disconnected consumer must never be able to change an analysis outcome.
    req.raw.on("close", cleanup);
    req.raw.on("error", cleanup);
    return reply;
  });

  app.post("/api/jobs/:id/cancel", async (req: FastifyRequest<{ Params: { id: string }; Body: { controlToken?: string } }>, reply) => {
    const token = req.body?.controlToken;
    if (typeof token !== "string" || token.length === 0) {
      return sendError(reply, 403, {
        code: "forbidden",
        message: "Cancelling requires the control token issued when the analysis was started.",
        // Stated plainly because it is a design decision a reviewer may query.
        hint: "A job id appears in shareable links, so it cannot be what authorises cancellation.",
      });
    }
    const outcome = await manager.cancel(req.params.id, token);
    if (outcome === "not_found") return sendError(reply, 404, { code: "not_found", message: "No such analysis.", hint: null });
    if (outcome === "forbidden") return sendError(reply, 403, { code: "forbidden", message: "That control token does not match this analysis.", hint: null });
    if (outcome === "already_finished") return reply.status(409).send({ status: "already_finished" });
    return reply.send({ status: "cancelled" });
  });

  // --- protocols ------------------------------------------------------------

  app.get("/api/protocols", async (_req, reply) => {
    return reply.send({ protocols: await protocols.list() });
  });

  app.post("/api/protocols", async (req: FastifyRequest, reply) => {
    const parsed = validateProtocolInput(req.body);
    if (!parsed.ok) {
      return sendError(reply, 400, { code: "invalid_protocol", message: parsed.message, hint: null });
    }
    try {
      const protocol = await protocolStore.createProtocol(parsed.name, parsed.targets);
      return reply.status(201).send({ protocol });
    } catch (error) {
      return sendError(reply, 500, classify(error));
    }
  });

  app.get("/api/protocols/:id", async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const protocol = await protocolStore.getProtocol(req.params.id);
    if (!protocol) return sendError(reply, 404, { code: "not_found", message: "No such protocol.", hint: null });
    return reply.send(await protocols.detail(protocol));
  });

  app.post(
    "/api/protocols/:id/scans",
    async (req: FastifyRequest<{ Params: { id: string }; Body: { idempotencyKey?: string } }>, reply) => {
      const protocol = await protocolStore.getProtocol(req.params.id);
      if (!protocol) return sendError(reply, 404, { code: "not_found", message: "No such protocol.", hint: null });

      const blockedReason = liveRunsBlockedReason(config);
      if (blockedReason) {
        return sendError(reply, 503, {
          code: config.enableLiveRuns ? "rpc_unconfigured" : "live_runs_disabled",
          message: blockedReason,
          hint: "Existing protocol scans remain readable.",
        });
      }

      const key = typeof req.body?.idempotencyKey === "string" && /^[A-Za-z0-9_-]{8,40}$/.test(req.body.idempotencyKey)
        ? req.body.idempotencyKey
        : null;
      if (!key) return sendError(reply, 400, { code: "invalid_protocol", message: "A valid scan idempotency key is required.", hint: null });

      return withProtocolAdmission(protocol.id, async () => {
        // Re-read inside the serial section. Two simultaneous retries otherwise
        // both observe "not found" before either has written the batch record.
        const duplicate = await protocolStore.findScanByIdempotencyKey(protocol.id, key);
        if (duplicate) return reply.status(202).send({ scan: await protocols.viewScan(protocol, duplicate) });

        const existing = await protocols.detail(protocol);
        if (existing.scans.some((scan) => scan.state === "queued" || scan.state === "running")) {
          return sendError(reply, 409, {
            code: "idempotency_conflict",
            message: "This protocol already has a scan in progress.",
            hint: "Wait for it to finish before establishing another point in the timeline.",
          });
        }

        const capacity = config.maxActiveJobs + config.maxQueuedJobs;
        const usage = manager.stats();
        if (protocol.targets.length > capacity - usage.active - usage.queued) {
          return sendError(reply, 429, {
            code: "queue_full",
            message: `The queue does not have ${protocol.targets.length} free slots for this complete protocol scan.`,
            hint: "Wait for existing analyses to finish. No partial protocol scan was started.",
          });
        }

      // Resolve latest once for the WHOLE protocol. Resolving per target would
      // let a busy batch straddle several blocks and make its own baseline
      // internally inconsistent before comparison even begins.
        let block: bigint;
        let blockHash: string;
        try {
          const client = clientFor(1);
          if (!client) throw new Error("no RPC configured for this chain");
          block = await client.getBlockNumber();
          blockHash = await verifyBlockIdentity(client, 1, block);
        } catch (error) {
          return sendError(reply, 503, classify(error));
        }

        const created = await protocolStore.createScan(protocol, key);
        if (created.deduplicated) return reply.status(202).send({ scan: await protocols.viewScan(protocol, created.scan) });

        for (const target of protocol.targets) {
          try {
            const outcome = await submitJob({
              address: target.address,
              chainId: target.chainId,
              block: block.toString(),
              mode: "scan",
              refreshAssetContext: false,
              idempotencyKey: `${key}_${target.id}`,
            }, blockHash);
            await protocolStore.saveScanTarget(created.scan, { targetId: target.id, jobId: outcome.record.jobId, submissionError: null });
          } catch (error) {
            await protocolStore.saveScanTarget(created.scan, { targetId: target.id, jobId: null, submissionError: publicSubmissionError(error) });
          }
        }

        return reply.status(202).send({ scan: await protocols.viewScan(protocol, created.scan) });
      });
    },
  );

  // --- reports --------------------------------------------------------------

  app.get("/api/reports", async (_req, reply) => {
    return reply.send({ reports: await reports.listPublishable() });
  });

  app.get("/api/reports/:id", async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const loaded = await reports.loadPublishable(req.params.id);
    if (!loaded.ok) {
      if (loaded.reason === "blocked") {
        // 451 is the honest status: the content exists and is withheld for
        // legal/ethical reasons, which is exactly the disclosure gate's case.
        return reply.status(451).send({ blocked: true, message: BLOCKED_MESSAGE });
      }
      return sendError(reply, 404, { code: "not_found", message: "No such report.", hint: null });
    }
    return reply.send({ id: loaded.value.id, origin: loaded.value.origin, report: loaded.value.report, structure: reportStructure(loaded.value.report as Report) });
  });

  /**
   * Asset coverage: which assets were observed, which balances were verified at
   * the analysis block, and which were in a fork experiment. Goes through
   * `loadPublishable` like every other report transport, so a blocked report
   * cannot leak findings sideways through coverage labels or counts. Composed on
   * demand from existing artifacts — no chain read, fork or Mobula fetch — so a
   * missing snapshot makes the panel PARTIAL and never fails the request.
   */
  app.get("/api/reports/:id/coverage", async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const loaded = await reports.loadPublishable(req.params.id);
    if (!loaded.ok) {
      if (loaded.reason === "blocked") return reply.status(451).send({ blocked: true, message: BLOCKED_MESSAGE });
      return sendError(reply, 404, { code: "not_found", message: "No such report.", hint: null });
    }
    const report = loaded.value.report as Report;
    const requested = loaded.value.origin === "live" && await reports.assetContextRequested(loaded.value.id);
    const assetContext = loaded.value.origin === "live" ? await reports.loadAssetContext(loaded.value.id) : null;
    const committed = (await reports.loadLiveExposure(report.chainId, report.target?.address ?? "")) as LiveExposure | null;
    // While a requested refresh is pending the timestamped committed snapshot
    // may still be shown. Once it completes, its fresh result is authoritative
    // for this run; an unavailable refresh is not silently replaced by old data.
    const exposure = assetContext?.status === "pending"
      ? committed
      : assetContext
        ? assetContext.exposure
        : committed;
    return reply.send({
      id: loaded.value.id,
      coverage: buildAssetCoverage(report, exposure, assetContext, requested),
      // Composed here rather than merged into the report: it is a statement
      // ABOUT the report and the sidecar together, and it must always be
      // readable beside the untouched verdict rather than in place of it.
      enriched: buildEnrichedAssessment(report, assetContext),
    });
  });

  /**
   * EVIDENCE ON DEMAND.
   *
   * The power map inlines a bounded prefix of the reads behind each node
   * (`evidenceInlineLimit`) because a role scan on a range-capped provider names
   * its target in well over a thousand log reads, and shipping those to draw one
   * box is a download rather than a detail view. This is where the rest lives.
   *
   * Behind `loadPublishable` like every other report transport: evidence is the
   * most detailed thing a report holds, and a blocked report must not leak it
   * through a side door that the HTML and JSON routes are gated against.
   */
  app.get("/api/reports/:id/evidence", async (req: FastifyRequest<{ Params: { id: string }; Querystring: { address?: string } }>, reply) => {
    const loaded = await reports.loadPublishable(req.params.id);
    if (!loaded.ok) {
      if (loaded.reason === "blocked") return reply.status(451).send({ blocked: true, message: BLOCKED_MESSAGE });
      return sendError(reply, 404, { code: "not_found", message: "No such report.", hint: null });
    }
    const address = req.query.address;
    if (address !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      return sendError(reply, 400, { code: "invalid_address", message: "address must be a 20-byte hex address.", hint: null });
    }
    const index = buildEvidenceIndex(loaded.value.report);
    const ids = address ? index.idsFor(address) : index.entries.map((e) => e.id);
    return reply.send({
      id: loaded.value.id,
      address: address ?? null,
      total: ids.length,
      // Deduplicated: an entry relevant to several nodes is sent once, and the
      // id is the same stable content hash the graph references.
      evidence: ids.map((entryId) => ({ id: entryId, evidence: index.get(entryId) })),
      distinctInReport: index.stats.distinct,
    });
  });

  app.get("/api/reports/:id/download", async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const loaded = await reports.loadPublishable(req.params.id);
    if (!loaded.ok) {
      if (loaded.reason === "blocked") return reply.status(451).send({ blocked: true, message: BLOCKED_MESSAGE });
      return sendError(reply, 404, { code: "not_found", message: "No such report.", hint: null });
    }
    // loadPublishable checks disclosure and applies the public projection for
    // both routes, including nested errors that can contain a provider URL.
    return reply
      .header("Content-Type", "application/json")
      .header("Content-Disposition", `attachment; filename="ripcord-${loaded.value.id}.json"`)
      .send(loaded.value.report);
  });
}

class RequestValidationError extends Error { constructor(public readonly api: ApiError) { super(api.message); } }

function publicSubmissionError(error: unknown): { message: string; hint: string | null } {
  if (error instanceof RequestValidationError) return { message: error.api.message, hint: error.api.hint };
  if (error instanceof IdempotencyConflictError) return { message: error.message, hint: "Use a new key for a different analysis." };
  if (error instanceof SubmissionRateError) return { message: error.message, hint: "Wait before starting another batch." };
  if (error instanceof QueueFullError) return { message: error.message, hint: "Wait for existing analyses to finish." };
  const safe = classify(error);
  return { message: safe.message, hint: safe.hint };
}
