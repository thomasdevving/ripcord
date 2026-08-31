/**
 * Recursive authority resolution + timelock detection (day 3).
 *
 * Day 1/2 stop at the immediate power holder: they will tell you a proxy's
 * admin is `type: "contract"` and go no further. That blinds the tool to the
 * exact structure the project exists to expose — a ProxyAdmin owned by a
 * single EOA one hop past where day 1 looks, or a 3-of-11 Safe that fronts
 * for one key behind it. This module follows the chain of authority until it
 * terminates, and produces a PATH per root — "upgrade → ProxyAdmin → EOA
 * 0x…" — not just a terminal address. That path is the day-5 demo's backbone
 * and the exact input the proof engine impersonates from.
 *
 * The rules are the design philosophy applied to depth:
 *   - Termination is explicit. Every leaf says WHY it stopped
 *     (eoa/safe/timelock/max_depth/cycle/no_authority_found) — an empty
 *     `children` is never left to be read as "nothing further exists."
 *   - Weakest-link provenance applies to depth. Confidence degrades high →
 *     medium → low as depth grows; a controller reached through three hops is
 *     not asserted with a direct owner's certainty.
 *   - Cycles are real in the wild (A owns B owns A). We track the visited
 *     path and record a cycle as a finding rather than looping forever.
 *   - Max depth 3. Beyond it we record "not resolved: max depth," never a
 *     silent truncation that would read as a clean terminal.
 */
import { decodeFunctionResult, encodeFunctionData, type Hex } from "viem";
import type { ChainReader, Evidence } from "../chain/client.js";
import { TIMELOCK_SELECTORS } from "../chain/constants.js";
import { classifyAccount } from "./accounts.js";
import { detectOwnership } from "./ownership.js";
import { detectProxy } from "./proxy.js";
import { detectAccessControl } from "./accessControl.js";
import { extractDispatcherSelectors } from "./dispatcher.js";
import type {
  AuthorityNode,
  AuthorityPath,
  AuthorityResolution,
  DepthConfidence,
  RoleEntry,
  TimelockInfo,
} from "../report/schema.js";

export const MAX_AUTHORITY_DEPTH = 3;

/** Confidence degrades with depth — weakest-link provenance on the depth axis. */
export function confidenceForDepth(depth: number): DepthConfidence {
  if (depth <= 1) return "high";
  if (depth === 2) return "medium";
  return "low";
}

/** A depth-1 authority to resolve, with the precise relation that led to it. */
export interface AuthoritySeed {
  address: Hex;
  relation: string;
}

