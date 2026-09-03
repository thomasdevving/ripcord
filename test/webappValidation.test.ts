/**
 * Request validation and error sanitisation.
 *
 * The two properties worth testing hardest here are not "does it reject a bad
 * address" (it does, and that is cheap) but:
 *
 *  1. `"latest"` IS RESOLVED ONCE AND PINNED. Every phase of a multi-minute run
 *     must use the same block. If resolution failed and the validator fell back
 *     to a default, the analysis would silently describe a different chain state
 *     than the one requested — so a failure to resolve must be a hard error.
 *
 *  2. NO RPC URL EVER SURVIVES SANITISATION. viem embeds the request URL in its
 *     error text and anvil prints its --fork-url; on every mainstream provider
 *     that URL is the API key. Those strings reach HTTP responses, SSE frames
 *     and a screen-shared terminal, so the redaction is tested against the
 *     shapes those libraries actually produce.
 */
import { describe, expect, it } from "vitest";
import { validateCreateJob, type ValidationContext } from "../server/validate.js";
import { classify, redact, sanitize } from "../server/sanitize.js";

const COMET = "0xc3d688B66703497DAA19211EEdff47f25384cdc3";

function ctx(overrides: Partial<ValidationContext> = {}): ValidationContext {
  return {
    supportedChainIds: [1],
    availableModes: ["scan", "scan_withdrawal_test"],
    resolveLatestBlock: async () => 26_000_000n,
    codeSizeAt: async () => 1878,
    ...overrides,
  };
}

const base = { address: COMET, chainId: 1, block: "25800000", mode: "scan" as const };

describe("job request validation", () => {
  it("accepts a well-formed request and checksums the address", async () => {
    const result = await validateCreateJob({ ...base, address: COMET.toLowerCase() }, ctx());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Checksummed once here so the same address always yields the same job key
    // and the same cache key however it was typed.
    expect(result.value.address).toBe(COMET);
    expect(result.value.block).toBe(25_800_000n);
    expect(result.value.blockSource).toBe("explicit");
  });

  it("rejects a malformed address", async () => {
    const result = await validateCreateJob({ ...base, address: "0xnope" }, ctx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_address");
  });

  it("rejects an unconfigured chain and names what is configured", async () => {
    const result = await validateCreateJob({ ...base, chainId: 137 }, ctx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("unsupported_chain");
    expect(result.error.hint).toContain("1");
  });

  it("refuses a mode this deployment cannot run, rather than failing later", async () => {
    const result = await validateCreateJob({ ...base, mode: "scan_withdrawal_test_upgrade_proof" }, ctx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("unsupported_mode");
  });

  it("refuses an address with no contract code AT THE PINNED BLOCK", async () => {
    // Not at the head: an address can hold code now and none historically, and
    // analysing the second as the first reports an empty power map for a
    // contract that did not yet exist.
    const result = await validateCreateJob(base, ctx({ codeSizeAt: async () => 0 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("no_contract_code");
  });

  it("resolves 'latest' exactly once and pins the number", async () => {
    let calls = 0;
    const result = await validateCreateJob(
      { ...base, block: "latest" },
      ctx({
        resolveLatestBlock: async () => {
          calls++;
          return 26_123_456n;
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls).toBe(1);
    expect(result.value.block).toBe(26_123_456n);
    expect(result.value.blockSource).toBe("resolved_latest");
  });

  it("fails hard when 'latest' cannot be resolved, never falling back to a default block", async () => {
    const result = await validateCreateJob(
      { ...base, block: "latest" },
      ctx({
        resolveLatestBlock: async () => {
          throw new Error("fetch failed");
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // A silent substitution here would swap in a different measurement.
    expect(result.error.message).toContain("latest block could not be resolved");
  });

  it("rejects a non-numeric block", async () => {
    const result = await validateCreateJob({ ...base, block: "tomorrow" }, ctx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_block");
  });

  it("ignores an idempotency key that is not key-shaped", async () => {
    const result = await validateCreateJob({ ...base, idempotencyKey: "../../etc/passwd" }, ctx());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.idempotencyKey).toBeUndefined();
  });

  it("accepts no RPC URL, path or anvil argument from the request", async () => {
    const result = await validateCreateJob(
      { ...base, rpcUrl: "http://evil.example/rpc", cacheDir: "/etc", anvilArgs: ["--fork-url", "http://evil"] },
      ctx(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The validated shape carries only these fields; nothing above survives.
    expect(Object.keys(result.value).sort()).toEqual(["address", "block", "blockSource", "chainId", "idempotencyKey", "mode"]);
  });
});

describe("error sanitisation", () => {
  it("removes an RPC URL with its key from viem-shaped error text", () => {
    const text = redact(
      'HTTP request failed. URL: https://eth-mainnet.g.alchemy.com/v2/AbCdEf123456789_secretkey Details: 401',
    );
    expect(text).not.toContain("alchemy");
    expect(text).not.toContain("secretkey");
    expect(text).toContain("[redacted]");
  });

  it("removes a websocket endpoint too", () => {
    expect(redact("wss://mainnet.infura.io/ws/v3/deadbeefdeadbeefdeadbeef")).not.toContain("infura");
  });

  it("removes a bare long token pasted without a URL", () => {
    expect(redact("key=AbCdEf0123456789AbCdEf0123456789AbCd")).not.toContain("AbCdEf0123456789");
  });

  it("walks a cause chain and does not repeat the same sentence three times", () => {
    const inner = new Error("fetch failed");
    const middle = new Error("fetch failed", { cause: inner });
    const outer = new Error("HTTP request failed. URL: https://x.example/v2/keykeykeykeykeykey", { cause: middle });
    const text = sanitize(outer);
    expect(text).not.toContain("x.example");
    expect(text.match(/fetch failed/g)?.length).toBe(1);
  });

  it("classifies a missing-archive failure as OUR infrastructure, not a contract property", () => {
    const api = classify(new Error("block not found: 0x1899c40"));
    expect(api.code).toBe("rpc_missing_history");
    // The wording must not let an RPC gap read as a finding about the target.
    expect(api.hint).toContain("No conclusion about the contract");
  });

  it("classifies a rate limit distinctly from an unreachable endpoint", () => {
    expect(classify(new Error("429 Too Many Requests")).code).toBe("rpc_rate_limited");
    expect(classify(new Error("fetch failed: ECONNREFUSED")).code).toBe("rpc_unreachable");
  });

  it("never emits an unredacted URL through classify()", () => {
    const api = classify(new Error("anvil failed: --fork-url https://eth-mainnet.g.alchemy.com/v2/topsecretkey12345"));
    expect(JSON.stringify(api)).not.toContain("topsecretkey12345");
    expect(JSON.stringify(api)).not.toContain("alchemy");
  });
});
