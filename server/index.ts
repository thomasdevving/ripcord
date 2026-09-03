/**
 * THE PRODUCTION ENTRYPOINT.
 *
 * One process serves the built frontend, the API, the SSE stream and the job
 * runner. One Railway service, one replica, one public port. anvil is spawned
 * transiently by a job worker, binds loopback only, and is never exposed.
 *
 * Startup order is chosen so that a misconfiguration is visible BEFORE the port
 * opens rather than on the first request:
 *   1. config (throws with the variable name on anything invalid)
 *   2. data dir + write probe (a volume mounted for the wrong user fails here,
 *      which is otherwise a very confusing runtime error)
 *   3. interrupted-job recovery (a job that was running at the last shutdown
 *      becomes `interrupted`, never `completed`)
 *   4. anvil probe (its ABSENCE is a supported state: fork modes are simply not
 *      offered, and the scan flow is unaffected)
 *   5. listen
 *
 * A missing RPC is likewise a supported state. The service boots, saved reports
 * stay readable, and /api/config says plainly why Analyze is unavailable — an
 * infrastructure gap must never be presented as a property of a contract.
 */
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, liveRunsBlockedReason, providerHostFor, ConfigError } from "./config.js";
import { JobStore } from "./jobs/store.js";
import { JobManager } from "./jobs/manager.js";
import { ReportService } from "./reports.js";
import { registerRoutes } from "./routes.js";
import { checkAnvilAvailable } from "../src/fork/preflight.js";
import { safeLogValue, rpcSecrets } from "./sanitize.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Locates the compiled worker next to this module.
 *
 * Derived from `import.meta.url` rather than from CWD or an env var: the start
 * script's working directory differs between local dev, the Docker image and a
 * platform's own launcher, and a worker path that is right in only one of them
 * is a deployment that fails exclusively in production.
 */
function resolveWorkerPath(): string {
  const candidate = join(here, "jobs", "worker.js");
  if (!existsSync(candidate)) {
    throw new Error(
      `the compiled job worker was not found at ${candidate}. ` +
        `Run \`pnpm build:server\` before \`pnpm start:webapp\` — the start script runs compiled output, not TypeScript sources.`,
    );
  }
  return candidate;
}

/**
 * Where the built frontend lives, if it was built. Absent in dev, where Vite
 * serves it on its own port.
 *
 * The module-relative candidate comes FIRST and the cwd-relative one last: the
 * working directory differs between `pnpm start:webapp`, the Docker CMD and a
 * platform launcher, so a cwd-only lookup is a deployment that serves the API
 * with no UI in exactly one environment.
 */
function resolveWebDist(explicit: string | null): string | null {
  const candidates = [
    explicit,
    // dist-server/server → repo root → dist-web
    resolve(here, "..", "..", "dist-web"),
    resolve(process.cwd(), "dist-web"),
  ].filter((c): c is string => typeof c === "string");
  return candidates.find((c) => existsSync(join(c, "index.html"))) ?? null;
}

async function main(): Promise<void> {
  // .env is a local convenience only. Its absence is normal in a container,
  // where the platform injects the environment directly.
  try {
    process.loadEnvFile(".env");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const config = loadConfig();

  const store = new JobStore(config.dataDir);
  await store.init();

  const reports = new ReportService(store, config.calibrationDir, rpcSecrets(config.rpcUrls.values()), config.liveSidecarDir);
  const indexed = await reports.init();
  // Mobula snapshots for the coverage panel. Soft by design: zero indexed
  // snapshots is a supported state, not a startup failure.
  const sidecars = await reports.indexLiveSidecars();

  const manager = new JobManager(config, store, resolveWorkerPath());
  const { recovered } = await manager.init();

  // anvil's absence is reported, not fatal. Fork modes disappear from
  // /api/config's availableModes and the UI stops offering them.
  let anvil: { available: boolean; version: string | null } = { available: false, version: null };
  try {
    const info = await checkAnvilAvailable();
    anvil = { available: true, version: info.version };
  } catch (err) {
    console.warn(`[ripcord] fork sandbox unavailable — scan mode only: ${safeLogValue(err)}`);
  }

  const app = Fastify({
    logger: false,
    // Reports are large; a job submit is tiny. 1 MiB is generous for the latter
    // and refuses anything shaped like an upload.
    bodyLimit: 1_048_576,
    trustProxy: true,
  });

  registerRoutes(app, { config, manager, reports, anvil });

  const webDist = resolveWebDist(config.webDistDir);
  if (webDist) {
    await app.register(fastifyStatic, { root: webDist, index: ["index.html"] });
    // SPA fallback for client-side routes (/report/:id, /saved). API and health
    // paths are excluded so a mistyped API URL 404s as an API call rather than
    // silently returning the HTML shell, which is far harder to debug.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/") || req.url.startsWith("/healthz")) {
        return reply.status(404).send({ error: { code: "not_found", message: "No such endpoint.", hint: null } });
      }
      return reply.sendFile("index.html");
    });
  } else {
    console.warn("[ripcord] no built frontend found — serving the API only. Run `pnpm build:web` for the full app.");
  }

  await app.listen({ port: config.port, host: config.host });

  const blocked = liveRunsBlockedReason(config);
  console.log(
    [
      `[ripcord] listening on http://${config.host}:${config.port}`,
      `  data dir     : ${config.dataDir}`,
      `  frontend     : ${webDist ?? "NOT BUILT (API only)"}`,
      // HOST ONLY, never the URL — it carries the key.
      `  rpc provider : ${providerHostFor(config, 1) ?? "not configured"}`,
      `  live runs    : ${blocked ? `DISABLED — ${blocked}` : "enabled"}`,
      `  fork sandbox : ${anvil.available ? anvil.version : "unavailable (scan mode only)"}`,
      `  saved reports: ${indexed.indexed} calibration report(s) indexed, ${indexed.blocked} withheld by the disclosure gate`,
      `  asset coverage: ${sidecars} Mobula snapshot(s) indexed by (chain, target)`,
      `  recovered    : ${recovered} interrupted job(s) from a previous run`,
    ].join("\n"),
  );

  // Signal handling. Without this, a platform restart leaves a worker (and its
  // anvil child) alive holding a port, and the next boot fails to fork on it.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[ripcord] ${signal} received — stopping workers and closing the server`);
    try { await manager.shutdown(); }
    catch (err) { console.error(`[ripcord] shutdown incomplete: ${safeLogValue(err)}`); process.exitCode = 1; return; }
    await app.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  if (err instanceof ConfigError) {
    // A configuration error names its variable and does not print a stack: the
    // operator needs the variable, not our call frames.
    console.error(`[ripcord] ${err.message}`);
    process.exit(2);
  }
  console.error(`[ripcord] failed to start: ${safeLogValue(err)}`);
  process.exit(1);
});
