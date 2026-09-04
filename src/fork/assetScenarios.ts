/**
 * Post-report, per-asset exit differentials.
 *
 * This module knows nothing about candidate discovery. It accepts explicit
 * token addresses and pinned balances, recognises which of them are actual
 * Compound III collateral assets, creates isolated sandbox positions, and
 * compares an open withdrawal with the same withdrawal after the real guardian
 * flips the real withdraw-pause flag.
 *
 * It is deliberately narrow: one protocol family, one mutation, one exit call.
 * Unsupported assets and failed setups are data, never silently dropped.
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  RawContractError,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  toHex,
  type Hex,
} from "viem";
import { startAnvilFork, type ForkHandle, type ForkTransactionResult } from "./anvil.js";
import { checkAnvilAvailable } from "./preflight.js";
import { COMET_PAUSED_ERROR, cometAbi, cometSupplyCalldata, cometWithdrawCalldata, cometWithdrawPauseCalldata } from "./exitActions.js";
import { looksLikeContractRevert, type Evidence } from "../chain/client.js";

export const assetScenarioVersion = "0.4.0";

/**
 * SHIPPED EXPERIMENTAL, ON PURPOSE, AND SAID SO IN THE ARTIFACT.
 *
 * The mechanical gaps in candidate discovery, sandbox funding and per-asset
 * isolation are closed; the label remains because this is still one protocol
 * adapter, one exit action and one privileged mutation. A no-effect result
 * cannot establish that another function, sequence or economic state would leave
 * the asset exit open, so this layer has no clean tier. The flag travels with
 * every batch instead of living only in a document.
 */
export const assetScenarioExperimental = true;

const HOLDER_BASE = 0xd100n;
const CONTROL_SINK = "0x000000000000000000000000000000000000d0ff" as Hex;
/** Shared with candidate selection so a second hidden cap cannot drop rows. */
export const assetScenarioCandidateCap = 64;
const MAX_BALANCE_MAPPING_SLOTS = 128;

const tokenAbi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

const cometAssetAbi = [
  ...cometAbi,
  {
    type: "function",
    name: "getAssetInfoByAddress",
    stateMutability: "view",
    inputs: [{ type: "address", name: "asset" }],
    outputs: [{
      type: "tuple",
      components: [
        { type: "uint8", name: "offset" },
        { type: "address", name: "asset" },
        { type: "address", name: "priceFeed" },
        { type: "uint64", name: "scale" },
        { type: "uint64", name: "borrowCollateralFactor" },
        { type: "uint64", name: "liquidateCollateralFactor" },
        { type: "uint64", name: "liquidationFactor" },
        { type: "uint128", name: "supplyCap" },
      ],
    }],
  },
  {
    type: "function",
    name: "collateralBalanceOf",
    stateMutability: "view",
    inputs: [{ type: "address", name: "account" }, { type: "address", name: "asset" }],
    outputs: [{ type: "uint128" }],
  },
  {
    type: "function",
    name: "totalsCollateral",
    stateMutability: "view",
    inputs: [{ type: "address", name: "asset" }],
    outputs: [
      { type: "uint128", name: "totalSupplyAsset" },
      { type: "uint128", name: "_reserved" },
    ],
  },
] as const;

const safeAbi = [
  { type: "function", name: "getThreshold", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getOwners", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] },
] as const;

export interface AssetScenarioInput {
  address: Hex;
  balanceRaw: string;
}

/**
 * Per-asset outcomes. The negative ones are deliberately NOT interchangeable,
 * because they are claims about different things:
 *
 *   `unsupported_asset`  — the PROTOCOL positively rejected the asset: a real
 *                          contract revert from `getAssetInfoByAddress`.
 *   `role_unresolved`    — the role read did not complete, so NOTHING is claimed
 *                          about the protocol. Conflating it with the line above
 *                          would turn an RPC timeout into "Compound does not
 *                          recognise this token".
 *   `token_interface_rejected`
 *                        — the role WAS established and then the TOKEN's own
 *                          contract refused a setup call: a fact about the token.
 *   `read_failed`        — a later setup read failed as INFRASTRUCTURE. One is
 *                          the chain answering, the other our connection
 *                          failing, and a state that quietly means both is the
 *                          shape of every conflation this project has had to fix.
 *
 * `baseline_unestablished` keeps its meaning: the chain answered, and the open
 * control exit could not be demonstrated.
 */
export type AssetScenarioState =
  | "covered_by_primary_report"
  | "restrictor_confirmed"
  | "no_effect"
  | "baseline_unestablished"
  | "inconclusive"
  | "unsupported_asset"
  | "role_unresolved"
  | "token_interface_rejected"
  | "read_failed";

export interface AssetExitScenario {
  address: string;
  /** `unresolved` means the role question was never answered — never that the answer was "no". */
  assetRole: "base" | "collateral" | "unsupported" | "unresolved";
  state: AssetScenarioState;
  holder: string | null;
  suppliedRaw: string | null;
  recoveredRaw: string | null;
  guardian: string | null;
  guardianType: "safe" | "eoa" | "contract" | null;
  noticeSeconds: string | null;
  detail: string;
  evidence: Evidence[];
  caveats: string[];
}

export interface AssetScenarioBatch {
  assetScenarioVersion: string;
  /** Travels with the data so a consumer cannot present this as calibrated coverage. */
  experimental: boolean;
  status: "complete" | "partial" | "unavailable";
  target: string;
  chainId: number;
  forkBlock: string;
  startedAt: string;
  completedAt: string;
  candidatesConsidered: number;
  supported: number;
  evaluated: number;
  restrictorsConfirmed: number;
  unresolved: number;
  scenarios: AssetExitScenario[];
  notes: string[];
}

export interface AssetScenarioRequest {
  chainId: number;
  rpcUrl: string;
  blockNumber: bigint;
  expectedBlockHash: Hex;
  target: Hex;
  assets: AssetScenarioInput[];
  /**
   * Epoch-ms deadline for the whole batch. Checked at asset and branch
   * boundaries, and enforced hard by the wrapper below. Without it a stuck fork
   * leaves the sidecar `pending` forever and every open browser tab polling it.
   */
  deadlineAt?: number;
  /**
   * Cancellation from the owning run.
   *
   * A deadline alone is not cancellation: it tells this batch to stop, but a
   * caller that gave up for another reason (shutdown, a superseding run) has no
   * way to say so. Checked at the same boundaries as the deadline, and BEFORE a
   * fork is spawned — an abandoned run must never start an anvil process.
   */
  signal?: AbortSignal;
  /** Internal deterministic holder offset used when a batch dispatches isolated single-asset runs. */
  sandboxIndexBase?: number;
}

export interface AssetScenarioLifecycle {
  onForkStarted?: (fork: ForkHandle) => void;
  onForkStopped?: (fork: ForkHandle) => void;
}

interface Position {
  tokens: bigint;
  collateral: bigint;
  borrowed: bigint;
  block: bigint;
  timestamp: bigint;
}

interface WorkingScenario {
  address: Hex;
  holder: Hex;
  amount: bigint;
  evidence: Evidence[];
  beforeBaseline?: Position;
  afterBaseline?: Position;
  recovered?: bigint;
  baselineOk: boolean;
  baselineDetail: string;
}

/**
 * Did the CONTRACT reject this call, or did the READ fail?
 *
 * Positive identification only, the same inversion `PinnedChain` made: a revert
 * is a revert when something says so, and everything else is infrastructure.
 * viem's typed revert errors are checked first because these calls go through
 * `readContract` rather than `PinnedChain`, then the shared classifier derived
 * from live error shapes.
 */
/** One short line of failure text. Deliberately not the full error: viem embeds the request URL, and on most providers that URL is the key. */
function errText(err: unknown): string {
  const raw = err instanceof Error ? (err.message.split("\n")[0] ?? err.message) : String(err);
  return raw.replace(/https?:\/\/\S+/g, "[url redacted]").slice(0, 200);
}

function isContractRejection(err: unknown): boolean {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError || e instanceof RawContractError);
    if (revert) return true;
  }
  return looksLikeContractRevert(err);
}

