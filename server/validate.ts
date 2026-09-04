/**
 * Server-side request validation. The browser validates too, for immediate
 * feedback; this module is the authority, because a client check is absent the
 * moment somebody uses curl.
 *
 * THE PART THAT IS NOT MERELY HYGIENE: `block: "latest"` is resolved ONCE, here,
 * and pinned for the entire job. If each phase resolved it independently they
 * would drift during a multi-minute run and the report would describe a state
 * that never existed at any single block. An RPC failure during resolution is a
 * hard error for the same reason.
 *
 * DELIBERATELY NOT ACCEPTED from a request, at any endpoint: an RPC URL, a cache
 * or data path, an anvil flag, a fork port. A form that could point our fork at
 * an arbitrary endpoint would make this service a proxy for someone else's
 * traffic.
 */
import { isAddress, getAddress } from "viem";
import type { ApiError, CreateJobRequest, RunMode } from "./shared/dto.js";
import { isRunMode, modeNeedsFork, MOBULA_SECOND_LAYER_TARGET } from "./shared/dto.js";
import { classify } from "./sanitize.js";

export interface ValidatedRequest {
  address: string;
  chainId: number;
  block: bigint;
  blockSource: "explicit" | "resolved_latest";
  mode: RunMode;
  refreshAssetContext: boolean;
  idempotencyKey: string | undefined;
  controlToken?: string;
  blockHash?: string;
}

export type ValidationResult = { ok: true; value: ValidatedRequest } | { ok: false; error: ApiError };

const fail = (code: ApiError["code"], message: string, hint: string | null): { ok: false; error: ApiError } => ({
  ok: false,
  error: { code, message, hint },
});

export interface ValidationContext {
  supportedChainIds: number[];
  blockIdentity?: (chainId: number, block: bigint) => Promise<string>;
  availableModes: RunMode[];
  /** Resolves the chain head. Injected so the validator is unit-testable without a network. */
  resolveLatestBlock: (chainId: number) => Promise<bigint>;
  /** Returns the bytecode length at (address, block). Zero means no contract there. */
  codeSizeAt: (chainId: number, address: string, block: bigint) => Promise<number>;
}

export async function validateCreateJob(body: unknown, ctx: ValidationContext): Promise<ValidationResult> {
  if (typeof body !== "object" || body === null) {
    return fail("invalid_address", "The request body must be a JSON object.", null);
  }
  const raw = body as Partial<CreateJobRequest>;

  if (typeof raw.address !== "string" || !isAddress(raw.address)) {
    return fail("invalid_address", "That is not a valid Ethereum address.", "An address is 0x followed by 40 hexadecimal characters.");
  }
  // Checksummed once, here, so the same address always produces the same job
  // key and the same cache key regardless of how it was typed.
  const address = getAddress(raw.address);

  const chainId = Number(raw.chainId);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    return fail("unsupported_chain", "The chain id must be a positive integer.", null);
  }
  if (!ctx.supportedChainIds.includes(chainId)) {
    return fail(
      "unsupported_chain",
      `Chain ${chainId} is not configured on this deployment.`,
      `Configured chains: ${ctx.supportedChainIds.join(", ") || "none"}.`,
    );
  }

  if (!isRunMode(raw.mode)) {
    return fail("unsupported_mode", "That run mode is not recognised.", null);
  }
  const mode: RunMode = raw.mode;
  if (!ctx.availableModes.includes(mode)) {
    return fail(
      "unsupported_mode",
      modeNeedsFork(mode)
        ? "The withdrawal experiment is not available on this deployment because the fork sandbox is missing."
        : "That run mode is not available on this deployment.",
      "A plain scan is still available and unaffected.",
    );
  }

  if (raw.refreshAssetContext !== undefined && typeof raw.refreshAssetContext !== "boolean") {
    return fail("unsupported_mode", "The Mobula second-layer option must be true or false.", null);
  }
  if (raw.refreshAssetContext === true) {
    const supportedTarget =
      chainId === MOBULA_SECOND_LAYER_TARGET.chainId &&
      address.toLowerCase() === MOBULA_SECOND_LAYER_TARGET.address.toLowerCase();
    if (!supportedTarget) {
      return fail(
        "unsupported_mode",
        `Mobula second-layer analysis is currently available only for ${MOBULA_SECOND_LAYER_TARGET.label}.`,
        `Use ${MOBULA_SECOND_LAYER_TARGET.address}, or run the standard Ripcord analysis for this contract.`,
      );
    }
    if (!modeNeedsFork(mode)) {
      return fail(
        "unsupported_mode",
        "Mobula second-layer analysis requires a withdrawal-test run.",
        "Choose Scan + withdrawal test, or run the standard scan without the second layer.",
      );
    }
  }

  let block: bigint;
  let blockSource: ValidatedRequest["blockSource"];
  if (raw.block === "latest") {
    try {
      block = await ctx.resolveLatestBlock(chainId);
      // Resolved ONCE and pinned from here on. Everything downstream — scan,
      // fork, differential — receives this number, never the string "latest".
      blockSource = "resolved_latest";
    } catch (err) {
      // No silent fallback to a default block: that would substitute a
      // different measurement for the one that was asked for.
      const api = classify(err);
      return { ok: false, error: { ...api, message: `The latest block could not be resolved: ${api.message}` } };
    }
  } else {
    if (typeof raw.block !== "string" && typeof raw.block !== "number") {
      return fail("invalid_block", "A block number is required.", 'Provide a block number, or "latest".');
    }
    try {
      block = BigInt(raw.block);
    } catch {
      return fail("invalid_block", `"${String(raw.block)}" is not a block number.`, 'Provide an integer, or "latest".');
    }
    if (block < 0n) return fail("invalid_block", "The block number must be non-negative.", null);
    blockSource = "explicit";
  }

  // Contract code at THAT block, not at the head. An address can hold code now
  // and none at a historical block; analysing the second as if it were the
  // first would report an empty power map for a contract that did not yet exist.
  let blockHash: string | undefined;
  let codeSize: number;
  try {
    blockHash = await ctx.blockIdentity?.(chainId, block);
    codeSize = await ctx.codeSizeAt(chainId, address, block);
  } catch (err) {
    return { ok: false, error: classify(err) };
  }
  if (codeSize === 0) {
    return fail(
      "no_contract_code",
      `There is no contract code at ${address} at block ${block}.`,
      "This is an externally owned account, or the contract was deployed after this block. Ripcord analyses deployed contracts.",
    );
  }

  const idempotencyKey =
    typeof raw.idempotencyKey === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(raw.idempotencyKey) ? raw.idempotencyKey : undefined;

  if (raw.controlToken !== undefined && (typeof raw.controlToken !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(raw.controlToken))) {
    return fail("forbidden", "Invalid cancellation capability format.", null);
  }
  return {
    ok: true,
    value: {
      address,
      chainId,
      block,
      blockSource,
      mode,
      refreshAssetContext: raw.refreshAssetContext === true,
      idempotencyKey,
      ...(blockHash ? { blockHash } : {}),
      ...(raw.controlToken ? { controlToken: raw.controlToken } : {}),
    },
  };
}
