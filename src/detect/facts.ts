/**
 * THE SHARED FACT LAYER.
 *
 * The disk cache makes a repeated READ free. It does nothing about a repeated
 * DERIVATION, and the analysis is full of them: `detectAccessControl` on one
 * contract runs a deployment binary search and a chunked event replay, and the
 * authority recursion reaches the same contract once per branch that points at
 * it — a diamond where a ProxyAdmin and a role both lead to the same governor is
 * ordinary, not exotic. The same address is scanned for proxy pattern,
 * ownership, code and selectors by four different stages that each ask
 * independently. Selector extraction was the plainest case: `timeToExit`
 * documented the set as "Reused (not recomputed)" directly above the code that
 * re-fetched the bytecode and re-ran the analyser on it.
 *
 * Memoization here is safe for one reason, and only that reason: every entry is
 * a pure function of (chain, pinned block, address). The reader IS the block —
 * a ChainReader carries its own `blockNumber` and never reads anything else — so
 * scoping the store to a reader instance keys it correctly by construction,
 * without a hand-written key anyone could get wrong. Two readers pinned to
 * different blocks are two different objects and share nothing.
 *
 * WHAT IS DELIBERATELY NOT MEMOIZED. Anything whose result depends on more than
 * an address: capability detection (which also takes the proxy result, the owner
 * and the role set), guard probing (whose result depends on the probe sender),
 * and every fork interaction (which mutates state by design). A cache key that
 * omitted one of those inputs would return a right-looking answer computed for a
 * different question, which is worse than the recomputation it saves.
 *
 * Results handed out here are SHARED, so they must be treated as immutable.
 * Every current consumer copies before it appends (`[...classified.evidence]`,
 * `unknowns.push(...detection.unknowns)`); test/facts.test.ts pins that a
 * memoized result is deep-equal to a freshly computed one.
 */
import type { Hex } from "viem";
import type { ChainReader, Evidence } from "../chain/client.js";
import { detectAccessControl, type AccessControlDetection } from "./accessControl.js";
import { detectOwnership } from "./ownership.js";
import { detectProxy } from "./proxy.js";
import { extractDispatcherSelectors, type DispatcherResult } from "./dispatcher.js";
import type { OwnerField, ProxyResult } from "../report/schema.js";

type CodeFact = { code: Hex | undefined; evidence: Evidence };
type OwnershipFact = { owner: OwnerField; pendingOwner: OwnerField };

export class ContractFacts {
  private readonly codes = new Map<string, Promise<CodeFact>>();
  private readonly selectorSets = new Map<string, Promise<DispatcherResult>>();
  private readonly proxies = new Map<string, Promise<ProxyResult>>();
  private readonly ownerships = new Map<string, Promise<OwnershipFact>>();
  private readonly accessControls = new Map<string, Promise<AccessControlDetection>>();

  constructor(private readonly chain: ChainReader) {}

  /**
   * The PROMISE is memoized, not the resolved value. Storing it before the first
   * await is what makes two concurrent callers share one computation instead of
   * both starting one and the second overwriting the first's entry.
   */
  private memo<T>(store: Map<string, Promise<T>>, address: Hex, compute: () => Promise<T>): Promise<T> {
    const key = address.toLowerCase();
    const existing = store.get(key);
    if (existing) return existing;
    const started = compute();
    store.set(key, started);
    return started;
  }

  code(address: Hex): Promise<CodeFact> {
    return this.memo(this.codes, address, () => this.chain.getCode(address));
  }

  /**
   * The dispatcher's view of an address, computed once per address per run.
   * Bytecode at a pinned block is immutable, and the analyser identity is a
   * build-time constant (see dispatcher.ts `selectorAnalyzer`), so the address
   * is the whole key — there is no version to fold in that could differ between
   * two calls in the same process.
   */
  selectors(address: Hex): Promise<DispatcherResult> {
    return this.memo(this.selectorSets, address, async () => {
      const { code } = await this.code(address);
      if (!code) return { recognized: false, reason: "no bytecode" };
      return extractDispatcherSelectors(code);
    });
  }

  proxy(address: Hex): Promise<ProxyResult> {
    return this.memo(this.proxies, address, () => detectProxy(this.chain, address));
  }

  ownership(address: Hex): Promise<OwnershipFact> {
    return this.memo(this.ownerships, address, () => detectOwnership(this.chain, address));
  }

  accessControl(address: Hex): Promise<AccessControlDetection> {
    return this.memo(this.accessControls, address, () => detectAccessControl(this.chain, address));
  }

  /** For capacity measurement only — how many distinct addresses each kind of fact covered. */
  stats(): Record<string, number> {
    return {
      code: this.codes.size,
      selectors: this.selectorSets.size,
      proxy: this.proxies.size,
      ownership: this.ownerships.size,
      accessControl: this.accessControls.size,
    };
  }
}

/**
 * The fact store for a reader, created on first use.
 *
 * Keyed on the READER rather than passed down through every detector signature.
 * That is not laziness about plumbing: the reader already is the analysis
 * identity (chain id + pinned block + cache), so this cannot be scoped wrongly
 * by a caller who forgets an argument, and a detector that is handed a
 * throwaway fake reader in a test gets a throwaway store with it. A WeakMap so
 * the store dies with the reader.
 */
const factsByReader = new WeakMap<ChainReader, ContractFacts>();

export function factsFor(chain: ChainReader): ContractFacts {
  const existing = factsByReader.get(chain);
  if (existing) return existing;
  const created = new ContractFacts(chain);
  factsByReader.set(chain, created);
  return created;
}
