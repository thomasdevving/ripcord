/**
 * ERROR SANITISATION, and why it is a module rather than a habit.
 *
 * viem embeds the request URL in its error text and anvil prints its
 * `--fork-url` in startup failures; on every mainstream provider that endpoint
 * IS the API key. So the ordinary fail-loud behaviour of the layers below —
 * attach the cause, keep the provider's own words — becomes a credential
 * disclosure the moment that text reaches an HTTP response, an SSE frame, or a
 * log line on a screen-shared terminal. This is the only place it crosses
 * outward, and it always goes through `sanitize`.
 *
 * Redaction is by SHAPE (any http(s) URL, any long opaque segment, anything
 * key-shaped) rather than by provider hostname: an allowlist fails open on the
 * next provider, and over-redacting costs a slightly less specific hint.
 *
 * `classify` then maps the sanitised text onto a machine-readable ApiErrorCode,
 * so the UI renders its own sentence and a next step instead of echoing provider
 * prose — which is what stops "the contract could not be read" from ever being
 * presented as a fact about the contract.
 */
import type { ApiError, ApiErrorCode } from "./shared/dto.js";

const REDACTED = "[redacted]";

/**
 * Ordered redactions. URLs go first so a key inside a URL is removed with the
 * whole URL rather than being partially matched afterwards.
 */
const REDACTIONS: { pattern: RegExp; replace: string }[] = [
  // Any absolute URL, with or without credentials.
  { pattern: /\bhttps?:\/\/[^\s"'<>)\]},]+/gi, replace: `${REDACTED}-url` },
  // ws:// endpoints are the same disclosure.
  { pattern: /\bwss?:\/\/[^\s"'<>)\]},]+/gi, replace: `${REDACTED}-url` },
  // A bare long opaque token (an API key pasted without a URL around it).
  { pattern: /\b[A-Za-z0-9_-]{32,}\b/g, replace: `${REDACTED}-token` },
  // Absolute filesystem paths reveal the container layout and the data dir.
  { pattern: /(?:^|\s)(\/(?:[A-Za-z0-9._-]+\/){2,}[A-Za-z0-9._-]*)/g, replace: ` ${REDACTED}-path` },
];

/**
 * Removes anything credential- or infrastructure-shaped from arbitrary error
 * text. Safe to call on any string from any depth of a cause chain.
 */
export function redact(text: string): string {
  let out = text;
  for (const { pattern, replace } of REDACTIONS) out = out.replace(pattern, replace);
  return out;
}

/** Flattens an error and its cause chain into one already-redacted string. */
export function sanitize(err: unknown, maxDepth = 6): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; cur && depth < maxDepth; depth++) {
    if (typeof cur === "string") {
      parts.push(cur);
      break;
    }
    const message = (cur as { message?: unknown }).message;
    if (typeof message === "string" && message.trim() !== "") parts.push(message);
    const next = (cur as { cause?: unknown }).cause;
    if (next === cur) break;
    cur = next;
  }
  if (parts.length === 0) parts.push(String(err));
  // Deduplicate: viem often repeats the same sentence at several depths, and a
  // triple-printed message reads as three separate problems.
  const unique = [...new Set(parts.map((p) => p.trim()))].filter(Boolean);
  return redact(unique.join(" | ")).slice(0, 800);
}

/**
 * Maps a failure onto a product-level code plus a next step.
 *
 * Every branch below states something about OUR infrastructure or the request,
 * never about the target contract. That separation is the point: "the archive
 * node would not serve this block" and "this contract has no owner" must never
 * be able to render as the same thing, which is the same discipline the engine
 * applies at the cache boundary (KNOWN EDGE #31).
 */
export function classify(err: unknown, jobId?: string): ApiError {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const text = sanitize(err);
  const probe = raw.toLowerCase();

  const build = (code: ApiErrorCode, message: string, hint: string | null): ApiError =>
    jobId === undefined ? { code, message, hint } : { code, message, hint, jobId };

  if (probe.includes("anvil")) {
    return build(
      "anvil_unavailable",
      "The fork sandbox could not be started, so the withdrawal experiment did not run.",
      "This deployment needs the anvil binary from Foundry. A plain scan is unaffected and still available.",
    );
  }
  if (/\b429\b|rate.?limit|too many requests/i.test(raw)) {
    return build(
      "rpc_rate_limited",
      "The RPC provider rate-limited this analysis before it finished.",
      "Retry in a moment, or configure an endpoint with a higher limit. This says nothing about the contract.",
    );
  }
  if (/block not found|missing trie node|header not found|state (?:is )?not available|archive/i.test(raw)) {
    return build(
      "rpc_missing_history",
      "The configured RPC endpoint could not serve state at the pinned historical block.",
      "This analysis needs an archive endpoint. Choosing a recent block, or configuring an archive RPC, resolves it. No conclusion about the contract follows from this.",
    );
  }
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|ETIMEDOUT|network|timeout/i.test(raw)) {
    return build(
      "rpc_unreachable",
      "The RPC endpoint could not be reached, so the chain could not be read.",
      "This is an infrastructure failure on our side, not a property of the contract. Retrying is usually enough.",
    );
  }
  if (/must be authenticated|unauthorized|invalid api key|forbidden/i.test(raw)) {
    return build(
      "rpc_unconfigured",
      "The RPC endpoint rejected our credentials.",
      "The server's RPC configuration needs attention. Saved reports are unaffected.",
    );
  }
  return build("internal", `The analysis stopped with an unexpected error: ${text}`, "The job id below correlates this with the server log.");
}

/**
 * Redacts a value before it is logged. Server logs are shown on screen during a
 * demo and shipped to a platform log drain, so they get the same treatment as a
 * response body — there is no "internal only" audience for a credential.
 */
export function safeLogValue(value: unknown): string {
  return typeof value === "string" ? redact(value) : sanitize(value);
}

/** Public transport projection. Never mutates the pinned internal artifact.
 * URLs and configured credentials are removed everywhere, including raw provider
 * error values. Hex evidence is deliberately preserved; redact() is for logs.
 */
export function publicValue<T>(value: T, secrets: readonly string[] = []): T {
  const clean = (v: unknown): unknown => {
    if (typeof v === "string") {
      let text = v;
      for (const secret of secrets) if (secret.length >= 4) text = text.split(secret).join("[redacted]");
      return text.replace(/\b(?:https?|wss?):\/\/[^\s"'<>)\]},]+/gi, "[redacted-url]")
        .replace(/((?:api[_-]?key|authorization|bearer|password|secret)\s*[:=]\s*)[^\s,;"'}]+/gi, "$1[redacted]")
        .replace(/(?:^|\s)(\/(?:[A-Za-z0-9._-]+\/){2,}[A-Za-z0-9._-]*)/g, " [redacted-path]");
    }
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, clean(val)]));
    return v;
  };
  return clean(value) as T;
}

export function rpcSecrets(urls: Iterable<string>): string[] {
  const secrets: string[] = [];
  for (const url of urls) {
    secrets.push(url);
    try {
      const u = new URL(url);
      for (const part of [u.username, u.password, ...u.pathname.split("/"), ...u.searchParams.values()]) {
        if (part.length >= 8) secrets.push(part, decodeURIComponent(part));
      }
    } catch { /* invalid configuration is handled at startup */ }
  }
  return secrets;
}
