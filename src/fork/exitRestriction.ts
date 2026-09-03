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
 *      argument, and re-runs the exit (Part 3 — the differential). Exit now
 *      fails → that function is a direct exit-restrictor, demonstrated.
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
 *     demonstrates "this Safe can, if its signers collude," not "one key can" —
 *     stated on the finding (same rail as the proof engine's KNOWN EDGE #9).
 *   - FAIL LOUD: an unestablished baseline or an unidentifiable exit action is
 *     an explicit `undetermined`-producing outcome, never a fabricated clean run.
 */
import { encodeFunctionData, getAddress, type Hex } from "viem";
import { startAnvilFork, type ForkHandle, type ForkTransactionResult } from "./anvil.js";
import { checkAnvilAvailable } from "./preflight.js";
import {
  BASE_TOKEN_WHALES,
  cometAbi,
  cometSupplyCalldata,
  cometWithdrawCalldata,
  cometWithdrawPauseCalldata,
  exitActionsVersion,
  identifyExitInterface,
  SELECTORS,
} from "./exitActions.js";
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
    ...candidates
      .filter((candidate) => candidate.result === "inconclusive" || candidate.result === "not_evaluated")
      .map((candidate) => `candidate ${candidate.selector} returned ${candidate.result}: ${candidate.detail}`),
    ...(!enumeration.complete
      ? enumeration.gaps.map((gap) => `aggregate enumeration incomplete at ${gap.where}: ${gap.reason}`)
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
      },
      revertData: result.revertData,
    },
    forkBlock,
  );
}

