/**
 * Environment → typed configuration, validated once at startup.
 *
 * An invalid configuration fails loudly and immediately, naming the variable: a
 * service that boots with `RIPCORD_MAX_ACTIVE_JOBS="one"` coerced to 0 would
 * accept jobs and never run them, which looks exactly like a hung queue.
 *
 * A MISSING RPC IS A VALID STATE, not a crash. The service boots, saved reports
 * stay readable, and the UI says plainly why Analyze is unavailable — an RPC
 * outage is a fact about our infrastructure and must never be presented as a
 * property of the contract under examination.
 *
 * The RPC URL never leaves this module except as a HOST (describeProvider): the
 * full URL carries the API key, and viem/anvil error text routinely embeds it.
 * See sanitize.ts for the other half of that guarantee.
 */
import { resolve } from "node:path";
import type { RunMode } from "./shared/dto.js";

export interface ServerConfig {
  nodeEnv: string;
  port: number;
  host: string;
  dataDir: string;
  /** Chain id → RPC URL. Server-side only; never serialised to a client. */
  rpcUrls: Map<number, string>;
  enableLiveRuns: boolean;
  maxActiveJobs: number;
  maxQueuedJobs: number;
  jobTimeoutMs: number;
  /**
   * Post-analysis asset-context refreshes allowed to run at once.
   *
   * These start AFTER a job's worker has finished, so they are outside
   * `maxActiveJobs` and were previously unbounded: N jobs completing together
   * meant N Mobula fetches and N anvil forks with no ceiling at all, which is
   * the resource limit `maxActiveJobs` exists to impose.
   */
  maxActiveAssetContexts: number;
  /** Refreshes allowed to WAIT. Beyond this the sidecar is written `unavailable` immediately rather than queued indefinitely. */
  maxQueuedAssetContexts: number;
  /** Hard ceiling on one refresh, fork included. Without it a stuck fork leaves a sidecar `pending` forever and browsers polling it forever. */
  assetContextTimeoutMs: number;
  defaultBlock: bigint;
  /** Where the built frontend lives. Absent in dev, where Vite serves it. */
  webDistDir: string | null;
  /** Committed historical reports, served read-only and never as a directory listing of the filesystem. */
  calibrationDir: string;
  /**
   * Committed Mobula snapshots, used ONLY by the asset-coverage panel. Its
   * absence is a supported state: coverage then reports Mobula as unavailable
   * and every pinned observation is still shown.
   */
  liveSidecarDir: string;
  mobulaApiKey: string | null;
}

export class ConfigError extends Error {
  constructor(variable: string, detail: string) {
    super(`Invalid configuration: ${variable} — ${detail}`);
    this.name = "ConfigError";
  }
}

function intVar(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new ConfigError(name, `expected an integer, got "${raw}"`);
  if (value < min || value > max) throw new ConfigError(name, `expected ${min}..${max}, got ${value}`);
  return value;
}

/**
 * Strict boolean parsing. A typo like `RIPCORD_ENABLE_LIVE_RUNS=ture` must not
 * quietly mean `false` — the operator would see "live runs disabled" and go
 * hunting for an RPC problem that does not exist.
 */
function boolVar(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  throw new ConfigError(name, `expected a boolean (true/false), got "${raw}"`);
}