function callEvidence(params: Record<string, unknown>, value: unknown, block: bigint): Evidence {
  return { kind: "call", params, rawValue: value, block: block.toString() };
}

function transactionEvidence(
  action: string,
  from: Hex,
  tx: { to?: Hex; data?: Hex; value?: bigint; gas?: bigint },
  result: ForkTransactionResult,
  block: bigint,
): Evidence {
  return callEvidence({
    method: "eth_sendTransaction",
    forkOnly: true,
    action,
    from,
    to: tx.to ?? null,
    calldata: tx.data ?? "0x",
    selector: tx.data && tx.data.length >= 10 ? tx.data.slice(0, 10) : null,
    value: (tx.value ?? 0n).toString(),
    gasLimit: (tx.gas ?? 3_000_000n).toString(),
  }, {
    transactionHash: result.hash,
    receipt: {
      status: result.status,
      blockNumber: result.blockNumber.toString(),
      blockHash: result.blockHash,
      transactionIndex: result.transactionIndex,
      gasUsed: result.gasUsed.toString(),
      blockTimestamp: result.blockTimestamp.toString(),
      baseFeePerGas: result.baseFeePerGas?.toString() ?? null,
      effectiveGasPrice: result.effectiveGasPrice.toString(),
    },
    revertData: result.revertData,
  }, block);
}

/**
 * The five Comet pause flags. Read as a set, and checked as a set: the
 * differential's claim is that the guardian closed the EXIT, so a mutation that
 * also flipped `supply` or `transfer` is a different experiment and must not be
 * reported as this one.
 */
export interface PauseFlags {
  supply: boolean;
  transfer: boolean;
  withdraw: boolean;
  absorb: boolean;
  buy: boolean;
}

const PAUSE_FLAG_READS = [
  ["supply", "isSupplyPaused"],
  ["transfer", "isTransferPaused"],
  ["withdraw", "isWithdrawPaused"],
  ["absorb", "isAbsorbPaused"],
  ["buy", "isBuyPaused"],
] as const satisfies readonly (readonly [keyof PauseFlags, "isSupplyPaused" | "isTransferPaused" | "isWithdrawPaused" | "isAbsorbPaused" | "isBuyPaused"])[];

/** Names the flags that moved between two readings, so a message can state exactly what changed. */
function changedFlags(before: PauseFlags, after: PauseFlags): (keyof PauseFlags)[] {
  return (Object.keys(before) as (keyof PauseFlags)[]).filter((key) => before[key] !== after[key]);
}

function holderAt(index: number): Hex {
  return getAddress(toHex(HOLDER_BASE + BigInt(index), { size: 20 }));
}

function encodeApprove(spender: Hex, amount: bigint): Hex {
  return encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [spender, amount] });
}

async function classifyParty(fork: ForkHandle, address: Hex): Promise<{ type: "safe" | "eoa" | "contract"; note: string }> {
  const code = await fork.client.getCode({ address });
  if (!code || code === "0x") return { type: "eoa", note: "The pause guardian has no code at the fork block." };
  try {
    const threshold = await fork.client.readContract({ address, abi: safeAbi, functionName: "getThreshold" }) as bigint;
    const owners = await fork.client.readContract({ address, abi: safeAbi, functionName: "getOwners" }) as readonly Hex[];
    return { type: "safe", note: `${threshold}-of-${owners.length} Safe impersonated; signatures, guards and modules were not executed.` };
  } catch {
    return { type: "contract", note: "Contract guardian impersonated; its internal authorization and delay were not executed." };
  }
}

