/**
 * The adapter registry.
 *
 * Identification is unchanged from the old `identifyExitInterface`: a protocol
 * matches only when EVERY selector in its fingerprint is present, because a
 * partial match is not a match and testing the wrong exit function is the
 * riskiest false-clean this engine can produce.
 *
 * What is new is `validatedOn`. An adapter registered here but never exercised
 * live on a chain must not decide a verdict on that chain — the project's own
 * rule is that each new interface needs its own baseline mechanics AND a live
 * validation before it is trusted, and a rule that lives only in a document gets
 * forgotten the first time someone is in a hurry. `identifyAdapter` returns the
 * match together with whether it is validated HERE, and the engine refuses to
 * run an unvalidated pair rather than producing a confident-looking result from
 * mechanics nobody has watched work.
 */
import type { Hex } from "viem";
import { cometAdapter } from "./comet.js";
import { fiatTokenAdapter } from "./fiatToken.js";
import type { ExitProtocolAdapter } from "./types.js";

export const adapterRegistryVersion = "0.4.0";

/**
 * Order matters only for overlapping fingerprints, and none of these overlap:
 * Comet requires `supply`+`baseToken`+`isWithdrawPaused`, FiatToken requires the
 * blacklist trio. A future adapter that could double-match must be ordered
 * deliberately and covered by a test that pins which one wins.
 */
export const EXIT_ADAPTERS: ExitProtocolAdapter[] = [cometAdapter, fiatTokenAdapter];

export interface AdapterMatch {
  adapter: ExitProtocolAdapter;
  /** Whether this adapter's mechanics have been validated live on THIS chain. */
  validatedHere: boolean;
}

export function identifyAdapter(selectors: readonly string[], chainId: number): AdapterMatch | null {
  const set = new Set(selectors.map((s) => s.toLowerCase()));
  for (const adapter of EXIT_ADAPTERS) {
    if (adapter.fingerprint.every((s) => set.has(s.toLowerCase()))) {
      return { adapter, validatedHere: adapter.validatedOn.includes(chainId) };
    }
  }
  return null;
}

export function adapterById(id: string): ExitProtocolAdapter | null {
  return EXIT_ADAPTERS.find((a) => a.id === id) ?? null;
}

/**
 * Whether the per-asset scenario sidecar knows how to extend an archetype.
 * Asked through the registry so `server/asset-context.ts` no longer carries its
 * own copy of the Comet interface id — a second place that had to be edited to
 * add a protocol, and a second place that could disagree with the first.
 */
export function supportsAssetScenarios(interfaceName: string | null | undefined): boolean {
  if (!interfaceName) return false;
  return adapterById(interfaceName)?.supportsAssetScenarios === true;
}

/** Every fingerprint selector across the registry, for tests that assert derivation. */
export function allFingerprintSelectors(): Hex[] {
  return EXIT_ADAPTERS.flatMap((a) => a.fingerprint);
}

export type { ExitProtocolAdapter } from "./types.js";
