/**
 * The Proof Engine (day 3, the pillar).
 *
 * A static capability claim — "an address can upgrade this proxy" — is a fact
 * about power. This turns exactly one such claim into an EXECUTED, reproducible
 * demonstration: on a sandbox fork pinned to the report's block, impersonate
 * the RESOLVED controller (the terminal EOA/Safe at the end of the day-3
 * authority path, not the proxy's nominal owner), walk the admin's own
 * legitimate upgrade path to a minimal drainer implementation, trigger it, and
 * measure the target's token holdings leaving. The headline is a dollar figure
 * priced from an on-chain oracle.
 *
 * ONE archetype, done properly: CODE_CHANGE → drain on an EIP-1967 TRANSPARENT
 * proxy, whose upgrade authority is an OpenZeppelin ProxyAdmin
 * (`upgrade(address,address)`). This is the path validated live end-to-end
 * before a line of it was written. Any other shape (UUPS, beacon, an
 * unresolved authority, no holdings) FAILS LOUD: `produced: false` with a
 * stated reason. A missing proof is honest; a fabricated or hand-waved one is
 * disqualifying — so every exit here is either a real executed delta or an
 * explicit reason it couldn't be produced.
 *
 * Honesty rails, because auditors will probe them:
 *   - Everything runs on the ephemeral fork. No mainnet tx, no key, no approval.
 *   - Every user-facing string is CAPABILITY, not intent: "this authority CAN
 *     move $X," never "will," never "malicious"/"rug".
 *   - Gas is capped; the fork is always torn down.
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import {
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  keccak256,
  toBytes,
  type Hex,
} from "viem";
import { startAnvilFork } from "./anvil.js";
import { drainerInitcode } from "./drainer.js";
import { checkAnvilAvailable } from "./preflight.js";
import { MAJOR_TOKENS } from "../chain/majorTokens.js";
import { feedForToken } from "../chain/priceFeeds.js";
import { slotToAddress } from "../detect/bytecode.js";
import type { Evidence } from "../chain/client.js";
import type { AuthorityPath, AuthorityResolution, ExitWindow, Proof, ProofDelta, ProxyResult } from "../report/schema.js";

const execFileAsync = promisify(execFile);

const SANDBOX_NOTE =
  "Executed only on an ephemeral anvil mainnet fork pinned to the report block. No mainnet transaction was sent, no private key was used or held, no approval was requested. The figures describe what this authority CAN do in simulation — a capability, not a prediction of intent.";

const erc20 = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;
const aggregatorV3 = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { type: "uint80" },
      { type: "int256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint80" },
    ],
  },
] as const;
const proxyAdminAbi = [
  { type: "function", name: "upgrade", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "address" }], outputs: [] },
] as const;

/** A fixed, protocol-unrelated sandbox recipient/deployer — deterministic, never random, so the run is reproducible. */
const SANDBOX_ATTACKER: Hex = slotToAddress(keccak256(toBytes("ripcord.proof.sandbox-recipient")));

export interface ProofRequest {
  chainId: number;
  rpcUrl: string;
  blockNumber: bigint;
  target: Hex;
  proxy: ProxyResult;
  authorityResolution: AuthorityResolution | null;
  /**
   * The day-4 exit window for this target. The proof engine does not compute
   * it; it REPORTS it, because a fork cannot show a delay it never simulated.
   * See `noticeForPath` below and the `noticeSeconds` note on proofSchema.
   */
  exitWindow: ExitWindow | null;
  /** Where to write the trace/reproduce artifacts. */
  artifactDir: string;
}

/**
 * The notice period a given authority path imposes, looked up from the day-4
 * exit-window routes rather than recomputed — one source of truth for the
 * number, so the proof and the verdict can never quote different delays for
 * the same authority.
 *
 * This exists because of a real gap day 4 exposed in the day-3 engine: anvil
 * impersonation executes AS the resolved controller, which for a timelocked
 * authority silently skips the queue that makes the timelock a timelock. The
 * simulation is still correct about the CAPABILITY — the funds really do move,
 * and that authority really can move them — but presenting it without the
 * notice period would let a two-day public queue read as an instant drain.
 * Rather than refuse such proofs (which would hide a real capability), the
 * notice is stated in the headline, so the proof and the exit window agree by
 * construction instead of by luck.
 */