async function readPosition(
  fork: ForkHandle,
  target: Hex,
  asset: Hex,
  holder: Hex,
  phase: string,
  forkBlock: bigint,
  evidence: Evidence[],
): Promise<Position> {
  const head = await fork.client.getBlock();
  const tokenData = encodeFunctionData({ abi: tokenAbi, functionName: "balanceOf", args: [holder] });
  const tokens = await fork.client.readContract({ address: asset, abi: tokenAbi, functionName: "balanceOf", args: [holder], blockNumber: head.number }) as bigint;
  evidence.push(callEvidence({ method: "eth_call", address: asset, data: tokenData, phase, localBlock: head.number.toString(), localTimestamp: head.timestamp.toString(), forkOnly: true }, tokens.toString(), forkBlock));

  const collateralData = encodeFunctionData({ abi: cometAssetAbi, functionName: "collateralBalanceOf", args: [holder, asset] });
  const collateral = await fork.client.readContract({ address: target, abi: cometAssetAbi, functionName: "collateralBalanceOf", args: [holder, asset], blockNumber: head.number }) as bigint;
  evidence.push(callEvidence({ method: "eth_call", address: target, data: collateralData, phase, localBlock: head.number.toString(), localTimestamp: head.timestamp.toString(), forkOnly: true }, collateral.toString(), forkBlock));

  const borrowData = encodeFunctionData({ abi: cometAssetAbi, functionName: "borrowBalanceOf", args: [holder] });
  const borrowed = await fork.client.readContract({ address: target, abi: cometAssetAbi, functionName: "borrowBalanceOf", args: [holder], blockNumber: head.number }) as bigint;
  evidence.push(callEvidence({ method: "eth_call", address: target, data: borrowData, phase, localBlock: head.number.toString(), localTimestamp: head.timestamp.toString(), forkOnly: true }, borrowed.toString(), forkBlock));
  return { tokens, collateral, borrowed, block: head.number, timestamp: head.timestamp };
}

function samePosition(a: Position, b: Position): boolean {
  return a.tokens === b.tokens && a.collateral === b.collateral && a.borrowed === b.borrowed;
}

function successfulCollateralExit(before: Position, after: Position, amount: bigint): boolean {
  return before.collateral === amount && before.borrowed === 0n &&
    after.tokens - before.tokens === amount && after.collateral === 0n && after.borrowed === 0n;
}

const commonCaveats = [
  "The holder position was created only on the fork. No mainnet transaction, private key or real approval was used.",
  "Ripcord seeded one whole token directly into the deterministic sandbox holder's fork storage, without taking assets from the analysed contract. It then used the token's and Compound's real approve, supply and withdraw code. A token whose balance layout cannot be established is left unresolved.",
  "This tests Compound III withdraw(address,uint256) against the withdraw-pause mutation only. Liquidity shocks, oracle changes, governance sequences and other exit paths are not covered.",
];

/** Solidity mapping(address => uint256) location for `account` at `slot`. */
function mappingLocation(account: Hex, slot: number): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    [account, BigInt(slot)],
  ));
}

/**
 * Give a deterministic fork-only holder tokens without draining Comet.
 *
 * Anvil has no generic ERC20 `deal`: token layouts differ. We therefore probe
 * ordinary Solidity balance mappings conservatively. Every unsuccessful trial
 * is restored immediately, and success is accepted only when the token's real
 * `balanceOf(holder)` returns the exact requested amount. This does not claim
 * that every ERC20 has such a layout; failure remains baseline_unestablished.
 */
async function seedSandboxTokenBalance(
  fork: ForkHandle,
  token: Hex,
  holder: Hex,
  amount: bigint,
  forkBlock: bigint,
  evidence: Evidence[],
): Promise<{ ok: boolean; slot: number | null }> {
  for (let slot = 0; slot < MAX_BALANCE_MAPPING_SLOTS; slot++) {
    const index = mappingLocation(holder, slot);
    const original = (await fork.client.getStorageAt({ address: token, slot: index })) ?? toHex(0n, { size: 32 });
    await fork.client.setStorageAt({ address: token, index, value: toHex(amount, { size: 32 }) });
    let observed: bigint | null = null;
    try {
      observed = await fork.client.readContract({ address: token, abi: tokenAbi, functionName: "balanceOf", args: [holder] }) as bigint;
    } catch (err) {
      await fork.client.setStorageAt({ address: token, index, value: original });
      throw err;
    }
    if (observed === amount) {
      evidence.push(callEvidence({
        method: "anvil_setStorageAt",
        forkOnly: true,
        address: token,
        account: holder,
        purpose: "seed deterministic sandbox token balance",
        mappingSlot: slot,
      }, { balanceRaw: amount.toString(), verifiedBy: "balanceOf(holder)" }, forkBlock));
      return { ok: true, slot };
    }
    await fork.client.setStorageAt({ address: token, index, value: original });
  }
  return { ok: false, slot: null };
}

/** Every state that means "this asset did not reach a conclusion". Listed positively so a new state cannot default into the resolved set. */
const UNRESOLVED_STATES: readonly AssetScenarioState[] = [
  "baseline_unestablished",
  "inconclusive",
  "unsupported_asset",
  "role_unresolved",
  "token_interface_rejected",
  "read_failed",
];

function batch(req: AssetScenarioRequest, startedAt: string, scenarios: AssetExitScenario[], notes: string[]): AssetScenarioBatch {
  const supported = scenarios.filter((item) => item.assetRole === "collateral").length;
  const evaluated = scenarios.filter((item) => item.state === "restrictor_confirmed" || item.state === "no_effect").length;
  const unresolved = scenarios.filter((item) => UNRESOLVED_STATES.includes(item.state)).length;
  // `complete` must MEAN something was completed. It previously required only
  // `unresolved === 0`, so an empty batch — or one containing nothing but
  // `covered_by_primary_report` — reported "complete" and rendered in the
  // reassuring tone with zero experiments behind it.
  const status: AssetScenarioBatch["status"] =
    scenarios.length === 0 ? "unavailable"
      : unresolved === 0 && evaluated > 0 ? "complete"
        : "partial";
  return {
    assetScenarioVersion,
    experimental: assetScenarioExperimental,
    status,
    target: req.target.toLowerCase(),
    chainId: req.chainId,
    forkBlock: req.blockNumber.toString(),
    startedAt,
    completedAt: new Date().toISOString(),
    candidatesConsidered: scenarios.length,
    supported,
    evaluated,
    restrictorsConfirmed: scenarios.filter((item) => item.state === "restrictor_confirmed").length,
    unresolved,
    scenarios,
    notes,
  };
}