/** Collects every `RPC_URL_<chainId>` present in the environment. */
function collectRpcUrls(env: NodeJS.ProcessEnv): Map<number, string> {
  const urls = new Map<number, string>();
  for (const [key, value] of Object.entries(env)) {
    const match = /^RPC_URL_(\d+)$/.exec(key);
    if (!match || !value) continue;
    const chainId = Number(match[1]);
    try {
      // Validated here so a malformed URL is a startup error naming the
      // variable, rather than an opaque fetch failure inside a job later.
      new URL(value);
    } catch {
      throw new ConfigError(key, "is not a valid URL");
    }
    urls.set(chainId, value);
  }
  return urls;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const rpcUrls = collectRpcUrls(env);
  const dataDir = resolve(env.RIPCORD_DATA_DIR ?? ".ripcord-data");

  const config: ServerConfig = {
    nodeEnv: env.NODE_ENV ?? "development",
    // Railway (and most platforms) inject PORT. 8080 is only the local default.
    port: intVar(env, "PORT", 8080, 1, 65535),
    // 0.0.0.0 so the container is reachable from the platform's proxy. Anvil,
    // by contrast, binds loopback only and is never exposed — see fork/anvil.ts.
    host: "0.0.0.0",
    dataDir,
    rpcUrls,
    enableLiveRuns: boolVar(env, "RIPCORD_ENABLE_LIVE_RUNS", false),
    maxActiveJobs: intVar(env, "RIPCORD_MAX_ACTIVE_JOBS", 1, 1, 4),
    maxQueuedJobs: intVar(env, "RIPCORD_MAX_QUEUED_JOBS", 3, 0, 50),
    jobTimeoutMs: intVar(env, "RIPCORD_JOB_TIMEOUT_MS", 600_000, 10_000, 3_600_000),
    maxActiveAssetContexts: intVar(env, "RIPCORD_MAX_ACTIVE_ASSET_CONTEXTS", 1, 1, 4),
    maxQueuedAssetContexts: intVar(env, "RIPCORD_MAX_QUEUED_ASSET_CONTEXTS", 4, 0, 50),
    assetContextTimeoutMs: intVar(env, "RIPCORD_ASSET_CONTEXT_TIMEOUT_MS", 900_000, 30_000, 3_600_000),
    defaultBlock: 0n,
    webDistDir: env.RIPCORD_WEB_DIST ? resolve(env.RIPCORD_WEB_DIST) : null,
    calibrationDir: resolve(env.RIPCORD_CALIBRATION_DIR ?? "calibration/reports"),
    liveSidecarDir: resolve(env.RIPCORD_LIVE_SIDECAR_DIR ?? "calibration/live"),
    mobulaApiKey: env.MOBULA_API_KEY && env.MOBULA_API_KEY.trim() !== "" ? env.MOBULA_API_KEY : null,
  };

  const rawBlock = env.RIPCORD_DEFAULT_BLOCK ?? "25800000";
  try {
    config.defaultBlock = BigInt(rawBlock);
  } catch {
    throw new ConfigError("RIPCORD_DEFAULT_BLOCK", `expected an integer block number, got "${rawBlock}"`);
  }
  if (config.defaultBlock < 0n) throw new ConfigError("RIPCORD_DEFAULT_BLOCK", "must be non-negative");

  return config;
}

/**
 * Why live runs are unavailable, or null when they are available.
 *
 * Kept as one function so the API, the UI banner and the job-creation guard can
 * never disagree about the reason — three independently-worded explanations of
 * the same condition is how a demo ends up saying "RPC missing" on one screen
 * and "runs disabled" on another.
 */
export function liveRunsBlockedReason(config: ServerConfig): string | null {
  if (!config.enableLiveRuns) {
    return "Live analysis is turned off for this deployment (RIPCORD_ENABLE_LIVE_RUNS=false). Saved reports remain fully readable.";
  }
  if (!config.rpcUrls.has(1)) {
    return "No Ethereum Mainnet RPC endpoint is configured on the server. Saved reports remain fully readable.";
  }
  return null;
}

export function rpcUrlFor(config: ServerConfig, chainId: number): string | null {
  return config.rpcUrls.get(chainId) ?? null;
}

/** Host only — the full URL carries the provider key and must never be surfaced. */
export function providerHostFor(config: ServerConfig, chainId: number): string | null {
  const url = rpcUrlFor(config, chainId);
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** Modes this deployment can actually execute. A mode absent here is never offered by the UI. */
export function availableModes(config: ServerConfig, anvilAvailable: boolean): RunMode[] {
  const modes: RunMode[] = ["scan"];
  if (anvilAvailable) modes.push("scan_withdrawal_test", "scan_withdrawal_test_upgrade_proof");
  return modes;
}