function noticeForPath(exitWindow: ExitWindow | null, path: AuthorityPath): { seconds: string | null; note: string } {
  if (!exitWindow) {
    return { seconds: null, note: "no exit-window assessment was available for this scan, so the notice attached to this authority is unstated — not zero." };
  }
  const route = exitWindow.routes.find(
    (r) => r.label === path.label && r.root.toLowerCase() === (path.hops[0]?.address ?? "").toLowerCase(),
  );
  if (!route) {
    return { seconds: null, note: "this authority path has no matching exit-window route, so the notice it imposes is unstated — not zero." };
  }
  if (route.noticeStatus === "immediate") {
    return { seconds: "0", note: `this authority imposes NO notice period (${route.note}) — the simulated capability is available immediately.` };
  }
  if (route.noticeStatus === "delayed" && route.noticeSeconds !== null) {
    return {
      seconds: route.noticeSeconds,
      note: `IMPORTANT: this authority is subject to a proven-binding ${route.noticeSeconds}s delay. The fork impersonates the controller directly, which SKIPS that queue — so the simulation shows what the authority can ultimately do, not something it can do without notice. In reality the operation would be publicly visible for ${route.noticeSeconds}s before it could execute.`,
    };
  }
  return {
    seconds: null,
    note: `the notice this authority imposes was NOT established (route status: ${route.noticeStatus}${route.nominalDelaySeconds ? `, nominal delay ${route.nominalDelaySeconds}s not proven binding` : ""}) — treat the simulated capability as of unknown urgency, not as immediate.`,
  };
}

function ev(params: Record<string, unknown>, rawValue: unknown, block: bigint): Evidence {
  return { kind: "call", params, rawValue, block: block.toString() };
}

function notProduced(
  req: ProofRequest,
  archetype: string,
  reason: string,
  extra: Partial<Proof> = {},
): Proof {
  return {
    attempted: true,
    produced: false,
    archetype,
    capability: extra.capability ?? null,
    impersonated: extra.impersonated ?? null,
    impersonatedVia: extra.impersonatedVia ?? null,
    authorityPath: extra.authorityPath ?? null,
    noticeSeconds: extra.noticeSeconds ?? null,
    noticeNote:
      extra.noticeNote ??
      "no proof was produced, so no notice period is attached; this is not a statement that the authority acts without notice.",
    deltas: [],
    totalUsd: null,
    headline: `Proof not produced: ${reason}`,
    failureReason: reason,
    sandboxNote: SANDBOX_NOTE,
    reproduceCommand: null,
    traceArtifact: null,
    forkBlock: req.blockNumber.toString(),
    evidence: [],
    ...extra,
    // headline/failureReason must reflect the reason even if extra tried to set them
    ...(extra.headline ? { headline: extra.headline } : {}),
  };
}

/**
 * The transparent-proxy CODE_CHANGE→drain archetype. Returns a Proof either
 * way — produced with a real delta, or not-produced with a stated reason.
 */