export async function runAssetExitScenarios(
  req: AssetScenarioRequest,
  lifecycle: AssetScenarioLifecycle = {},
): Promise<AssetScenarioBatch> {
  const startedAt = new Date().toISOString();
  let executable: string;
  try {
    executable = (await checkAnvilAvailable()).executable;
  } catch (err) {
    return {
      ...batch(req, startedAt, [], [err instanceof Error ? err.message : String(err)]),
      status: "unavailable",
    };
  }

  if (req.signal?.aborted) {
    return {
      ...batch(req, startedAt, [], ["The owning refresh was cancelled before a fork was started, so no anvil process was spawned."]),
      status: "unavailable",
    };
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fork = await startAnvilFork({
    rpcUrl: req.rpcUrl,
    blockNumber: req.blockNumber,
    expectedBlockHash: req.expectedBlockHash,
    anvilExecutable: executable,
  });
  lifecycle.onForkStarted?.(fork);
  try {
    // The in-loop `expired()` checks are cooperative: they cannot interrupt a
    // single RPC call that never returns. This race is the backstop that makes
    // "the batch always ends" a property of the code rather than a hope — the
    // `finally` below then stops the fork, so a timeout never leaks a process.
    const guard = req.deadlineAt === undefined && req.signal === undefined
      ? null
      : new Promise<AssetScenarioBatch>((_, rejectRun) => {
          if (req.deadlineAt !== undefined) {
            const remaining = Math.max(0, req.deadlineAt - Date.now());
            timer = setTimeout(() => rejectRun(new Error(`candidate fork batch exceeded its ${Math.round(remaining / 1000)}s time limit and was stopped`)), remaining);
            timer.unref?.();
          }
          req.signal?.addEventListener(
            "abort",
            () => rejectRun(new Error("candidate fork batch was cancelled by its owning refresh")),
            { once: true },
          );
        });
    const run = runAssetExitScenariosOnFork(req, fork, startedAt);
    return await (guard ? Promise.race([run, guard]) : run);
  } finally {
    if (timer) clearTimeout(timer);
    try { await fork.stop(); }
    finally { lifecycle.onForkStopped?.(fork); }
  }
}

/** Exported for network-free execution tests; production calls the wrapper above. */
export async function runAssetExitScenariosOnFork(
  req: AssetScenarioRequest,
  fork: ForkHandle,
  startedAt = new Date().toISOString(),
): Promise<AssetScenarioBatch> {
  const target = getAddress(req.target);
  const inputs = req.assets.slice(0, assetScenarioCandidateCap);
  const expired = () => req.signal?.aborted === true || (req.deadlineAt !== undefined && Date.now() > req.deadlineAt);

  /**
   * Isolation boundary: every candidate starts at the identical pre-candidate
   * fork state and is reverted before the next one begins. The single-asset
   * path below retains the full control/mutation differential, so this small
   * dispatcher avoids duplicating that security-sensitive logic.
   */
  if (inputs.length > 1) {
    const isolated: AssetExitScenario[] = [];
    const childNotes = new Set<string>();
    for (let index = 0; index < inputs.length; index++) {
      if (expired()) {
        for (const remaining of inputs.slice(index)) {
          isolated.push({
            address: remaining.address.toLowerCase(),
            assetRole: "unresolved",
            state: "inconclusive",
            holder: null,
            suppliedRaw: null,
            recoveredRaw: null,
            guardian: null,
            guardianType: null,
            noticeSeconds: null,
            detail: "The shared batch deadline expired before this isolated candidate run began. Nothing was established about its role or exit.",
            evidence: [],
            caveats: commonCaveats,
          });
        }
        childNotes.add(`The batch reached its time limit after ${index} isolated candidate(s); every remaining candidate is recorded as inconclusive.`);
        break;
      }
      const snapshot = await fork.snapshot();
      try {
        const one = await runAssetExitScenariosOnFork({
          ...req,
          assets: [inputs[index]!],
          sandboxIndexBase: (req.sandboxIndexBase ?? 0) + index,
        }, fork, startedAt);
        isolated.push(...one.scenarios);
        for (const note of one.notes) childNotes.add(note);
      } finally {
        await fork.revert(snapshot);
      }
    }
    return batch(req, startedAt, isolated, [
      `Each of ${inputs.length} candidate(s) ran from its own pre-candidate fork snapshot; no position, pause mutation or mined block was shared between assets.`,
      `At most ${assetScenarioCandidateCap} candidates enter the fork batch per analysis.`,
      "A confirmed restriction is demonstrated for that candidate. A no-effect row covers only this one privileged action and is not evidence of safety.",
      ...[...childNotes].filter((note) => /time limit|already paused|no differential/i.test(note)),
    ]);
  }
  const commonEvidence: Evidence[] = [];

  /**
   * Reads one Comet getter and RETURNS its evidence entry alongside the value.
   *
   * It used to only push into `commonEvidence`, and the mutation phase recovered
   * its entries with `commonEvidence.slice(-2)` — wrong twice over: positional
   * recovery put the AFTER reading before the pause transaction, and when the
   * pause failed there was no after-reading, so `slice(-2)` silently pulled in an
   * unrelated read labelled "before asset setup". An evidence array whose order
   * does not match the order of events is not evidence.
   */
  const readCommon = async (
    functionName: "baseToken" | "pauseGuardian" | "isWithdrawPaused" | "isSupplyPaused" | "isTransferPaused" | "isAbsorbPaused" | "isBuyPaused",
    phase: string,
  ): Promise<{ value: unknown; evidence: Evidence }> => {
    const head = await fork.client.getBlock();
    const data = encodeFunctionData({ abi: cometAssetAbi, functionName });
    const value = await fork.client.readContract({ address: target, abi: cometAssetAbi, functionName, blockNumber: head.number });
    const evidence = callEvidence({ method: "eth_call", address: target, data, read: `${functionName}()`, phase, localBlock: head.number.toString(), localTimestamp: head.timestamp.toString(), forkOnly: true }, String(value), req.blockNumber);
    commonEvidence.push(evidence);
    return { value, evidence };
  };

  /** All five pause flags in one phase, with the evidence in the order the reads happened. */
  const readPauseFlags = async (phase: string): Promise<{ flags: PauseFlags; evidence: Evidence[] }> => {
    const evidence: Evidence[] = [];
    const flags = {} as PauseFlags;
    for (const [key, fn] of PAUSE_FLAG_READS) {
      const read = await readCommon(fn, phase);
      flags[key] = read.value as boolean;
      evidence.push(read.evidence);
    }
    return { flags, evidence };
  };

  const baseToken = getAddress((await readCommon("baseToken", "identify protocol base asset")).value as Hex);
  const guardian = getAddress((await readCommon("pauseGuardian", "identify restriction controller")).value as Hex);
  const initialFlags = (await readPauseFlags("before asset setup")).flags;
  const pausedInitially = initialFlags.withdraw;
  const party = await classifyParty(fork, guardian);
  const noticeSeconds = party.type === "contract" ? null : "0";

  const scenarios: AssetExitScenario[] = [];
  if (pausedInitially) {
    // Withdrawals are already shut, so no differential is possible. The old
    // code labelled every non-base asset `assetRole: "unsupported"` with state
    // `baseline_unestablished` — two claims it had not earned. Compound was
    // never asked about these tokens, so their role is UNRESOLVED, and saying
    // "unsupported" would assert a protocol answer that was never requested.
    for (const input of inputs) {
      const isBase = input.address.toLowerCase() === baseToken.toLowerCase();
      scenarios.push({
        address: input.address.toLowerCase(),
        assetRole: isBase ? "base" : "unresolved",
        state: isBase ? "covered_by_primary_report" : "role_unresolved",
        holder: null, suppliedRaw: null, recoveredRaw: null,
        guardian, guardianType: party.type, noticeSeconds,
        detail: isBase
          ? "This is Compound's base asset; the primary report's own withdrawal experiment covers it. Withdrawals were already paused at the pinned block."
          : "Withdrawals were already paused at the pinned block, so no open control exit could exist and no differential was attempted. Compound was not asked whether it recognises this token, so its role is unresolved rather than unsupported.",
        evidence: [...commonEvidence], caveats: commonCaveats,
      });
    }
    return batch(req, startedAt, scenarios, [
      "No differential ran because isWithdrawPaused() was already true at the pinned block.",
      "A pre-existing pause is a fact about the protocol at this block, not a result of any action taken here.",
    ]);
  }

  const sinkCode = await fork.client.getCode({ address: CONTROL_SINK });
  if (sinkCode && sinkCode !== "0x") throw new Error("neutral control sink unexpectedly contains code");
  for (const account of [target, guardian]) {
    await fork.client.setBalance({ address: account, value: 10n ** 18n });
    await fork.client.impersonateAccount({ address: account });
  }

  const working: WorkingScenario[] = [];
  let timedOutAfter: number | null = null;
  for (let index = 0; index < inputs.length; index++) {
    const input = inputs[index]!;
    const address = getAddress(input.address);
    if (expired()) {
      // Out of time. Every REMAINING candidate is recorded as unevaluated, not
      // dropped: a candidate that silently disappears from the list is exactly
      // the "asset stilletjes verdwijnt" failure this layer exists to prevent.
      timedOutAfter = index;
      for (const remaining of inputs.slice(index)) {
        scenarios.push({
          address: remaining.address.toLowerCase(), assetRole: "unresolved", state: "inconclusive",
          holder: null, suppliedRaw: null, recoveredRaw: null, guardian, guardianType: party.type, noticeSeconds,
          detail: "The batch reached its time limit before this candidate was set up. Nothing was established about it in either direction.",
          evidence: [...commonEvidence], caveats: commonCaveats,
        });
      }
      break;
    }
    if (address.toLowerCase() === baseToken.toLowerCase()) {
      scenarios.push({
        address: address.toLowerCase(), assetRole: "base", state: "covered_by_primary_report",
        holder: null, suppliedRaw: null, recoveredRaw: null, guardian, guardianType: party.type, noticeSeconds,
        detail: "This is Compound's base asset. The primary report's withdrawal differential already exercises its funded base-supplier position; no duplicate fork transaction was manufactured here.",
        evidence: [...commonEvidence], caveats: commonCaveats,
      });
      continue;
    }

    const evidence = [...commonEvidence];
    const setupSnapshot = await fork.snapshot();
    let recognisedCollateral = false;
    let setupHolder: Hex | null = null;
    /**
     * Rejects this candidate with an EXPLICIT state and role.
     *
     * These used to be derived from one boolean: `recognisedCollateral ?
     * baseline_unestablished : unsupported_asset`. That made every failure
     * before the role was known — including an RPC timeout — come out as
     * "Compound does not recognise this token", which is a claim about the
     * protocol produced by a failure of ours.
     */
    const reject = async (state: AssetScenarioState, assetRole: AssetExitScenario["assetRole"], detail: string) => {
      await fork.revert(setupSnapshot);
      scenarios.push({
        address: address.toLowerCase(), assetRole, state,
        holder: setupHolder, suppliedRaw: null, recoveredRaw: null, guardian, guardianType: party.type, noticeSeconds,
        detail, evidence, caveats: commonCaveats,
      });
    };
    /** After the role is known, any further setup failure is a failure of OUR read, never of the protocol's answer. */
    const rejectSetup = async (detail: string) => reject("baseline_unestablished", "collateral", detail);

    // --- step 1: the ROLE, on its own, because its failure mode is the one
    // that can manufacture a false claim about Compound.
    let info: { asset: Hex; supplyCap: bigint };
    try {
      const head = await fork.client.getBlock();
      const data = encodeFunctionData({ abi: cometAssetAbi, functionName: "getAssetInfoByAddress", args: [address] });
      info = await fork.client.readContract({ address: target, abi: cometAssetAbi, functionName: "getAssetInfoByAddress", args: [address], blockNumber: head.number }) as { asset: Hex; supplyCap: bigint };
      evidence.push(callEvidence({ method: "eth_call", address: target, data, read: "getAssetInfoByAddress(address)", asset: address, localBlock: head.number.toString(), localTimestamp: head.timestamp.toString(), forkOnly: true }, { asset: info.asset, supplyCap: info.supplyCap.toString() }, req.blockNumber));
    } catch (err) {
      if (isContractRejection(err)) {
        // Compound itself answered, and the answer was no.
        await reject("unsupported_asset", "unsupported",
          "Compound's getAssetInfoByAddress(address) reverted for this token, so the protocol does not register it as collateral. No user exit route was inferred from a target balance alone.");
      } else {
        // We could not ask. Saying "unsupported" here would turn an
        // infrastructure failure into a protocol fact — KNOWN EDGE #31.
        await reject("role_unresolved", "unresolved",
          `The role read did not complete, so Compound was never asked whether it registers this token. This is a failed read, not a protocol answer: ${errText(err)}`);
      }
      continue;
    }
    if (!info.asset || info.asset.toLowerCase() !== address.toLowerCase()) {
      await reject("unsupported_asset", "unsupported",
        "Compound returned asset metadata that does not match this token, so it was not treated as a supported collateral exit.");
      continue;
    }
    recognisedCollateral = true;

    // --- step 2: token metadata and the pinned target balance. The role is now
    // established, so every failure below is ours and is labelled as such.
    let decimals: number;
    let sourceBalance: bigint;
    try {
      const head = await fork.client.getBlock();
      decimals = Number(await fork.client.readContract({ address, abi: tokenAbi, functionName: "decimals", blockNumber: head.number }));
      sourceBalance = await fork.client.readContract({ address, abi: tokenAbi, functionName: "balanceOf", args: [target], blockNumber: head.number }) as bigint;
      evidence.push(callEvidence({ method: "eth_call", address, read: "decimals()", forkOnly: true }, String(decimals), req.blockNumber));
      evidence.push(callEvidence({ method: "eth_call", address, read: "balanceOf(target)", target, forkOnly: true }, sourceBalance.toString(), req.blockNumber));
    } catch (err) {
      // The role is established, so the two failure directions have separated
      // again: the TOKEN refusing a call is a fact about the token, while a
      // failed read is a fact about us. They used to share `read_failed`, whose
      // own documentation says "infrastructure" — a state that quietly meant
      // two things is the shape of every conflation in this project.
      if (isContractRejection(err)) {
        await reject("token_interface_rejected", "collateral",
          `Compound registers this token as collateral, but the token's own decimals()/balanceOf() call reverted, so no sandbox position could be built: ${errText(err)}`);
      } else {
        await reject("read_failed", "collateral",
          `Compound registers this token as collateral, but its token metadata or pinned source balance could not be read, so no sandbox position was attempted: ${errText(err)}`);
      }
      continue;
    }
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
      await rejectSetup(`Token decimals (${decimals}) are outside the supported setup range.`);
      continue;
    }
    if (sourceBalance.toString() !== input.balanceRaw) {
      await rejectSetup("The fork balance did not match the candidate's pinned balance, so setup was refused.");
      continue;
    }

    const holder = holderAt((req.sandboxIndexBase ?? 0) + index);
    setupHolder = holder;
    await fork.client.setBalance({ address: holder, value: 10n ** 18n });
    await fork.client.impersonateAccount({ address: holder });
    let initial: Position;
    try {
      initial = await readPosition(fork, target, address, holder, "before collateral setup", req.blockNumber, evidence);
    } catch (err) {
      if (isContractRejection(err)) {
        await reject("token_interface_rejected", "collateral",
          `Reading the sandbox holder's initial token, collateral or debt state reverted on-chain: ${errText(err)}`);
      } else {
        await reject("read_failed", "collateral",
          `The sandbox holder's initial token, collateral or debt state could not be read: ${errText(err)}`);
      }
      continue;
    }
    if (initial.tokens !== 0n || initial.collateral !== 0n || initial.borrowed !== 0n) {
      await rejectSetup("The deterministic sandbox holder already had tokens, collateral or debt; setup attribution was refused.");
      continue;
    }

    // This differential proves whether the pause capability applies; it is not
    // a market-size or liquidity test. Supplying 1,000 whole tokens needlessly
    // collided with collateral supply caps and turned otherwise testable exits
    // into setup failures. One whole token is enough to exercise the same code
    // path while minimising the artificial pressure introduced by the sandbox.
    const nominal = 10n ** BigInt(decimals);
    let capHeadroom: bigint | null = null;
    try {
      const head = await fork.client.getBlock();
      const data = encodeFunctionData({ abi: cometAssetAbi, functionName: "totalsCollateral", args: [address] });
      const totals = await fork.client.readContract({
        address: target,
        abi: cometAssetAbi,
        functionName: "totalsCollateral",
        args: [address],
        blockNumber: head.number,
      }) as readonly [bigint, bigint];
      const totalSupplyAsset = BigInt(totals[0]);
      capHeadroom = info.supplyCap > totalSupplyAsset ? info.supplyCap - totalSupplyAsset : 0n;
      evidence.push(callEvidence({
        method: "eth_call",
        address: target,
        data,
        read: "totalsCollateral(address)",
        asset: address,
        localBlock: head.number.toString(),
        localTimestamp: head.timestamp.toString(),
        forkOnly: true,
      }, { totalSupplyAsset: totalSupplyAsset.toString(), supplyCap: info.supplyCap.toString(), headroom: capHeadroom.toString() }, req.blockNumber));
    } catch {
      // Diagnostic only. A failed cap read cannot become a cap claim and does
      // not erase the ability to demonstrate a working baseline.
    }
    if (capHeadroom === 0n) {
      await rejectSetup(`Compound registers this collateral, but its total supplied collateral already equals or exceeds the on-chain supply cap (${info.supplyCap} raw units). The sandbox supply was not attempted.`);
      continue;
    }
    const amount = capHeadroom !== null && capHeadroom < nominal ? capHeadroom : nominal;
    const send = async (action: string, from: Hex, tx: { to: Hex; data?: Hex; gas: bigint }) => {
      const result = await fork.sendFrom(from, tx);
      evidence.push(transactionEvidence(action, from, tx, result, req.blockNumber));
      return result;
    };
    // Everything from here on was previously UNGUARDED: one RPC hiccup in a
    // `send` or a `readPosition` threw out of the loop and destroyed the whole
    // batch, including the completed evidence of every other candidate. A
    // failed read now costs exactly one candidate, and says which kind of
    // failure it was.
    let setupOutcome: { ok: false; state: AssetScenarioState; detail: string } | { ok: true } ;
    try {
      const seeded = await seedSandboxTokenBalance(fork, address, holder, amount, req.blockNumber, evidence);
      if (!seeded.ok) {
        setupOutcome = { ok: false, state: "baseline_unestablished", detail: `Compound registers this collateral, but Ripcord could not establish a standard balance mapping within the first ${MAX_BALANCE_MAPPING_SLOTS} storage slots. The analysed contract was not drained to manufacture a holder balance, so no baseline position was attempted.` };
      } else {
        const funded = await readPosition(fork, target, address, holder, "after collateral funding", req.blockNumber, evidence);
        if (funded.tokens - initial.tokens !== amount) {
          setupOutcome = { ok: false, state: "baseline_unestablished", detail: "Funding succeeded but the holder did not receive the exact token amount; fee-on-transfer or non-standard behaviour prevents this setup." };
        } else {
          const approveTx = await send("approve collateral for Compound", holder, { to: address, data: encodeApprove(target, amount), gas: 150_000n });
          if (approveTx.status !== "success") {
            setupOutcome = { ok: false, state: "baseline_unestablished", detail: "Collateral approval reverted on the fork." };
          } else {
            const supplyTx = await send("supply candidate collateral position", holder, { to: target, data: cometSupplyCalldata(address, amount), gas: 900_000n });
            if (supplyTx.status !== "success") {
              setupOutcome = { ok: false, state: "baseline_unestablished", detail: `Compound registers this collateral but rejected the sandbox supply (revert data ${supplyTx.revertData ?? "not returned"}), so no baseline exit position was established. Supply-cap headroom was ${capHeadroom === null ? "not readable" : `${capHeadroom} raw units before the attempt`}; no different cause is inferred from the revert.` };
            } else {
              const supplied = await readPosition(fork, target, address, holder, "after collateral supply", req.blockNumber, evidence);
              setupOutcome = supplied.tokens !== initial.tokens || supplied.collateral !== amount || supplied.borrowed !== 0n
                ? { ok: false, state: "baseline_unestablished", detail: "The supply receipt succeeded but exact collateral credit and a debt-free position were not established." }
                : { ok: true };
            }
          }
        }
      }
    } catch (err) {
      setupOutcome = isContractRejection(err)
        ? { ok: false, state: "token_interface_rejected", detail: `A sandbox setup call reverted on-chain: ${errText(err)}` }
        : { ok: false, state: "read_failed", detail: `Sandbox position setup did not complete as infrastructure work: ${errText(err)}` };
    }
    if (!setupOutcome.ok) {
      await reject(setupOutcome.state, "collateral", setupOutcome.detail);
      continue;
    }
    working.push({ address, holder, amount, evidence, baselineOk: false, baselineDetail: "baseline not run" });
  }

  if (working.length === 0) {
    return batch(req, startedAt, scenarios, [
      "No non-base candidate could be established as a supported Compound collateral position.",
      ...(timedOutAfter === null ? [] : [`The batch reached its time limit after ${timedOutAfter} candidate(s); the rest are recorded as inconclusive, not omitted.`]),
    ]);
  }

  if (expired()) {
    // Never start a differential we cannot finish: a half-run branch pair is
    // not a weaker result, it is an uninterpretable one.
    for (const item of working) {
      scenarios.push({
        address: item.address.toLowerCase(), assetRole: "collateral", state: "inconclusive",
        holder: item.holder, suppliedRaw: item.amount.toString(), recoveredRaw: null,
        guardian, guardianType: party.type, noticeSeconds,
        detail: "A sandbox collateral position was established, but the batch reached its time limit before the control/mutation differential could run.",
        evidence: item.evidence, caveats: [...commonCaveats, party.note],
      });
    }
    return batch(req, startedAt, scenarios, ["The batch reached its time limit before the differential phase started."]);
  }

  const branchSnapshot = await fork.snapshot();
  const neutralTx = { to: CONTROL_SINK, gas: 21_000n };
  const neutral = await fork.sendFrom(guardian, neutralTx);
  const neutralEvidence = transactionEvidence("neutral control step", guardian, neutralTx, neutral, req.blockNumber);
  for (const item of working) item.evidence.push(neutralEvidence);
  if (neutral.status !== "success") throw new Error("neutral control transaction failed");

  for (const item of working) {
    item.beforeBaseline = await readPosition(fork, target, item.address, item.holder, "before baseline collateral withdrawal", req.blockNumber, item.evidence);
    const tx = { to: target, data: cometWithdrawCalldata(item.address, item.amount), gas: 900_000n };
    const result = await fork.sendFrom(item.holder, tx);
    item.evidence.push(transactionEvidence("baseline collateral withdrawal", item.holder, tx, result, req.blockNumber));
    item.afterBaseline = await readPosition(fork, target, item.address, item.holder, "after baseline collateral withdrawal", req.blockNumber, item.evidence);
    item.recovered = item.afterBaseline.tokens - item.beforeBaseline.tokens;
    item.baselineOk = result.status === "success" && successfulCollateralExit(item.beforeBaseline, item.afterBaseline, item.amount);
    item.baselineDetail = item.baselineOk
      ? `Open control exit recovered ${item.recovered} token units and cleared the collateral position with no debt.`
      : "The open control withdrawal did not recover the exact supplied collateral and clear the debt-free position.";
  }
  await fork.revert(branchSnapshot);

  // ALL FIVE FLAGS, BEFORE AND AFTER. The claim is that the guardian closed the
  // EXIT; a call that also flipped supply, transfer, absorb or buy is a
  // different experiment. Re-sending the observed values is not a substitute
  // for checking them: it assumes `pause()` does what its name says, which is
  // the assumption the whole fork differential exists to avoid making.
  const before = await readPauseFlags("before isolated candidate mutation");
  const pauseTx = {
    to: target,
    data: cometWithdrawPauseCalldata({
      supply: before.flags.supply, transfer: before.flags.transfer, absorb: before.flags.absorb, buy: before.flags.buy,
    }),
    gas: 300_000n,
  };
  const pause = await fork.sendFrom(guardian, pauseTx);
  const pauseEvidence = transactionEvidence("guardian pause withdrawals", guardian, pauseTx, pause, req.blockNumber);
  // Read back even when the transaction reverted: "the flags did not move" is
  // an observation, and inferring it from the receipt would be an assumption.
  const after = await readPauseFlags("after isolated candidate mutation");
  const collateralFlagChanges = changedFlags(before.flags, after.flags);
  /** Everything that moved BESIDES the exit flag — i.e. the reason attribution would be unsound. */
  const unexpectedFlagChanges = collateralFlagChanges.filter((key) => key !== "withdraw");
  const onlyWithdrawMoved =
    collateralFlagChanges.length === 1 && collateralFlagChanges[0] === "withdraw";

  for (const item of working) {
    // Chronological: the before-readings, then the transaction, then the
    // after-readings. Explicit entries, never a positional slice of a shared
    // growing array.
    item.evidence.push(...before.evidence, pauseEvidence, ...after.evidence);
    const beforeMutation = await readPosition(fork, target, item.address, item.holder, "before collateral withdrawal after mutation", req.blockNumber, item.evidence);
    const tx = { to: target, data: cometWithdrawCalldata(item.address, item.amount), gas: 900_000n };
    const result = await fork.sendFrom(item.holder, tx);
    item.evidence.push(transactionEvidence("collateral withdrawal after guardian mutation", item.holder, tx, result, req.blockNumber));
    const afterMutation = await readPosition(fork, target, item.address, item.holder, "after collateral withdrawal after mutation", req.blockNumber, item.evidence);

    let state: AssetScenarioState = "inconclusive";
    let detail: string;
    const timesMatch = item.beforeBaseline?.block === beforeMutation.block && item.beforeBaseline?.timestamp === beforeMutation.timestamp &&
      item.afterBaseline?.block === afterMutation.block && item.afterBaseline?.timestamp === afterMutation.timestamp;
    if (!item.baselineOk) {
      state = "baseline_unestablished";
      detail = item.baselineDetail;
    } else if (!timesMatch || !item.beforeBaseline || !samePosition(item.beforeBaseline, beforeMutation)) {
      detail = "Control and mutation branches did not begin from the same position at the same fork block/time.";
    } else if (pause.status !== "success" || before.flags.withdraw || !after.flags.withdraw) {
      detail = "The guardian call did not establish the required isWithdrawPaused false-to-true transition.";
    } else if (!onlyWithdrawMoved) {
      // The withdraw flag DID move, but so did others. The exit may well be
      // shut — the point is that this experiment no longer isolates WHY, and a
      // restriction attributed to the wrong mutation is a wrong finding.
      detail = `The guardian call changed more than the exit flag (also: ${unexpectedFlagChanges.join(", ")}), so the withdrawal outcome cannot be attributed to the withdraw-pause mutation alone.`;
    } else if (result.status === "reverted" && result.revertData?.toLowerCase() === COMET_PAUSED_ERROR.toLowerCase() &&
      result.gasUsed < tx.gas && samePosition(beforeMutation, afterMutation)) {
      state = "restrictor_confirmed";
      detail = `DIFFERENTIAL CONFIRMED: ${item.baselineDetail} The guardian then changed withdraw-pause false → true — and no other pause flag — and the identical collateral withdrawal at the same block/time reverted with Paused(), leaving the position unchanged. ${party.note}`;
    } else if (result.status === "success" && successfulCollateralExit(beforeMutation, afterMutation, item.amount) &&
      afterMutation.tokens - beforeMutation.tokens === item.recovered) {
      state = "no_effect";
      detail = `The pause transition executed — withdraw-pause false → true and no other flag — but the identical collateral withdrawal still recovered ${item.recovered} units and cleared the position. This ONE privileged action did not close THIS exit for THIS asset in THIS experiment. It is not a clean result for the asset, the exit or the protocol: other functions, arguments, sequences and economic conditions were not tested.`;
    } else {
      detail = "The post-mutation withdrawal did not produce the expected Paused() restriction or an exactly matching successful exit; the result is inconclusive.";
    }
    scenarios.push({
      address: item.address.toLowerCase(), assetRole: "collateral", state,
      holder: item.holder, suppliedRaw: item.amount.toString(), recoveredRaw: item.recovered?.toString() ?? null,
      guardian, guardianType: party.type, noticeSeconds,
      detail, evidence: item.evidence, caveats: [...commonCaveats, party.note],
    });
  }

  const order = new Map(inputs.map((input, index) => [input.address.toLowerCase(), index]));
  scenarios.sort((a, b) => (order.get(a.address) ?? 999) - (order.get(b.address) ?? 999));
  return batch(req, startedAt, scenarios, [
    `The candidate ran from an isolated pre-candidate fork state against the real Compound III withdraw-pause mutation.`,
    `At most ${assetScenarioCandidateCap} pinned candidates are considered per fork batch.`,
    // Stated in the artifact, not only in a document, because this is what a
    // reader needs in order to know what a clean row here is worth.
    "EXPERIMENTAL: this adapter covers one Compound III collateral-withdrawal action and one guardian pause mutation. A confirmed restriction is demonstrated; the absence of one is not evidence of safety.",
    ...(timedOutAfter === null ? [] : [`The batch reached its time limit after ${timedOutAfter} candidate(s); the rest are recorded as inconclusive, not omitted.`]),
  ]);
}