/** All selectors the dispatcher recovered — matched findings plus the unmatched remainder. */
function allSelectors(caps: CapabilitiesResult): string[] {
  return [...caps.findings.map((f) => f.selector), ...caps.unmatchedSelectors];
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
  const iface = identifyExitInterface(selectors);
  if (!iface) {
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

  // Only the Comet archetype is implemented end-to-end. Any other identified
  // interface is honestly reported as not-yet-evaluated rather than guessed at.
  if (iface.id !== "compound-comet-base") {
    return notRun(req, "no_candidates", `exit action identified (${iface.id}) but its differential archetype is not implemented — reported honestly rather than run partially`, exitAction);
  }

  let anvilExecutable: string;
  try {
    anvilExecutable = (await checkAnvilAvailable()).executable;
  } catch (err) {
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

  const baseToken = getAddress(
    (await fork.client.readContract({ address: target, abi: cometAbi, functionName: "baseToken" })) as Hex,
  );
  const guardian = getAddress(
    (await fork.client.readContract({ address: target, abi: cometAbi, functionName: "pauseGuardian" })) as Hex,
  );
  evidence.push(ev({ read: "baseToken()" }, baseToken, req.blockNumber));
  evidence.push(ev({ read: "pauseGuardian()" }, guardian, req.blockNumber));

  const whale = BASE_TOKEN_WHALES[baseToken.toLowerCase()];
  const baseUnattempted = (reason: string): ExitRestrictionResult => ({
    restrictorRoute: null,
    exitRestriction: mkRestriction(req, exitAction, {
      outcome: "baseline_unestablished",
      baseline: { status: "unestablished", holder: null, holderSource: reason, note: reason, evidence },
      candidates: [],
      restrictors: [],
      coverage: { guardedTotal: 0, evaluated: 0 },
      restrictionState: "undetermined",
      confirmationMethod: "not_confirmed",
      evidence,
    }),
  });
  if (!whale) {
    return baseUnattempted(`no curated whale for base token ${baseToken}, so a baseline position could not be funded on the fork — baseline unestablished, verdict stays undetermined`);
  }

  // --- Part 2: establish a baseline position and exit. ---
  const HOLDER: Hex = "0x000000000000000000000000000000000000abc1"; // deterministic sandbox holder (lowercase — no checksum)
  const gasCap = 10n ** 18n;
  const decimals = whale.decimals;
  const fundAmount = 100_000n * 10n ** BigInt(decimals); // 100k base
  const supplyAmount = 50_000n * 10n ** BigInt(decimals);
  const withdrawAmount = 10_000n * 10n ** BigInt(decimals);

  for (const acct of [whale.whale, HOLDER, guardian]) {
    await fork.client.setBalance({ address: acct, value: gasCap });
    await fork.client.impersonateAccount({ address: acct });
  }

  // Fund the holder from the whale.
  const fundTx = {
    to: baseToken,
    data: encodeErc20Transfer(HOLDER, fundAmount),
    gas: 200_000n,
  };
  const fund = await fork.sendFrom(whale.whale, fundTx);
  evidence.push(txEv("fund holder", whale.whale, fundTx, fund, req.blockNumber));
  if (fund.status !== "success") {
    return baseUnattempted(`funding the holder from whale ${whale.whale} reverted on the fork — baseline unestablished`);
  }
  // Approve + supply into Comet.
  const approveTx = { to: baseToken, data: encodeErc20Approve(target, fundAmount), gas: 100_000n };
  const approve = await fork.sendFrom(HOLDER, approveTx);
  evidence.push(txEv("approve base token", HOLDER, approveTx, approve, req.blockNumber));
  const supplyTx = { to: target, data: cometSupplyCalldata(baseToken, supplyAmount), gas: 900_000n };
  const supply = await fork.sendFrom(HOLDER, supplyTx);
  evidence.push(txEv("supply baseline position", HOLDER, supplyTx, supply, req.blockNumber));
  if (approve.status !== "success" || supply.status !== "success") {
    return baseUnattempted("approve/supply into the protocol reverted on the fork, so no exitable position exists — baseline unestablished");
  }
  evidence.push(ev({ action: "fund+approve+supply", holder: HOLDER, amount: supplyAmount.toString() }, "position established", req.blockNumber));

  // Snapshot the position, then run the baseline exit.
  const baseSnap = await fork.snapshot();
  const withdrawTx = { to: target, data: cometWithdrawCalldata(baseToken, withdrawAmount), gas: 900_000n };
  const baselineWithdraw = await fork.sendFrom(HOLDER, withdrawTx);
  evidence.push(txEv("baseline holder withdraw", HOLDER, withdrawTx, baselineWithdraw, req.blockNumber));
  await fork.revert(baseSnap);

  if (baselineWithdraw.status !== "success") {
    // The exit reverts BEFORE any mutation — the door is already shut at the
    // pinned block. A decisive current restriction, not an unestablished baseline.
    const isPaused = (await fork.client.readContract({ address: target, abi: cometAbi, functionName: "isWithdrawPaused" })) as boolean;
    evidence.push(ev({ read: "isWithdrawPaused()", phase: "baseline failure diagnosis" }, isPaused, req.blockNumber));
    const cand: RestrictionCandidate = {
      selector: SELECTORS.cometWithdraw,
      signature: "withdraw(address,uint256) already reverts",
      category: "ACCESS_RESTRICTION",
      guardingParty: null,
      guardingPartyType: null,
      args: "none — the exit reverts in its current state",
      result: "restrictor",
      noticeSeconds: "0",
      detail: `The baseline exit reverts at the pinned block (isWithdrawPaused()=${isPaused}) — the exit is already shut, no notice applies.`,
      evidence,
    };
    return {
      restrictorRoute: buildRestrictorRoute(target, cand, { type: "contract", threshold: null, owners: null }, "already_shut"),
      exitRestriction: mkRestriction(req, exitAction, {
        outcome: "restrictor_found",
        baseline: { status: "unestablished", holder: HOLDER, holderSource: "impersonated deterministic holder, funded+supplied", note: "position established but the baseline exit itself reverts — already shut", evidence },
        candidates: [cand],
        restrictors: [cand],
        coverage: { guardedTotal: 1, evaluated: 1 },
        restrictionState: "already_shut",
        confirmationMethod: "fork_confirmed",
        evidence,
      }),
    };
  }
  evidence.push(ev({ action: "baseline withdraw", holder: HOLDER, amount: withdrawAmount.toString() }, "success", req.blockNumber));
  const baseline: ExitRestriction["baseline"] = {
    status: "established",
    holder: HOLDER,
    holderSource: `funded 100k ${whale.symbol} from whale ${whale.whale}, supplied 50k, baseline withdraw of 10k succeeded`,
    note: "control established: the exit action succeeds before any privileged mutation",
    evidence,
  };

  // --- Part 3: the differential. One candidate for this archetype: the
  // pause guardian's withdraw-pause. Snapshot → pause → re-run exit → revert. ---
  const guardianClass = await classifyOnFork(fork, guardian);
  const diffSnap = await fork.snapshot();
  const pausedBefore = (await fork.client.readContract({ address: target, abi: cometAbi, functionName: "isWithdrawPaused" })) as boolean;
  evidence.push(ev({ read: "isWithdrawPaused()", phase: "before candidate mutation" }, pausedBefore, req.blockNumber));
  const pauseTx = { to: target, data: cometWithdrawPauseCalldata(), gas: 300_000n };
  const pause = await fork.sendFrom(guardian, pauseTx);
  const pauseEvidence = txEv("guardian pause withdraw", guardian, pauseTx, pause, req.blockNumber);
  evidence.push(pauseEvidence);
  let candidate: RestrictionCandidate;
  if (pause.status !== "success") {
    candidate = {
      selector: SELECTORS.cometPause,
      signature: "pause(bool,bool,bool,bool,bool)",
      category: "ACCESS_RESTRICTION",
      guardingParty: guardian,
      guardingPartyType: guardianClass.type,
      args: "withdraw-pause = true",
      result: "inconclusive",
      noticeSeconds: null,
      detail: "the pause guardian's pause() call itself reverted on the fork, so nothing about the exit was learned — reported as inconclusive, never as no-effect",
      evidence: [pauseEvidence],
    };
    await fork.revert(diffSnap);
  } else {
    const afterWithdraw = await fork.sendFrom(HOLDER, withdrawTx);
    const afterWithdrawEvidence = txEv("holder withdraw after candidate", HOLDER, withdrawTx, afterWithdraw, req.blockNumber);
    evidence.push(afterWithdrawEvidence);
    const isPaused = (await fork.client.readContract({ address: target, abi: cometAbi, functionName: "isWithdrawPaused" })) as boolean;
    const pausedEvidence = ev({ read: "isWithdrawPaused()", phase: "after candidate mutation" }, isPaused, req.blockNumber);
    evidence.push(pausedEvidence);
    await fork.revert(diffSnap);
    const safeRail =
      guardianClass.type === "safe"
        ? ` The guardian is a ${guardianClass.threshold}-of-${guardianClass.owners} Safe, impersonated at its address — this demonstrates the Safe CAN close the exit if its signers collude, not that a single key can.`
        : "";
    candidate = {
      selector: SELECTORS.cometPause,
      signature: "pause(bool,bool,bool,bool,bool)",
      category: "ACCESS_RESTRICTION",
      guardingParty: guardian,
      guardingPartyType: guardianClass.type,
      args: "withdraw-pause = true",
      result: afterWithdraw.status !== "success" ? "restrictor" : "no_effect",
      noticeSeconds: guardianClass.type === "contract" ? null : "0",
      detail:
        afterWithdraw.status !== "success"
          ? `DIFFERENTIAL CONFIRMED: baseline withdraw succeeded; after the guardian set isWithdrawPaused()=${isPaused}, the identical withdraw reverts. The pause guardian can close the exit.${safeRail}`
          : `the guardian set isWithdrawPaused()=${isPaused} but the baseline withdraw still succeeded — not an exit restrictor.`,
      evidence: [
        pauseEvidence,
        pausedEvidence,
        afterWithdrawEvidence,
      ],
    };
  }

  const conclusion = classifyCandidateEvaluation([candidate], req.enumeration);
  const restrictorRoute =
    conclusion.restrictors.length > 0
      ? buildRestrictorRoute(target, candidate, guardianClass, "restrictable")
      : null;

  return {
    restrictorRoute,
    exitRestriction: mkRestriction(req, exitAction, {
      outcome: conclusion.outcome,
      baseline,
      candidates: [candidate],
      restrictors: conclusion.restrictors,
      evaluationGaps: conclusion.evaluationGaps,
      coverage: { guardedTotal: 1, evaluated: 1 },
      restrictionState: conclusion.restrictionState,
      confirmationMethod: conclusion.confirmationMethod,
      evidence,
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
  restrictionState: "restrictable" | "already_shut",
): ExitWindowRoute | null {
  // Only an eoa/safe guardian is a proven zero-notice route. A contract guardian
  // whose own delay we did not resolve is NOT asserted as immediate — that would
  // be optimism in the wrong direction — so no route is injected and the finding
  // stays visible in exitRestriction without claiming no_notice.
  if (candidate.guardingPartyType === "contract" && restrictionState !== "already_shut") return null;
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
    restrictionState,
  };
}

function encodeErc20Transfer(to: Hex, amount: bigint): Hex {
  return encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] });
}
function encodeErc20Approve(spender: Hex, amount: bigint): Hex {
  return encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] });
}