export async function runProofEngine(req: ProofRequest): Promise<Proof> {
  const archetype = "CODE_CHANGE→drain on an EIP-1967 transparent proxy (via ProxyAdmin.upgrade)";

  // --- Archetype gate. Only the validated transparent path executes. ---
  if (req.proxy.pattern !== "eip1967_transparent") {
    return notProduced(
      req,
      archetype,
      `target proxy pattern is "${req.proxy.pattern}", not eip1967_transparent — the day-3 proof engine implements exactly one archetype (transparent via ProxyAdmin) and does not guess at others`,
    );
  }
  if (!req.proxy.admin) {
    return notProduced(req, archetype, "transparent proxy but no admin (ProxyAdmin) address resolved");
  }

  // --- Find the resolved upgrade authority to impersonate. ---
  const adminLower = req.proxy.admin.toLowerCase();
  const upgradePath =
    req.authorityResolution?.paths.find(
      (p) => p.label === "proxyAdmin" && p.hops[0]?.address.toLowerCase() === adminLower,
    ) ?? null;

  if (!upgradePath) {
    return notProduced(
      req,
      archetype,
      "no resolved authority path for the ProxyAdmin — recursion did not run or did not reach it",
    );
  }
  const controller = upgradePath.effectiveController;
  if (!controller) {
    return notProduced(
      req,
      archetype,
      `the ProxyAdmin's own controller did not resolve to an impersonable account (terminated: ${upgradePath.terminationReason}) — cannot impersonate an unknown controller`,
      { authorityPath: upgradePath },
    );
  }
  const impersonatedVia = `resolved upgrade authority: ${upgradePath.hops
    .map((h) => `${h.relation}:${h.address}`)
    .join(" → ")} (depth ${upgradePath.hops.length}, confidence ${upgradePath.confidence})`;
  // Attach the notice to every outcome from here on, produced or not: a
  // not-produced proof against a timelocked authority is a different fact from
  // one against a bare key, and the reason matters even when nothing moved.
  const pathNotice = noticeForPath(req.exitWindow, upgradePath);

  // --- Preflight anvil, then run in the sandbox. ---
  let anvilExecutable: string;
  try {
    anvilExecutable = (await checkAnvilAvailable()).executable;
  } catch (err) {
    return notProduced(req, archetype, err instanceof Error ? err.message : String(err), {
      authorityPath: upgradePath,
    });
  }

  const fork = await startAnvilFork({ rpcUrl: req.rpcUrl, blockNumber: req.blockNumber, anvilExecutable });
  try {
    const evidence: Evidence[] = [];

    // Which major tokens does the target actually hold at this block?
    const candidates = MAJOR_TOKENS[req.chainId] ?? [];
    const held: { token: Hex; symbol: string; decimals: number; before: bigint }[] = [];
    for (const { address: token, symbol } of candidates) {
      const bal = (await fork.client.readContract({
        address: token,
        abi: erc20,
        functionName: "balanceOf",
        args: [req.target],
      })) as bigint;
      if (bal > 0n) {
        const decimals = (await fork.client.readContract({
          address: token,
          abi: erc20,
          functionName: "decimals",
        })) as number;
        held.push({ token, symbol, decimals, before: bal });
        evidence.push(ev({ read: "balanceOf(target)", token, symbol }, bal.toString(), req.blockNumber));
      }
    }

    if (held.length === 0) {
      return notProduced(
        req,
        archetype,
        "the target holds none of the priced major tokens at the pinned block, so there is no fund movement to demonstrate — the upgrade capability is real (see the static finding), but this archetype proves it by moving held value and there is none here",
        { authorityPath: upgradePath, impersonated: getAddress(controller), impersonatedVia, noticeSeconds: pathNotice.seconds, noticeNote: pathNotice.note },
      );
    }

    // 1. Deploy the minimal drainer from a sandbox account (funded for gas).
    const initcode = drainerInitcode(held.map((h) => h.token), SANDBOX_ATTACKER);
    await fork.client.setBalance({ address: SANDBOX_ATTACKER, value: 10n ** 18n });
    await fork.client.impersonateAccount({ address: SANDBOX_ATTACKER });
    const deploy = await fork.sendFrom(SANDBOX_ATTACKER, { data: initcode, gas: 1_000_000n });
    if (deploy.status !== "success") {
      return notProduced(req, archetype, "drainer deployment reverted on the fork", {
        authorityPath: upgradePath,
        impersonated: getAddress(controller),
        impersonatedVia,
        noticeSeconds: pathNotice.seconds,
        noticeNote: pathNotice.note,
      });
    }
    const receipt = await fork.client.getTransactionReceipt({ hash: deploy.hash });
    const drainer = receipt.contractAddress as Hex;
    evidence.push(ev({ action: "deploy drainer implementation (sandbox)", from: SANDBOX_ATTACKER }, drainer, req.blockNumber));

    // 2. Impersonate the RESOLVED controller and execute the admin's own upgrade path.
    const controllerAddr = getAddress(controller);
    await fork.client.setBalance({ address: controllerAddr, value: 10n ** 18n });
    await fork.client.impersonateAccount({ address: controllerAddr });
    const upgradeData = encodeFunctionData({
      abi: proxyAdminAbi,
      functionName: "upgrade",
      args: [req.target, drainer],
    });
    const upgrade = await fork.sendFrom(controllerAddr, { to: req.proxy.admin as Hex, data: upgradeData, gas: 500_000n });
    if (upgrade.status !== "success") {
      return notProduced(
        req,
        archetype,
        `impersonated controller ${controllerAddr} could not execute ProxyAdmin.upgrade — the resolved authority may be wrong, or the admin uses a non-standard upgrade entrypoint`,
        { authorityPath: upgradePath, impersonated: controllerAddr, impersonatedVia, noticeSeconds: pathNotice.seconds, noticeNote: pathNotice.note },
      );
    }
    evidence.push(ev({ action: "ProxyAdmin.upgrade(target, drainer)", from: controllerAddr, admin: req.proxy.admin }, upgrade.hash, req.blockNumber));

    // 3. Trigger the drain (any call to the proxy now delegatecalls the drainer).
    const trigger = await fork.sendFrom(SANDBOX_ATTACKER, { to: req.target, gas: 3_000_000n });
    evidence.push(ev({ action: "trigger drain (call upgraded proxy)", from: SANDBOX_ATTACKER }, trigger.hash, req.blockNumber));

    // 4. Measure deltas and price them.
    const deltas: ProofDelta[] = [];
    let totalUsd: number | null = 0;
    for (const h of held) {
      const after = (await fork.client.readContract({
        address: h.token,
        abi: erc20,
        functionName: "balanceOf",
        args: [req.target],
      })) as bigint;
      const delta = h.before - after;
      const priced = await priceDelta(fork, req.chainId, h.token, h.symbol, h.before, after, h.decimals, req.blockNumber, evidence);
      if (priced.usd === null) totalUsd = null;
      else if (totalUsd !== null) totalUsd += priced.usd;
      deltas.push(priced);
      evidence.push(ev({ read: "balanceOf(target) after", token: h.token, symbol: h.symbol }, after.toString(), req.blockNumber));
    }

    const movedAny = deltas.some((d) => BigInt(d.delta) > 0n);
    if (!movedAny) {
      return notProduced(
        req,
        archetype,
        "upgrade executed but no token balance moved — the drainer ran without transferring, which should not happen for a held ERC20; treated as a failed proof rather than a $0 claim",
        { authorityPath: upgradePath, impersonated: controllerAddr, impersonatedVia, noticeSeconds: pathNotice.seconds, noticeNote: pathNotice.note },
      );
    }

    // 5. Capture a human-readable trace and write reproduce artifacts.
    const { traceArtifact, reproduceCommand } = await writeArtifacts(req, fork.rpcUrl, trigger.hash, {
      controller: controllerAddr,
      drainer,
      deltas,
      totalUsd,
    });

    const usdStr = totalUsd === null ? "an undetermined USD amount (a price feed could not be read — see deltas)" : `$${totalUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
    // The notice clause is part of the headline, not a footnote. A drain proof
    // driven from a two-day-timelocked authority and one driven from a bare
    // EOA are different findings, and a reader who only reads the headline must
    // not come away with the wrong one.
    const notice = pathNotice;
    const noticeClause =
      notice.seconds === null
        ? " The notice period this authority is subject to was NOT established — see noticeNote."
        : notice.seconds === "0"
          ? " This authority is subject to NO notice period: the capability is available immediately, with no public warning."
          : ` This authority is subject to a proven-binding ${notice.seconds}s notice period, which the fork skips by impersonation — in reality the operation would be publicly visible for that long before it could execute.`;
    const headline = `In simulation on a fork at block ${req.blockNumber}, the resolved upgrade authority ${controllerAddr} CAN move ${usdStr} of the tokens this contract holds, in one upgrade path.${noticeClause} The controller is impersonated; its own transaction authorization, including any Safe signatures, guards or modules, was not executed.`;

    return {
      attempted: true,
      produced: true,
      archetype,
      capability: "CODE_CHANGE via ProxyAdmin.upgrade(address,address)",
      impersonated: controllerAddr,
      impersonatedVia,
      authorityPath: upgradePath,
      noticeSeconds: notice.seconds,
      noticeNote: notice.note,
      deltas,
      totalUsd,
      headline,
      failureReason: null,
      sandboxNote: SANDBOX_NOTE,
      reproduceCommand,
      traceArtifact,
      forkBlock: req.blockNumber.toString(),
      evidence,
    };
  } finally {
    await fork.stop();
  }
}

export async function priceDelta(
  fork: Awaited<ReturnType<typeof startAnvilFork>>,
  chainId: number,
  token: Hex,
  symbol: string,
  before: bigint,
  after: bigint,
  decimals: number,
  blockNumber: bigint,
  evidence: Evidence[],
): Promise<ProofDelta> {
  const delta = before - after;
  const feed = feedForToken(chainId, token);
  const base = {
    token,
    symbol,
    decimals,
    balanceBefore: before.toString(),
    balanceAfter: after.toString(),
    delta: delta.toString(),
  };
  if (!feed) {
    return { ...base, usd: null, priceSource: `no Chainlink feed configured for ${symbol}` };
  }
  try {
    const round = (await fork.client.readContract({
      address: feed.feed,
      abi: aggregatorV3,
      functionName: "latestRoundData",
      blockNumber,
    })) as readonly [bigint, bigint, bigint, bigint, bigint];
    const feedDec = (await fork.client.readContract({
      address: feed.feed,
      abi: aggregatorV3,
      functionName: "decimals",
      blockNumber,
    })) as number;
    const [roundId, answer, startedAt, updatedAt, answeredInRound] = round;
    const block = await fork.client.getBlock({ blockNumber });
    evidence.push(ev({ read: "latestRoundData()", address: feed.feed },
      [roundId, answer, startedAt, updatedAt, answeredInRound].map(String), blockNumber));
    evidence.push(ev({ read: "decimals()", address: feed.feed }, feedDec, blockNumber));
    // Explicit valuation policy, not a claim about a vendor's exact heartbeat.
    // Age is measured relative to the historical report block, never wall time.
    if (answer <= 0n || updatedAt <= 0n || updatedAt > block.timestamp || block.timestamp - updatedAt > 86_400n) {
      return { ...base, usd: null, priceSource: `price unavailable: ${feed.note} has an invalid answer or timestamp, or exceeds the 24-hour valuation age limit at block ${blockNumber}` };
    }
    const tokens = Number(delta) / 10 ** decimals;
    const price = Number(answer) / 10 ** feedDec;
    return {
      ...base,
      usd: Number.isFinite(tokens * price) ? tokens * price : null,
      priceSource: `${feed.note} @ ${feed.feed}`,
    };
  } catch (err) {
    return {
      ...base,
      usd: null,
      priceSource: `price unavailable: ${feed.note} read failed (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}

/** Captures `cast run --trace` of the trigger tx and writes a reproduce script. Trace is best-effort — its absence is stated, never faked. */
async function writeArtifacts(
  req: ProofRequest,
  forkRpcUrl: string,
  triggerHash: Hex,
  summary: { controller: Hex; drainer: Hex; deltas: ProofDelta[]; totalUsd: number | null },
): Promise<{ traceArtifact: string | null; reproduceCommand: string }> {
  const dir = join(req.artifactDir, `${req.target}-${req.blockNumber}`);
  await mkdir(dir, { recursive: true });

  let traceArtifact: string | null = null;
  try {
    // `cast run <hash>` prints the full call trace by default — the most
    // human-readable form available, which is exactly the demo visual.
    const { stdout } = await execFileAsync("cast", ["run", triggerHash, "--rpc-url", forkRpcUrl], {
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const path = join(dir, "trace.txt");
    const header =
      `# Ripcord proof trace — CODE_CHANGE→drain\n` +
      `# target proxy : ${req.target}\n` +
      `# fork block    : ${req.blockNumber}\n` +
      `# impersonated  : ${summary.controller} (resolved upgrade authority)\n` +
      `# drainer impl  : ${summary.drainer} (deployed in sandbox)\n` +
      `# total moved   : ${summary.totalUsd === null ? "USD undetermined" : "$" + summary.totalUsd.toFixed(2)}\n` +
      `# NOTE: sandbox fork only. No mainnet tx, no key. Capability, not intent.\n\n`;
    await writeFile(path, header + stdout, "utf8");
    // Store a cwd-RELATIVE path in the report. The absolute path is written to
    // disk, but an absolute path in the report is machine-specific — it makes a
    // regenerated report differ from a committed one across machines, which is a
    // determinism regression against `compare-reports`. Relative-to-repo-root is
    // both portable and stable.
    traceArtifact = relative(process.cwd(), path);
  } catch {
    traceArtifact = null;
  }

  const reproduceCommand = `pnpm ripcord prove ${req.target} --block ${req.blockNumber} --chain ${req.chainId}`;
  const repro =
    `#!/usr/bin/env bash\n` +
    `# Deterministic replay of this Ripcord proof at the pinned block.\n` +
    `# Requires: an RPC_URL_${req.chainId} in .env, anvil + cast on PATH.\n` +
    `# Runs entirely on a local fork — no mainnet transaction is sent.\n` +
    `set -euo pipefail\n` +
    `${reproduceCommand}\n`;
  await writeFile(join(dir, "reproduce.sh"), repro, "utf8");

  return { traceArtifact, reproduceCommand };
}
