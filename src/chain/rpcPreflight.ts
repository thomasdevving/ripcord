/**
 * RPC provider preflight — making the provider a first-class, honest input
 * rather than an invisible assumption. Two jobs:
 *
 *  1. `describeProvider` names the active provider from its URL *host only* —
 *     NEVER the full URL, which carries the API key. The CLI prints it so a
 *     human can see which provider produced a run without surfacing a secret.
 *  2. `probeMaxLogRange` discovers the provider's real `eth_getLogs` block-range
 *     limit by binary search, once per provider, so the AccessControl event scan
 *     chunks to the actual limit instead of a guessed constant (the old fixed
 *     10k chunk silently failed on any smaller cap). The probe affects only HOW
 *     logs are fetched, never WHAT is reconstructed.
 */
import { getAddress, keccak256, toBytes, type Hex } from "viem";
import { ChainReadError, type ChainReader } from "./client.js";
import { RELEVANT_EVENTS } from "./constants.js";

export interface ProviderInfo {
  /** Human-readable provider name, derived from the host. */
  name: string;
  /** The URL host (no scheme, no path, no key). Safe to log. */
  host: string;
}

const KNOWN_HOSTS: { match: RegExp; name: string }[] = [
  { match: /(^|\.)alchemy\.com$/i, name: "Alchemy" },
  { match: /(^|\.)infura\.io$/i, name: "Infura" },
  { match: /(^|\.)g\.alchemy\.com$/i, name: "Alchemy" },
  { match: /(^|\.)quiknode\.pro$/i, name: "QuickNode" },
  { match: /(^|\.)quicknode\.com$/i, name: "QuickNode" },
  { match: /(^|\.)blastapi\.io$/i, name: "BlastAPI (public)" },
  { match: /(^|\.)ankr\.com$/i, name: "Ankr" },
  { match: /(^|\.)llamarpc\.com$/i, name: "LlamaRPC" },
  { match: /(^|\.)publicnode\.com$/i, name: "PublicNode" },
  { match: /(^|\.)cloudflare-eth\.com$/i, name: "Cloudflare" },
  { match: /(^|\.)drpc\.org$/i, name: "dRPC" },
];

/** Names the provider from its URL host only — never the full URL (which holds the key). */
export function describeProvider(rpcUrl: string): ProviderInfo {
  let host: string;
  try {
    host = new URL(rpcUrl).host;
  } catch {
    return { name: "unknown (unparseable RPC URL)", host: "unknown" };
  }
  const known = KNOWN_HOSTS.find((k) => k.match.test(host));
  return { name: known ? known.name : `custom (${host})`, host };
}

/** A deterministic, log-free probe address: no real contract, so a getLogs range probe isolates the RANGE limit from result-count limits. */
const PROBE_ADDRESS: Hex = getAddress(("0x" + keccak256(toBytes("ripcord.getlogs.range.probe")).slice(-40)) as Hex);

/** Absolute ceiling for the range search — no provider offers more than this and it bounds the binary search. */
const MAX_PROBE_RANGE = 2_000_000n;

const rangeCache = new WeakMap<ChainReader, bigint>();

/**
 * Binary-searches the largest `toBlock - fromBlock` span the provider accepts for
 * an `eth_getLogs` request, memoized per ChainReader. Uses a log-free probe
 * address so only the range rule can trip, never a result-count rule.
 *
 * Fails LOUD if even a single-block range fails: that is a broken provider, not a
 * range limit, and pretending the limit is "1" would silently cripple every
 * downstream scan.
 */
export async function probeMaxLogRange(chain: ChainReader): Promise<bigint> {
  const memo = rangeCache.get(chain);
  if (memo !== undefined) return memo;

  const to = chain.blockNumber;
  const tryRange = async (span: bigint): Promise<boolean> => {
    const from = span >= to ? 0n : to - span;
    try {
      await chain.getLogs({ address: PROBE_ADDRESS, event: RELEVANT_EVENTS.roleGranted, fromBlock: from, toBlock: to });
      return true;
    } catch (err) {
      if (err instanceof ChainReadError) return false;
      throw err;
    }
  };

  // A 1-block range must work; if it doesn't, the provider is broken, not narrow.
  if (!(await tryRange(1n))) {
    throw new ChainReadError(
      "getLogs",
      "eth_getLogs failed even for a single-block range — the provider is unreachable or rejecting all log queries, not merely range-limited",
    );
  }

  // If the ceiling itself is accepted, the provider is effectively unlimited for our purposes.
  if (await tryRange(MAX_PROBE_RANGE)) {
    rangeCache.set(chain, MAX_PROBE_RANGE);
    return MAX_PROBE_RANGE;
  }

  // Binary search the largest accepted span in [1, MAX_PROBE_RANGE).
  let lo = 1n; // known good
  let hi = MAX_PROBE_RANGE; // known bad
  while (hi - lo > 1n) {
    const mid = lo + (hi - lo) / 2n;
    if (await tryRange(mid)) lo = mid;
    else hi = mid;
  }
  rangeCache.set(chain, lo);
  return lo;
}

/** Test/introspection seam: the memoized limit for a chain, if already probed. */
export function cachedMaxLogRange(chain: ChainReader): bigint | undefined {
  return rangeCache.get(chain);
}
