/**
 * The Exit-Restriction Engine (day 7, THE FORK DIFFERENTIAL).
 *
 * Every layer before this REASONS about whether a privileged party can close a
 * holder's exit. This one TESTS it. On a sandbox anvil fork pinned to the report
 * block it:
 *   1. identifies the exit action (Part 1 — how a holder actually leaves),
 *   2. establishes a BASELINE: a real holder position for whom that exit
 *      succeeds before any mutation (Part 2 — the control),
 *   3. for each restriction candidate registered by the matched archetype, snapshots the fork,
 *      impersonates the party that guards it, calls it with the exit-restricting
 *      argument, and re-runs the exit at the same block/time (Part 3). A pause
 *      transition plus the expected Paused() revert establishes the restriction.
 *
 * THE EPISTEMIC CEILING is honoured, not hidden. A clean run is NEVER a safety
 * guarantee and never reuses `can_exit_in_time`; its outcome is the deliberately
 * weaker `no_direct_restriction_found`, scoped to the N registered candidates evaluated. A
 * found restrictor is decisive and, if its party imposes no delay, a zero-notice
 * route that caps the verdict.
 *
 * Honesty rails, load-bearing:
 *   - Everything runs on the ephemeral fork. No mainnet tx, no key, no approval.
 *   - Capability, not intent, in every string: a party CAN close the exit.
 *   - A Safe-guarded restrictor is impersonated AT THE SAFE ADDRESS, so it
 *     assumes the Safe can authorize the call. Signatures, guards and modules
 *     are not executed; that condition is stated on the finding.
 *   - FAIL LOUD: an unestablished baseline or an unidentifiable exit action is
 *     an explicit `undetermined`-producing outcome, never a fabricated clean run.
 */
import { encodeFunctionData, getAddress, maxUint256, type Hex } from "viem";
import { startAnvilFork, type ForkHandle, type ForkTransactionResult } from "./anvil.js";
import { checkAnvilAvailable } from "./preflight.js";
import {
  BASE_TOKEN_WHALES,
  COMET_PAUSED_ERROR,
  cometAbi,
  cometSupplyCalldata,
  cometWithdrawCalldata,
  cometWithdrawPauseCalldata,
  exitActionsVersion,
  identifyExitInterface,
  SELECTORS,
} from "./exitActions.js";
import { fullWithdrawalVerified, readWithdrawalPosition, samePosition } from "./withdrawal.js";
import { notifyFork, type ForkObserver, type ForkParty } from "../report/observer.js";
import type { Evidence } from "../chain/client.js";
import type {
  AuthorityResolution,
  CapabilitiesResult,
  EnumerationCompleteness,
  ExitRestriction,
  ExitWindow,
  ExitWindowRoute,
  RestrictionCandidate,
} from "../report/schema.js";

const SANDBOX_NOTE =
  "Executed only on an ephemeral anvil mainnet fork pinned to the report block. No mainnet transaction was sent, no private key was used or held, no approval was requested. The differential shows what a privileged party CAN do to a holder's exit in simulation — a capability, not a prediction of intent.";

const CEILING = [
  "Exit-action identification: the differential tests the exit function Ripcord identified from the contract's interface. If a holder's real exit path differs from the one tested, this evaluation does not cover it — testing the wrong exit function would be a false-clean, which is why an unidentified exit action keeps the verdict undetermined instead.",
  "Argument space is NOT exhausted: each restriction candidate was tried with one bounded, documented exit-restricting argument (e.g. withdraw-pause = true). Other argument combinations, and any privileged function outside the evaluated guarded set, were not swept — absence of a restrictor here is not proof none exists.",
  "Indirect and economic restrictions are OUT OF SCOPE: oracle manipulation, collateral/liquidity configuration, fee or rate changes, and multi-call sequences can restrict an exit without any single function reverting it, and none of those were tested.",
];

const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

