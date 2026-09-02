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
  UnknownEntry,
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
  // A `null` delay never becomes a shorter-looking window. Both the revert and
  // the decode-failure paths lead to the same place: either the contract is not
  // classified as a timelock at all (so its route is modelled as IMMEDIATE,
  // zero notice) or it is classified with `delaySeconds: null`, which
  // analyseTimelockBinding turns into `cannot_determine` — never a credited
  // delay. Both are the caution direction, so a failed read here can only make
  // the verdict harsher, never more reassuring. Infrastructure failures cannot
  // reach this line at all: since day 6 they throw from client.ts rather than
  // arriving as `reverted: true`.
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
  unknownsOut: UnknownEntry[],
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
    // Fail-closed default: a node records "AccessControl not detected" only
    // where detectAccessControl actually ran and said so. Every node that
    // returns BEFORE that call (cycle, EOA, Safe, not-a-contract) genuinely has
    // no role enumeration to be incomplete about, and each of those is a
    // positively-established terminal, so `false`/`null` here is a fact rather
    // than an absence. Nodes that DO run the scan overwrite both fields below.
    accessControlDetected: false,
    roleEnumeration: null,
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

  // A contract. Resolve its AccessControl ONCE, up front — its roles feed both
  // the timelock check and the authority seeds below.
  //
  // Critically, this is NOT wrapped in `.catch(() => null)`. The earlier code
  // was, and that conflated two facts that must never be indistinguishable:
  //   - a contract that simply ISN'T AccessControl (DEFAULT_ADMIN_ROLE()
  //     reverts) — a normal, expected outcome that detectAccessControl already
  //     returns as `detected: false` WITHOUT throwing; and
  //   - a real RPC/provider failure (a getLogs/getCode call that actually
  //     failed at the node) — a ChainReadError, which is infrastructure, not
  //     a fact about the contract.
  // Swallowing both into `null` turned a network outage into a silent "no
  // roles / no authority found," exactly the false-clean result the whole
  // project forbids. Now the ChainReadError propagates to build.ts's
  // runStage("authorityResolution"), landing in errors[] where an infra
  // failure belongs, while detectAccessControl's own unknowns[] (e.g. a
  // partial role reconstruction on a capped provider — see accessControl.ts)
  // are threaded UP namespaced by address instead of being discarded here.
  const accessControl = await detectAccessControl(chain, address);
  for (const u of accessControl.unknowns) {
    unknownsOut.push({ field: `authorityResolution[${address}].${u.field}`, reason: u.reason });
  }

  // Before recursing, check whether it is a timelock — a terminal authority we
  // record but do not recurse past into its signers/proposers.
  const timelock = await detectTimelock(chain, address, accessControl.result.roles);

  // From here on this node HAS run a role scan, so it must carry the result —
  // including on the timelock branch, which is exactly where it matters most.
  // A TimelockController's own PROPOSER/EXECUTOR/TIMELOCK_ADMIN holders are what
  // "this delay is binding" rests on; found live on Ethena USDe, whose single
  // route terminates at a timelock whose roles were only partially enumerated
  // while the report still said `can_exit_in_time`.
  const enumerationFields = {
    accessControlDetected: accessControl.result.detected,
    roleEnumeration: accessControl.result.reconstruction,
  };

  if (timelock) {
    evidence.push(...timelock.evidence);
    return base("timelock", "timelock", { type: "timelock", timelock, evidence, ...enumerationFields });
  }

  // A plain contract at the depth cap: stop, but say so explicitly.
  if (depth >= MAX_AUTHORITY_DEPTH) {
    return base("contract", "max_depth", { type: "contract", evidence, ...enumerationFields });
  }

  // Resolve this contract's OWN ownership/proxy authorities and recurse.
  const [ownership, proxy] = await Promise.all([
    detectOwnership(chain, address),
    detectProxy(chain, address),
  ]);

  const seeds = collectSeeds({
    owner: ownership.owner.address as Hex | null,
    pendingOwner: ownership.pendingOwner.address as Hex | null,
    proxyAdmin: proxy.admin as Hex | null,
    roles: accessControl.result.roles,
  });

  if (seeds.length === 0) {
    // A contract we could not resolve any authority for (custom scheme, or an
    // authority mechanism Ripcord doesn't recognise). Not "clean" — unresolved.
    return base("contract", "no_authority_found", { type: "contract", evidence, ...enumerationFields });
  }

  const nextVisited = [...pathVisited, lower];
  const children: AuthorityNode[] = [];
  for (const seed of seeds) {
    children.push(await resolveNode(chain, seed.address, seed.relation, depth + 1, nextVisited, cyclesOut, unknownsOut));
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
    ...enumerationFields,
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

/**
 * The terminal leaf of a root's PREFERRED branch — the same walk `derivePath`
 * uses, exposed because the day-4 exit-window model needs the terminal NODE
 * (for its TimelockInfo), not just the address the path records. Kept here, next
 * to `preferredChild`, so the two can never drift apart: a path whose
 * `effectiveController` came from one walk and whose delay came from another
 * would be an attribution error of exactly the kind this project forbids.
 */
export function terminalNodeOf(root: AuthorityNode): AuthorityNode {
  let node: AuthorityNode = root;
  const guard = new Set<string>();
  for (;;) {
    if (guard.has(node.address.toLowerCase())) return node;
    guard.add(node.address.toLowerCase());
    if (node.terminal || node.children.length === 0) return node;
    node = preferredChild(node);
  }
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
): Promise<{ resolution: AuthorityResolution; unknowns: UnknownEntry[] }> {
  const cyclesDetected: { address: string; path: string[] }[] = [];
  const roots: AuthorityNode[] = [];
  const unknowns: UnknownEntry[] = [];

  // Dedup seeds by address so two capabilities routing through the same
  // ProxyAdmin don't resolve it twice.
  const seen = new Set<string>();
  for (const seed of seeds) {
    const k = seed.address.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    roots.push(await resolveNode(chain, seed.address, seed.relation, 1, [], cyclesDetected, unknowns));
  }

  const paths = roots.map(derivePath);
  return { resolution: { maxDepth: MAX_AUTHORITY_DEPTH, roots, paths, cyclesDetected }, unknowns };
}