const timelockAbi = [
  { type: "function", name: "getMinDelay", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "delay", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "admin", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "MINIMUM_DELAY", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "GRACE_PERIOD", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

async function readUint(chain: ChainReader, address: Hex, functionName: "getMinDelay" | "delay" | "MINIMUM_DELAY" | "GRACE_PERIOD"): Promise<{ value: bigint | null; evidence: Evidence }> {
  const data = encodeFunctionData({ abi: timelockAbi, functionName });
  const { result, reverted, evidence } = await chain.call(address, data);
  if (reverted || !result) return { value: null, evidence };
  try {
    return { value: decodeFunctionResult({ abi: timelockAbi, functionName, data: result }) as bigint, evidence };
  } catch {
    return { value: null, evidence };
  }
}

async function respondsToAdmin(chain: ChainReader, address: Hex): Promise<{ ok: boolean; evidence: Evidence }> {
  const data = encodeFunctionData({ abi: timelockAbi, functionName: "admin" });
  const { result, reverted, evidence } = await chain.call(address, data);
  if (reverted || !result) return { ok: false, evidence };
  try {
    decodeFunctionResult({ abi: timelockAbi, functionName: "admin", data: result });
    return { ok: true, evidence };
  } catch {
    return { ok: false, evidence };
  }
}

/**
 * Detects whether an address is a timelock and extracts its delay. Classifies
 * by the delay accessor (never by name-guessing):
 *   - `getMinDelay()` resolving  → OpenZeppelin TimelockController.
 *   - `delay()` + `admin()` both resolving → Compound / Governor-Bravo Timelock
 *     (the extra `admin()` check disambiguates from an unrelated `delay()`
 *     getter on a non-timelock).
 *   - Neither, but the contract carries timelock roles (PROPOSER/EXECUTOR/
 *     CANCELLER/TIMELOCK_ADMIN in its reconstructed set) → "unknown" kind with
 *     `delaySeconds: null` — reported as "timelock: delay undetermined,"
 *     never ignored.
 * Returns null when nothing timelock-shaped is found.
 *
 * `adminCanShortenDelay` is a day-3 flag only: it reports whether the
 * delay-mutation selector (updateDelay/setDelay) exists in the timelock's own
 * bytecode — i.e. the delay is not immutable. WHO can reach it and under what
 * constraint (normally the current delay itself) is day-4 Exit Window work.
 */
export async function detectTimelock(
  chain: ChainReader,
  address: Hex,
  roles: RoleEntry[],
): Promise<TimelockInfo | null> {
  const evidence: Evidence[] = [];

  const minDelay = await readUint(chain, address, "getMinDelay");
  evidence.push(minDelay.evidence);

  let kind: TimelockInfo["kind"] | null = null;
  let delaySeconds: string | null = null;

  if (minDelay.value !== null) {
    kind = "openzeppelin";
    delaySeconds = minDelay.value.toString();
  } else {
    const delay = await readUint(chain, address, "delay");
    evidence.push(delay.evidence);
    if (delay.value !== null) {
      const admin = await respondsToAdmin(chain, address);
      evidence.push(admin.evidence);
      if (admin.ok) {
        kind = "compound_bravo";
        delaySeconds = delay.value.toString();
      }
    }
  }

  // Fallback: no readable delay accessor, but the reconstructed role set
  // carries the OZ TimelockController role signature. Report it as a timelock
  // with an undetermined delay rather than pretending it isn't one.
  const roleNames = new Set(roles.map((r) => r.name));
  const looksLikeTimelockByRoles =
    roleNames.has("PROPOSER_ROLE") || roleNames.has("EXECUTOR_ROLE") || roleNames.has("TIMELOCK_ADMIN_ROLE");
  if (kind === null && looksLikeTimelockByRoles) {
    kind = "unknown";
    delaySeconds = null;
  }

  if (kind === null) return null;

  // adminCanShortenDelay: presence of the delay-mutation selector in the
  // timelock's OWN bytecode. Evidence-backed, and honestly `null` when the
  // dispatcher can't be recognised rather than a guessed false.
  let adminCanShortenDelay: boolean | null = null;
  const { code, evidence: codeEvidence } = await chain.getCode(address);
  evidence.push(codeEvidence);
  if (code) {
    const dispatch = extractDispatcherSelectors(code);
    if (dispatch.recognized) {
      const selset = new Set(dispatch.selectors.map((s) => s.toLowerCase()));
      adminCanShortenDelay =
        selset.has(TIMELOCK_SELECTORS.updateDelay.toLowerCase()) ||
        selset.has(TIMELOCK_SELECTORS.setDelay.toLowerCase());
    }
  }

  // cancellers/executors, best-effort from the reconstructed role set. Null
  // (not []) when we simply couldn't reconstruct roles — absence of evidence,
  // not evidence of absence.
  const membersOf = (name: string): Hex[] | null => {
    const entry = roles.find((r) => r.name === name);
    return entry ? (entry.members as Hex[]) : null;
  };
  const cancellers = kind === "compound_bravo" ? null : membersOf("CANCELLER_ROLE");
  const executors = kind === "compound_bravo" ? null : membersOf("EXECUTOR_ROLE");

  const note =
    kind === "unknown"
      ? "contract carries OpenZeppelin timelock roles but no readable delay accessor (getMinDelay/delay) — classified as a timelock with an UNDETERMINED delay; manual confirmation of the delay required"
      : kind === "openzeppelin"
        ? `OpenZeppelin TimelockController: getMinDelay() = ${delaySeconds}s`
        : `Compound/Governor-Bravo Timelock: delay() = ${delaySeconds}s`;

  return { kind, delaySeconds, cancellers, executors, adminCanShortenDelay, note, evidence };
}

/**
 * Resolves the authority tree rooted at one address. `pathVisited` is the set
 * of lowercased addresses on the current root-to-here path (NOT a global
 * seen-set): a diamond where two branches legitimately reach the same
 * contract is fine, only a genuine cycle back onto the current path is cut.
 */
async function resolveNode(
  chain: ChainReader,
  address: Hex,
  relation: string,
  depth: number,
  pathVisited: string[],
  cyclesOut: { address: string; path: string[] }[],
): Promise<AuthorityNode> {
  const lower = address.toLowerCase();
  const confidence = confidenceForDepth(depth);

  const base = (
    type: AuthorityNode["type"],
    terminationReason: AuthorityNode["terminationReason"],
    extra: Partial<AuthorityNode>,
  ): AuthorityNode => ({
    address,
    relation,
    depth,
    confidence,
    type,
    safe: null,
    timelock: null,
    terminal: true,
    terminationReason,
    children: [],
    evidence: [],
    ...extra,
  });

  // Cycle: this address already sits on the path we walked to get here.
  if (pathVisited.includes(lower)) {
    cyclesOut.push({ address, path: [...pathVisited, lower] });
    return base("contract", "cycle", {
      type: "contract",
      evidence: [],
    });
  }

  const classified = await classifyAccount(chain, address, [relation]);
  const evidence = [...classified.evidence];

  if (classified.type === "eoa") {
    return base("eoa", "eoa", { evidence });
  }
  if (classified.type === "safe") {
    return base("safe", "safe", { safe: classified.safe, evidence });
  }

  // A contract. Before recursing, check whether it is a timelock — a terminal
  // authority we record but do not recurse past into its signers/proposers.
  const roleForTimelock = await detectAccessControl(chain, address).catch(() => null);
  const timelock = await detectTimelock(chain, address, roleForTimelock?.result.roles ?? []);
  if (timelock) {
    evidence.push(...timelock.evidence);
    return base("timelock", "timelock", { type: "timelock", timelock, evidence });
  }

  // A plain contract at the depth cap: stop, but say so explicitly.
  if (depth >= MAX_AUTHORITY_DEPTH) {
    return base("contract", "max_depth", { type: "contract", evidence });
  }

  // Resolve this contract's OWN authorities and recurse one level deeper.
  const [ownership, proxy] = await Promise.all([
    detectOwnership(chain, address),
    detectProxy(chain, address),
  ]);
  const accessControl = roleForTimelock ?? (await detectAccessControl(chain, address).catch(() => null));

  const seeds = collectSeeds({
    owner: ownership.owner.address as Hex | null,
    pendingOwner: ownership.pendingOwner.address as Hex | null,
    proxyAdmin: proxy.admin as Hex | null,
    roles: accessControl?.result.roles ?? [],
  });

  if (seeds.length === 0) {
    // A contract we could not resolve any authority for (custom scheme, or an
    // authority mechanism Ripcord doesn't recognise). Not "clean" — unresolved.
    return base("contract", "no_authority_found", { type: "contract", evidence });
  }

  const nextVisited = [...pathVisited, lower];
  const children: AuthorityNode[] = [];
  for (const seed of seeds) {
    children.push(await resolveNode(chain, seed.address, seed.relation, depth + 1, nextVisited, cyclesOut));
  }

  return {
    address,
    relation,
    depth,
    confidence,
    type: "contract",
    safe: null,
    timelock: null,
    terminal: false,
    terminationReason: "not_a_contract_holder",
    children,
    evidence,
  };
}

/** Dedupes authority addresses (lowercase-keyed) and labels each with its relation. */
function collectSeeds(sources: {
  owner: Hex | null;
  pendingOwner: Hex | null;
  proxyAdmin: Hex | null;
  roles: RoleEntry[];
}): AuthoritySeed[] {
  const byKey = new Map<string, AuthoritySeed>();
  const add = (addr: Hex | null | undefined, relation: string) => {
    if (!addr) return;
    const k = addr.toLowerCase();
    if (byKey.has(k)) return; // first relation wins; the reader still sees the address once
    byKey.set(k, { address: addr, relation });
  };
  add(sources.proxyAdmin, "proxyAdmin");
  add(sources.owner, "owner");
  add(sources.pendingOwner, "pendingOwner");
  for (const role of sources.roles) {
    for (const m of role.members) add(m as Hex, `accessControl:${role.name ?? role.role}`);
  }
  return [...byKey.values()];
}

/**
 * Flattens the resolved tree into linear paths for display and for the proof
 * engine. A path follows the single most-authoritative branch to a terminal
 * leaf: at each contract we prefer the proxyAdmin/owner branch (the upgrade
 * authority) over role branches, matching what the proof engine needs to
 * impersonate. Branching nodes still keep their full `children` in the tree;
 * this is a readable projection, not a replacement.
 */
function preferredChild(node: AuthorityNode): AuthorityNode {
  // Prefer the upgrade-authority branch (proxyAdmin, then owner) — that is
  // what the proof engine needs to impersonate — falling back to the first.
  return (
    node.children.find((c) => c.relation === "proxyAdmin") ??
    node.children.find((c) => c.relation === "owner") ??
    (node.children[0] as AuthorityNode)
  );
}

function derivePath(root: AuthorityNode): AuthorityPath {
  const hops: AuthorityPath["hops"] = [];
  let node: AuthorityNode = root;
  const guard = new Set<string>();
  for (;;) {
    hops.push({ address: node.address, relation: node.relation, type: node.type, depth: node.depth });
    if (guard.has(node.address.toLowerCase())) break;
    guard.add(node.address.toLowerCase());
    if (node.terminal || node.children.length === 0) break;
    node = preferredChild(node);
  }
  // `node` is now the terminal leaf of the preferred branch.
  const terminalNode = node;
  const isController =
    terminalNode.type === "eoa" || terminalNode.type === "safe" || terminalNode.type === "timelock";
  return {
    label: root.relation,
    hops,
    effectiveController: isController ? terminalNode.address : null,
    effectiveControllerType: isController ? terminalNode.type : null,
    terminationReason: terminalNode.terminationReason,
    confidence: terminalNode.depth <= 1 ? "high" : terminalNode.depth === 2 ? "medium" : "low",
  };
}

export async function resolveAuthorityGraph(
  chain: ChainReader,
  seeds: AuthoritySeed[],
): Promise<AuthorityResolution> {
  const cyclesDetected: { address: string; path: string[] }[] = [];
  const roots: AuthorityNode[] = [];

  // Dedup seeds by address so two capabilities routing through the same
  // ProxyAdmin don't resolve it twice.
  const seen = new Set<string>();
  for (const seed of seeds) {
    const k = seed.address.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    roots.push(await resolveNode(chain, seed.address, seed.relation, 1, [], cyclesDetected));
  }

  const paths = roots.map(derivePath);
  return { maxDepth: MAX_AUTHORITY_DEPTH, roots, paths, cyclesDetected };
}