const safeAbi = [
  { type: "function", name: "getThreshold", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getOwners", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] },
] as const;

export interface ExitRestrictionRequest {
  chainId: number;
  rpcUrl: string;
  blockNumber: bigint;
  target: Hex;
  capabilities: CapabilitiesResult;
  /** Aggregate, fail-closed witness over roles, authority recursion, dependencies and the privileged selector surface. */
  enumeration: EnumerationCompleteness;
  exitWindow: ExitWindow | null;
  authorityResolution: AuthorityResolution | null;
  /**
   * Optional presentation-only progress hooks (see report/observer.ts). Purely
   * additive: hooks cannot throw out of `notifyFork`, receive evidence the
   * engine already recorded, and nothing they do is read back. A differential
   * run with an observer attached produces the identical ExitRestriction.
   */
  observer?: ForkObserver;
}

export interface ExitRestrictionResult {
  exitRestriction: ExitRestriction;
  /** A synthetic exit-window route for a fork-confirmed restrictor, for the caller to inject. Null otherwise. */
  restrictorRoute: ExitWindowRoute | null;
}

export interface CandidateEvaluationConclusion {
  outcome: Extract<ExitRestriction["outcome"], "restrictor_found" | "no_direct_restriction_found" | "evaluation_inconclusive">;
  restrictors: RestrictionCandidate[];
  evaluationGaps: string[];
  restrictionState: Extract<ExitRestriction["restrictionState"], "restrictable" | "none_found" | "undetermined">;
  confirmationMethod: ExitRestriction["confirmationMethod"];
}

/**
 * Pure, fail-closed composition of the candidate differential. A demonstrated
 * restrictor wins even when enumeration is incomplete (unseen functions can
 * only add more restrictors). The clean direction is the inverse: every
 * candidate must positively say no_effect AND aggregate enumeration must be
 * complete, otherwise the only honest outcome is evaluation_inconclusive.
 */
export function classifyCandidateEvaluation(
  candidates: RestrictionCandidate[],
  enumeration: EnumerationCompleteness,
): CandidateEvaluationConclusion {
  const restrictors = candidates.filter((candidate) => candidate.result === "restrictor");
  const evaluationGaps = [
    ...(candidates.length === 0 ? ["no registered candidates were evaluated"] : []),
    ...candidates
      .filter((candidate) => candidate.result === "inconclusive" || candidate.result === "not_evaluated")
      .map((candidate) => `candidate ${candidate.selector} returned ${candidate.result}: ${candidate.detail}`),
    ...(!enumeration.complete
      ? (enumeration.gaps.length ? enumeration.gaps.map((gap) => `aggregate enumeration incomplete at ${gap.where}: ${gap.reason}`) : ["aggregate enumeration is incomplete"])
      : []),
  ];

  if (restrictors.length > 0) {
    return { outcome: "restrictor_found", restrictors, evaluationGaps, restrictionState: "restrictable", confirmationMethod: "fork_confirmed" };
  }
  if (evaluationGaps.length > 0) {
    return { outcome: "evaluation_inconclusive", restrictors: [], evaluationGaps, restrictionState: "undetermined", confirmationMethod: "not_confirmed" };
  }
  return { outcome: "no_direct_restriction_found", restrictors: [], evaluationGaps: [], restrictionState: "none_found", confirmationMethod: "fork_confirmed" };
}

function ev(params: Record<string, unknown>, rawValue: unknown, block: bigint): Evidence {
  return { kind: "call", params, rawValue, block: block.toString() };
}

/** A complete, ordered fork-transaction witness. Hashes are fork-local, never mainnet transaction hashes. */
function txEv(
  action: string,
  from: Hex,
  tx: { to?: Hex; data?: Hex; value?: bigint; gas?: bigint },
  result: ForkTransactionResult,
  forkBlock: bigint,
): Evidence {
  return ev(
    {
      method: "eth_sendTransaction",
      forkOnly: true,
      action,
      from,
      to: tx.to ?? null,
      calldata: tx.data ?? "0x",
      selector: tx.data && tx.data.length >= 10 ? tx.data.slice(0, 10) : null,
      value: (tx.value ?? 0n).toString(),
      gasLimit: (tx.gas ?? 3_000_000n).toString(),
    },
    {
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
    },
    forkBlock,
  );
}

/** All selectors the dispatcher recovered — matched findings plus the unmatched remainder. */
function allSelectors(caps: CapabilitiesResult): string[] {
  return [...caps.findings.map((f) => f.selector), ...caps.needsManualVerification.map((f) => f.selector), ...caps.unmatchedSelectors];
}

/** Minimal fork-side account classification: safe (getOwners+getThreshold) / eoa (no code) / contract. */
async function classifyOnFork(
  fork: ForkHandle,
  addr: Hex,
): Promise<{ type: "safe" | "eoa" | "contract"; threshold: number | null; owners: number | null }> {
  const code = await fork.client.getCode({ address: addr });
  if (!code || code === "0x") return { type: "eoa", threshold: null, owners: null };
  try {
    const threshold = (await fork.client.readContract({ address: addr, abi: safeAbi, functionName: "getThreshold" })) as bigint;
    const owners = (await fork.client.readContract({ address: addr, abi: safeAbi, functionName: "getOwners" })) as readonly Hex[];
    return { type: "safe", threshold: Number(threshold), owners: owners.length };
  } catch {
    return { type: "contract", threshold: null, owners: null };
  }
}

function notRun(req: ExitRestrictionRequest, outcome: ExitRestriction["outcome"], reason: string, exitAction: ExitRestriction["exitAction"]): ExitRestrictionResult {
  return {
    restrictorRoute: null,
    exitRestriction: {
      rulesVersion: exitActionsVersion,
      attempted: outcome !== "not_run",
      archetype: "baseline exit vs. guarded restriction-family functions (Compound III / Comet base-withdrawal archetype)",
      outcome,
      exitAction,
      baseline: { status: "not_attempted", holder: null, holderSource: reason, note: reason, evidence: [] },
      candidates: [],
      restrictors: [],
      evaluationGaps: [],
      coverage: { guardedTotal: 0, evaluated: 0 },
      restrictionState: "undetermined",
      confirmationMethod: "not_confirmed",
      forkBlock: req.blockNumber.toString(),
      sandboxNote: SANDBOX_NOTE,
      ceiling: CEILING,
      reproduceCommand: null,
      evidence: [],
    },
  };
}

export async function runExitRestrictionEngine(req: ExitRestrictionRequest): Promise<ExitRestrictionResult> {
  const selectors = allSelectors(req.capabilities);

  // --- Part 1: identify the exit action. Unconfident → undetermined. ---
  notifyFork(req.observer, "onForkStart", "exit_action");
  const iface = identifyExitInterface(selectors);
  if (!iface) {
    notifyFork(req.observer, "onForkStep", {
      phase: "exit_action",
      outcome: "inconclusive",
      detail:
        "No registered exit-interface fingerprint matched the decoded selectors. Testing an unidentified exit function would risk a false-clean, so the differential is refused rather than run against a guess.",
    });
    return notRun(req, "exit_action_unconfident", "no known exit interface fingerprint matched the decoded selectors, so the exit action could not be confidently identified — the differential is refused rather than run against a guessed exit function", {
      status: "unconfident",
      interfaceName: "none",
      signature: null,
      selector: null,
      confidence: "low",
      note: "No exit interface matched. Testing an unidentified exit would risk a false-clean, so the engine does not run.",
      evidence: [],
    });
  }
  const exitAction: ExitRestriction["exitAction"] = {
    status: "identified",
    interfaceName: iface.id,
    signature: iface.exitSignature,
    selector: iface.exitSelector,
    confidence: iface.confidence,
    note: `${iface.label}: a holder leaves by calling ${iface.exitSignature}. Identified by the fingerprint ${iface.fingerprint.join(", ")} in the decoded selector set.`,
    evidence: [ev({ fingerprint: iface.fingerprint, matchedFrom: "capabilities.selectorsExtracted" }, iface.id, req.blockNumber)],
  };
  notifyFork(req.observer, "onForkStep", {
    phase: "exit_action",
    outcome: "completed",
    detail: `${iface.label}: a holder leaves by calling ${iface.exitSignature}. Matched on the full fingerprint ${iface.fingerprint.join(", ")}.`,
    evidence: exitAction.evidence,
  });

  // Only the Comet archetype is implemented end-to-end. Any other identified
  // interface is honestly reported as not-yet-evaluated rather than guessed at.
  if (iface.id !== "compound-comet-base") {
    notifyFork(req.observer, "onForkStep", {
      phase: "verdict",
      outcome: "inconclusive",
      detail: `The exit action was identified (${iface.id}), but no differential archetype is implemented for it. The scan stands; the withdrawal experiment was not run.`,
    });
    return notRun(req, "no_candidates", `exit action identified (${iface.id}) but its differential archetype is not implemented — reported honestly rather than run partially`, exitAction);
  }

  let anvilExecutable: string;
  try {
    anvilExecutable = (await checkAnvilAvailable()).executable;
  } catch (err) {
    notifyFork(req.observer, "onForkStep", {
      phase: "verdict",
      outcome: "degraded",
      detail: "The fork sandbox is unavailable, so no withdrawal experiment was performed. The static scan is unaffected.",
    });
    return notRun(req, "not_run", err instanceof Error ? err.message : String(err), exitAction);
  }

  const fork = await startAnvilFork({ rpcUrl: req.rpcUrl, blockNumber: req.blockNumber, anvilExecutable });
  try {
    return await runCometArchetype(req, fork, exitAction);
  } finally {
    await fork.stop();
  }
}

async function runCometArchetype(
  req: ExitRestrictionRequest,
  fork: ForkHandle,
  exitAction: ExitRestriction["exitAction"],
): Promise<ExitRestrictionResult> {
  const evidence: Evidence[] = [];
  const target = req.target;
  const HOLDER: Hex = "0x000000000000000000000000000000000000abc1";
  const CONTROL_SINK: Hex = "0x000000000000000000000000000000000000abc2";
  notifyFork(req.observer, "onForkStart", "baseline");
  // Every early return below is a baseline that could not be established. Each
  // one reports through here, so the UI can never show a blank baseline block
  // and let a reader infer the control simply had not happened yet.
  const baseUnattempted = (reason: string): ExitRestrictionResult => {
    notifyFork(req.observer, "onForkStep", {
      phase: "baseline",
      outcome: "inconclusive",
      detail: `Baseline NOT established: ${reason}. Without a control exit that succeeds first, no later revert can be attributed to a privileged mutation, so the differential does not run.`,
      evidence: [...evidence],
    });
    return baseUnattemptedResult(reason);
  };
  const baseUnattemptedResult = (reason: string): ExitRestrictionResult => ({
    restrictorRoute: null,
    exitRestriction: mkRestriction(req, exitAction, {
      outcome: "baseline_unestablished",
      baseline: { status: "unestablished", holder: HOLDER, holderSource: "deterministic sandbox supplier", note: reason, evidence: [...evidence] },
      candidates: [], restrictors: [], evaluationGaps: [reason],
      coverage: { guardedTotal: 1, evaluated: 0 },
      restrictionState: "undetermined", confirmationMethod: "not_confirmed", evidence,
    }),
  });
  const read = async (functionName: string, phase: string) => {
    const head = await fork.client.getBlock();
    const data = encodeFunctionData({ abi: cometAbi, functionName });
    const value = await fork.client.readContract({ address: target, abi: cometAbi, functionName, blockNumber: head.number });
    evidence.push(ev({ method: "eth_call", address: target, data, read: `${functionName}()`, phase,
      localBlock: head.number.toString(), localTimestamp: head.timestamp.toString(), forkOnly: true }, value, req.blockNumber));
    return value;
  };
  const baseToken = getAddress(await read("baseToken", "identify") as Hex);
  const guardian = getAddress(await read("pauseGuardian", "identify") as Hex);
  const whale = BASE_TOKEN_WHALES[baseToken.toLowerCase()];
  if (!whale) return baseUnattempted(`no curated whale for base token ${baseToken}`);
  const initialPaused = await read("isWithdrawPaused", "before setup") as boolean;
  // A current pause is observable, but does not establish an exitable position
  // or a before/after causal witness. Do not fabricate an authority route.
  if (initialPaused) return baseUnattempted("withdrawals are paused before setup; no successful baseline can be established, and no privileged mutation was tested");
  const otherFlags = {
    supply: await read("isSupplyPaused", "before setup") as boolean,
    transfer: await read("isTransferPaused", "before setup") as boolean,
    absorb: await read("isAbsorbPaused", "before setup") as boolean,
    buy: await read("isBuyPaused", "before setup") as boolean,
  };
  const sinkCode = await fork.client.getCode({ address: CONTROL_SINK });
  if (sinkCode && sinkCode !== "0x") return baseUnattempted("the neutral control recipient has code; refusing a control transaction with unknown side effects");
  const observe = (phase: string) => readWithdrawalPosition(fork, target, baseToken, HOLDER, phase, req.blockNumber, evidence);
  let initial;
  try { initial = await observe("before funding"); }
  catch { return baseUnattempted("could not read the holder's token balance and protocol position before funding"); }
  if (initial.tokens !== 0n || initial.principal !== 0n || initial.supplied !== 0n || initial.borrowed !== 0n) {
    return baseUnattempted("the sandbox holder already has tokens or a protocol position; refusing to attribute pre-existing value to this setup");
  }
  const fundAmount = 100_000n * 10n ** BigInt(whale.decimals);
  const supplyAmount = 50_000n * 10n ** BigInt(whale.decimals);
  for (const acct of [whale.whale, HOLDER, guardian]) {
    await fork.client.setBalance({ address: acct, value: 10n ** 18n });
    await fork.client.impersonateAccount({ address: acct });
  }
  const send = async (action: string, from: Hex, tx: { to: Hex; data?: Hex; gas: bigint }) => {
    const result = await fork.sendFrom(from, tx);
    evidence.push(txEv(action, from, tx, result, req.blockNumber));
    return result;
  };
  const fund = await send("fund holder", whale.whale, { to: baseToken, data: encodeErc20Transfer(HOLDER, fundAmount), gas: 200_000n });
  if (fund.status !== "success") return baseUnattempted("funding the holder reverted");
  const funded = await observe("after funding");
  if (funded.tokens - initial.tokens !== fundAmount) return baseUnattempted("funding transaction succeeded but the expected base tokens were not received");
  const approve = await send("approve base token", HOLDER, { to: baseToken, data: encodeErc20Approve(target, fundAmount), gas: 100_000n });
  if (approve.status !== "success") return baseUnattempted("base-token approval reverted");
  const supply = await send("supply baseline position", HOLDER, { to: target, data: cometSupplyCalldata(baseToken, supplyAmount), gas: 900_000n });
  if (supply.status !== "success") return baseUnattempted("supplying the baseline position reverted");
  const supplied = await observe("after supply");
  if (funded.tokens - supplied.tokens !== supplyAmount || supplied.principal <= 0n || supplied.supplied <= 0n || supplied.borrowed !== 0n) {
    return baseUnattempted("supply receipt succeeded but the expected token debit and positive debt-free base position were not established");
  }

  // Both branches start from this position. A neutral transaction occupies the
  // mutation's block and guardian nonce in the control branch. The fork restores
  // its clock on revert, so corresponding reads and exits have identical times.
  const baseSnap = await fork.snapshot();
  const withdrawTx = { to: target, data: cometWithdrawCalldata(baseToken, maxUint256), gas: 900_000n };
  const control = await send("neutral control step", guardian, { to: CONTROL_SINK, gas: 21_000n });
  if (control.status !== "success") {
    await fork.revert(baseSnap);
    return baseUnattempted("neutral control transaction failed");
  }
  const beforeBaseline = await observe("before baseline withdrawal");
  const baselineWithdraw = await send("baseline holder withdraw", HOLDER, withdrawTx);
  const afterBaseline = await observe("after baseline withdrawal");
  await fork.revert(baseSnap);
  if (baselineWithdraw.status !== "success" || !fullWithdrawalVerified(beforeBaseline, afterBaseline)) {
    return baseUnattempted("baseline full withdrawal did not both succeed and recover the supplied base assets with zero remaining principal and no debt; its cause is unestablished, not a demonstrated restriction");
  }
  const recovered = afterBaseline.tokens - beforeBaseline.tokens;
  const baseline: ExitRestriction["baseline"] = {
    status: "established", holder: HOLDER,
    holderSource: `funded 100k ${whale.symbol} from whale ${whale.whale}, supplied 50k, then withdrew the full base position (uint256.max)`,
    note: `receipt success AND ${recovered} base-token units received, zero remaining principal, zero supply and zero debt; control and mutation use the same fork clock`,
    evidence: [...evidence],
  };
  notifyFork(req.observer, "onForkStep", {
    phase: "baseline",
    outcome: "completed",
    // The economic facts, not just the receipt: a successful receipt alone is
    // not an exit, which is why the recovered amount and the cleared position
    // are stated here rather than "withdraw succeeded".
    detail: `Baseline ESTABLISHED: the holder was funded 100k ${whale.symbol}, supplied 50k, and withdrew the full base position — ${recovered} base-token units received back, zero remaining principal, zero supply, zero debt.`,
    evidence: [...evidence],
  });

  const guardianClass = await classifyOnFork(fork, guardian);
  // The guarding party as a first-class observation. It is read from the
  // contract's own pauseGuardian() and classified on the fork, so it is found
  // information — but no static detector reaches it (it is neither owner(), nor
  // a role member, nor the proxy admin), which is exactly why it has to be
  // reported explicitly rather than left to appear in prose alone.
  const forkParty = (confirmed: boolean): ForkParty => ({
    address: guardian,
    type: guardianClass.type,
    safeThreshold: guardianClass.threshold,
    safeOwners: guardianClass.owners,
    signature: "pause(bool,bool,bool,bool,bool)",
    relation: "can pause withdrawals of",
    confirmed,
  });
  notifyFork(req.observer, "onForkStart", "mutation");
  const diffSnap = await fork.snapshot();
  const candidateStart = evidence.length;
  const pausedBefore = await read("isWithdrawPaused", "before candidate mutation") as boolean;
  const pauseTx = { to: target, data: cometWithdrawPauseCalldata(otherFlags), gas: 300_000n };
  const pause = await send("guardian pause withdraw", guardian, pauseTx);
  let result: RestrictionCandidate["result"] = "inconclusive";
  let detail = "the guardian mutation reverted; no effect on withdrawal was established";
  try {
    if (pause.status !== "success") {
      notifyFork(req.observer, "onForkStep", {
        phase: "mutation",
        outcome: "inconclusive",
        detail: `The guarding party's call reverted, so nothing was learned about the exit. A failed mutation is NOT evidence that the exit is safe — it is an absence of evidence either way.`,
        evidence: evidence.slice(candidateStart),
      });
    } else {
      const pausedAfter = await read("isWithdrawPaused", "after candidate mutation") as boolean;
      notifyFork(req.observer, "onForkStep", {
        phase: "mutation",
        // The false→true transition is the mutation's whole content. Without
        // it there is no cause to attribute a later revert to.
        outcome: !pausedBefore && pausedAfter ? "completed" : "inconclusive",
        detail:
          !pausedBefore && pausedAfter
            ? `${guardian} (${guardianClass.type}${guardianClass.type === "safe" ? ` ${guardianClass.threshold}-of-${guardianClass.owners}` : ""}) called pause(bool,bool,bool,bool,bool) with withdraw-pause = true, other pause flags preserved. isWithdrawPaused observed false → true.`
            : `The call succeeded but the required isWithdrawPaused false→true transition was not observed (before=${pausedBefore}, after=${pausedAfter}), so no cause is established.`,
        evidence: evidence.slice(candidateStart),
        // Not yet `confirmed`: the party has been shown able to flip the flag,
        // but whether that actually closes the exit is decided by the re-exit
        // below. Claiming it here would be one step ahead of the evidence.
        party: forkParty(false),
      });
      notifyFork(req.observer, "onForkStart", "reexit");
      const reexitStart = evidence.length;
      const beforeMutationExit = await observe("before withdrawal after candidate");
      const afterWithdraw = await send("holder withdraw after candidate", HOLDER, withdrawTx);
      const afterMutationExit = await observe("after withdrawal after candidate");
      notifyFork(req.observer, "onForkStep", {
        phase: "reexit",
        // Either way this step RAN AND ANSWERED. Which answer it gave is the
        // differential's content, decided below — not this step's status.
        outcome: "completed",
        detail:
          afterWithdraw.status === "reverted"
            ? `The identical withdrawal, from the same starting position at the same fork block and timestamp, REVERTED${afterWithdraw.revertData ? ` with ${afterWithdraw.revertData}` : ""}. The holder's tokens and principal are unchanged.`
            : `The identical withdrawal still succeeded after the mutation.`,
        evidence: evidence.slice(reexitStart),
      });
      const timesMatch = beforeBaseline.block === beforeMutationExit.block && beforeBaseline.timestamp === beforeMutationExit.timestamp &&
        afterBaseline.block === afterMutationExit.block && afterBaseline.timestamp === afterMutationExit.timestamp;
      const stateMatches = samePosition(beforeBaseline, beforeMutationExit);
      if (!timesMatch || !stateMatches) {
        detail = "control and mutation branches did not have matching withdrawal times and starting balances; causality is unestablished";
      } else if (pausedBefore || !pausedAfter) {
        detail = "the mutation did not establish the required isWithdrawPaused false-to-true transition";
      } else if (afterWithdraw.status === "reverted") {
        if (afterWithdraw.revertData?.toLowerCase() === COMET_PAUSED_ERROR.toLowerCase() &&
          afterWithdraw.gasUsed < withdrawTx.gas &&
          afterMutationExit.tokens === beforeMutationExit.tokens && afterMutationExit.principal === beforeMutationExit.principal &&
          afterMutationExit.borrowed === 0n) {
          result = "restrictor";
          detail = "DIFFERENTIAL CONFIRMED: the control recovered the full base position; the guardian changed withdraw-pause from false to true, and the identical withdrawal at the same block/time reverted with Paused(), leaving the holder's tokens and principal unchanged.";
        } else {
          detail = "withdrawal reverted, but the expected Paused() cause and unchanged balances were not confirmed (an unrelated failure or gas limit is not a proven restrictor)";
        }
      } else if (fullWithdrawalVerified(beforeMutationExit, afterMutationExit) && afterMutationExit.tokens - beforeMutationExit.tokens === recovered) {
        result = "no_effect";
        detail = "the pause transition executed, but the identical full withdrawal recovered the same base assets and cleared the position; no direct restriction in this evaluated scenario";
      } else {
        detail = "withdrawal receipt succeeded but recovery of the full base position did not match the control; no clean outcome is justified";
      }
    }
  } finally {
    await fork.revert(diffSnap);
  }
  if (guardianClass.type === "safe") {
    detail += ` The ${guardianClass.threshold}-of-${guardianClass.owners} Safe was impersonated: this result assumes it can authorize and submit the call; signatures, transaction guards and modules were not executed.`;
  } else if (guardianClass.type === "contract") {
    detail += " The contract controller was impersonated; its own execution constraints and notice were not established.";
  }
  const candidate: RestrictionCandidate = {
    selector: SELECTORS.cometPause, signature: "pause(bool,bool,bool,bool,bool)", category: "ACCESS_RESTRICTION",
    guardingParty: guardian, guardingPartyType: guardianClass.type, args: "withdraw-pause = true; other pause flags preserved",
    result, noticeSeconds: guardianClass.type === "contract" ? null : "0", detail,
    evidence: evidence.slice(candidateStart),
  };
  const conclusion = classifyCandidateEvaluation([candidate], req.enumeration);
  notifyFork(req.observer, "onForkStep", {
    phase: "verdict",
    // Only a demonstrated restrictor is a completed conclusion. The clean tier
    // and the inconclusive tier both leave a question open, and neither may
    // wear the same status as a decisive result.
    outcome: conclusion.outcome === "restrictor_found" ? "completed" : "inconclusive",
    detail: candidate.detail,
    party: forkParty(conclusion.outcome === "restrictor_found"),
  });
  return {
    restrictorRoute: conclusion.restrictors.length ? buildRestrictorRoute(target, candidate, guardianClass) : null,
    exitRestriction: mkRestriction(req, exitAction, {
      ...conclusion, baseline, candidates: [candidate], coverage: { guardedTotal: 1, evaluated: 1 }, evidence,
    }),
  };
}

/** Assembles the ExitRestriction from the parts that vary, filling the invariant fields. */
function mkRestriction(
  req: ExitRestrictionRequest,
  exitAction: ExitRestriction["exitAction"],
  parts: Pick<ExitRestriction, "outcome" | "baseline" | "candidates" | "restrictors" | "coverage" | "restrictionState" | "confirmationMethod" | "evidence"> &
    Partial<Pick<ExitRestriction, "evaluationGaps">>,
): ExitRestriction {
  return {
    rulesVersion: exitActionsVersion,
    attempted: true,
    archetype: "baseline exit vs. guarded restriction-family functions (Compound III / Comet base-withdrawal archetype)",
    exitAction,
    forkBlock: req.blockNumber.toString(),
    sandboxNote: SANDBOX_NOTE,
    ceiling: CEILING,
    reproduceCommand: `ripcord restrict ${req.target} --block ${req.blockNumber} --chain ${req.chainId}`,
    evaluationGaps: [],
    ...parts,
  };
}

/** A fork-confirmed exit restrictor becomes a synthetic exit-window route so the window arithmetic sees it. */
function buildRestrictorRoute(
  target: Hex,
  candidate: RestrictionCandidate,
  guardianClass: { type: "safe" | "eoa" | "contract"; threshold: number | null; owners: number | null },
): ExitWindowRoute | null {
  // EOAs have no controller contract; Safe notice is conditional on its own
  // authorization succeeding. Unresolved contracts never earn an immediate route.
  if (candidate.guardingPartyType === "contract" || candidate.noticeSeconds !== "0") return null;
  const party = candidate.guardingParty ?? target;
  return {
    label: "exit-restrictor:pauseGuardian",
    rolePrivilege: "not_a_role",
    rolePrivilegeNote: "fork-confirmed exit restrictor — privilege DEMONSTRATED by the differential, not inferred from a role or a guard-probe revert",
    root: party,
    effectiveController: party,
    effectiveControllerType: guardianClass.type === "safe" ? "safe" : guardianClass.type === "eoa" ? "eoa" : "contract",
    terminationReason: guardianClass.type === "safe" ? "safe" : guardianClass.type === "eoa" ? "eoa" : "no_authority_found",
    noticeStatus: "immediate",
    noticeSeconds: "0",
    nominalDelaySeconds: "0",
    timelock: null,
    categories: ["ACCESS_RESTRICTION"],
    confidence: "high",
    note: candidate.detail,
    confirmationMethod: "fork_confirmed",
    restrictionState: "restrictable",
  };
}

function encodeErc20Transfer(to: Hex, amount: bigint): Hex {
  return encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] });
}
function encodeErc20Approve(spender: Hex, amount: bigint): Hex {
  return encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] });
}
