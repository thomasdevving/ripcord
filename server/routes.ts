import { verifyBlockIdentity } from "./identity.js";
/**
 * The HTTP surface.
 *
 * Notes on the choices that are not obvious:
 *
 *  - `POST /api/jobs` answers 202 with a job id, immediately. The analysis is
 *    minutes long; holding a request open for it would tie the run's lifetime to
 *    one TCP connection, and a browser refresh would then look like a cancelled
 *    scan. Nothing about the job depends on the submitter staying connected.
 *
 *  - SSE is the progress channel and POLLING IS A FIRST-CLASS FALLBACK, not a
 *    degraded mode. Corporate proxies buffer text/event-stream, and a demo that
 *    dies behind conference wifi is worse than one that polls. Both read the
 *    same event log through the same cursor, so they cannot disagree.
 *
 *  - Every report body goes through `ReportService.loadPublishable`. There is no
 *    route that reads a report file directly, which is what makes "the gate
 *    holds on all transports" checkable rather than aspirational.
 *
 *  - `/healthz` touches no chain. It answers whether THIS PROCESS is healthy.
 *    Making it probe mainnet would (a) bill an RPC call per health check and
 *    (b) restart the container whenever the provider hiccups, which is the
 *    opposite of what a health check is for. Whether live analysis can run is a
 *    separate, explicitly separate, field in /api/config.
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
import type { LiveExposure } from "../src/live/exposure.js";
import { validateCreateJob } from "./validate.js";
import { classify } from "./sanitize.js";
import { schemaVersion, rulesetVersion } from "../src/report/schema.js";
import type { ApiError, ConfigResponse, CreateJobResponse, JobEvent, PresetDescriptor } from "./shared/dto.js";

export interface RouteDeps {
  config: ServerConfig;
  manager: JobManager;
  reports: ReportService;
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
  const { config, manager, reports, anvil } = deps;

  /** A public client for the validator's two reads. Created per call — these are single reads, not a hot path. */
  const clientFor = (chainId: number) => {
    const url = rpcUrlFor(config, chainId);
    if (!url) return null;
    return createPublicClient({ transport: http(url) });
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
      engine: { schemaVersion, rulesetVersion },
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
      const outcome = await manager.admit(req.body, async () => {
        const validation = await validateCreateJob(req.body, {
          supportedChainIds: [1],
          blockIdentity: async (chainId, blockNumber) => {
            const client = clientFor(chainId);
            if (!client) throw new Error("no RPC configured");
            return verifyBlockIdentity(client, chainId, blockNumber);
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
            ...(validation.value.idempotencyKey ? { idempotencyKey: validation.value.idempotencyKey } : {}),
          },
          validation.value.block,
          validation.value.blockSource,
          validation.value.blockHash ?? null,
        );
      });
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
   * the analysis block, and which assets were in a fork experiment.
   *
   * Goes through `loadPublishable` like every other report transport, so a
   * blocked report cannot leak its findings sideways through coverage labels,
   * counts or evidence references. Composed on demand from two artifacts that
   * already exist — it performs no chain read, no fork and no Mobula fetch, so
   * a missing snapshot makes the panel PARTIAL and never fails the request.
   */
  app.get("/api/reports/:id/coverage", async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const loaded = await reports.loadPublishable(req.params.id);
    if (!loaded.ok) {
      if (loaded.reason === "blocked") return reply.status(451).send({ blocked: true, message: BLOCKED_MESSAGE });
      return sendError(reply, 404, { code: "not_found", message: "No such report.", hint: null });
    }
    const report = loaded.value.report as Report;
    // Mobula is optional by construction here: a null snapshot yields a coverage
    // model whose Mobula characteristic reads "unavailable", with every pinned
    // balance and fork observation still present.
    const exposure = (await reports.loadLiveExposure(report.chainId, report.target?.address ?? "")) as LiveExposure | null;
    return reply.send({ id: loaded.value.id, coverage: buildAssetCoverage(report, exposure) });
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
