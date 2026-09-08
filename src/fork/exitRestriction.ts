/**
 * The Exit-Restriction Engine — THE FORK DIFFERENTIAL.
 *
 * Every layer before this REASONS about whether a privileged party can close a
 * holder's exit. This one TESTS it, on a sandbox anvil fork pinned to the report
 * block: identify the exit action, establish a BASELINE position for whom that
 * exit succeeds before any mutation, then for each restriction candidate
 * registered by the matched archetype snapshot the fork, impersonate the
 * guarding party, call it with the exit-restricting argument, and re-run the exit
 * at the same block/time. A pause transition plus the expected Paused() revert
 * establishes the restriction.
 *
 * THE EPISTEMIC CEILING is honoured, not hidden. A clean run is NEVER a safety
 * guarantee and never reuses `can_exit_in_time`; its outcome is the deliberately
 * weaker `no_direct_restriction_found`, scoped to the N candidates evaluated. A
 * found restrictor is decisive and, if its party imposes no delay, a zero-notice
 * route that caps the verdict.
 *
 * Honesty rails, load-bearing: everything runs on the ephemeral fork (no mainnet
 * tx, no key, no approval); every string is capability, not intent; a
 * Safe-guarded restrictor is impersonated AT THE SAFE ADDRESS, so it assumes the
 * Safe can authorize the call and says so on the finding; and an unestablished
 * baseline or unidentifiable exit action produces an explicit `undetermined`,
 * never a fabricated clean run.
 */
import { encodeFunctionData, type Abi, type Hex } from "viem";
import { startAnvilFork, type ForkHandle, type ForkTransactionResult } from "./anvil.js";
import { checkAnvilAvailable } from "./preflight.js";
import { adapterRegistryVersion, identifyAdapter } from "./adapters/index.js";
import { isRefusal, type AdapterContext, type ExitProtocolAdapter } from "./adapters/types.js";
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

/**
 * The gas ceiling an exit is given. Passed to the adapter's judgement so a
 * revert can be distinguished from an out-of-gas — a transaction that consumed
 * its whole limit proves nothing about a guard.
 */
const EXIT_GAS_LIMIT = 900_000n;

/**
 * Wall-clock ceiling for the whole differential, mirroring the asset-scenario
 * layer's `deadlineAt`. It bounds an adapter that hangs on a slow fork read; a
 * candidate it runs out of time for is recorded `not_evaluated`, which
 * `classifyCandidateEvaluation` already treats as a gap that forbids the clean
 * tier. Deliberately NOT part of the pinned report's budget accounting: this is
 * fork work, outside `report.budget` by the same rule that keeps every fork read
 * outside it.
 */
const EXECUTOR_BUDGET_MS = 10 * 60_000;

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
  expectedBlockHash?: Hex;
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

/**
 * How a fork read's return value is stored as evidence.
 *
 * Booleans and addresses are kept RAW — that is what the protocol reads recorded
 * before the executor was generalised, and a report whose evidence silently
 * changed from `false` to `"false"` would be a shape change nothing asked for.
 * Bigints and tuples are stringified because JSON cannot carry a bigint at all,
 * which is the same reason the pinned cache normalises them (KNOWN EDGE #23).
 */
function encodeReadValue(value: unknown): unknown {
  if (Array.isArray(value)) return (value as unknown[]).map(String);
  if (typeof value === "bigint") return String(value);
  return value;
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

function notRun(req: ExitRestrictionRequest, adapter: ExitProtocolAdapter | null, outcome: ExitRestriction["outcome"], reason: string, exitAction: ExitRestriction["exitAction"]): ExitRestrictionResult {
  return {
    restrictorRoute: null,
    exitRestriction: {
      rulesVersion: adapterRegistryVersion,
      attempted: outcome !== "not_run",
      archetype: adapter?.archetype ?? "no protocol archetype was identified",
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
      ceiling: [...CEILING, ...(adapter?.coverageLimitations ?? [])],
      reproduceCommand: null,
      evidence: [],
    },
  };
}

export async function runExitRestrictionEngine(req: ExitRestrictionRequest): Promise<ExitRestrictionResult> {
  const selectors = allSelectors(req.capabilities);

  // --- Part 1: identify the protocol. Unmatched or unvalidated → undetermined. ---
  notifyFork(req.observer, "onForkStart", "exit_action");
  const match = identifyAdapter(selectors, req.chainId);
  if (!match) {
    notifyFork(req.observer, "onForkStep", {
      phase: "exit_action",
      outcome: "inconclusive",
      detail:
        "No registered exit-interface fingerprint matched the decoded selectors. Testing an unidentified exit function would risk a false-clean, so the differential is refused rather than run against a guess.",
    });
    return notRun(req, null, "exit_action_unconfident", "no known exit interface fingerprint matched the decoded selectors, so the exit action could not be confidently identified — the differential is refused rather than run against a guessed exit function", {
      status: "unconfident",
      interfaceName: "none",
      signature: null,
      selector: null,
      confidence: "low",
      note: "No exit interface matched. Testing an unidentified exit would risk a false-clean, so the engine does not run.",
      evidence: [],
    });
  }
  const { adapter, validatedHere } = match;
  const exitAction: ExitRestriction["exitAction"] = {
    status: "identified",
    interfaceName: adapter.id,
    signature: adapter.exitSignature,
    selector: adapter.exitSelector,
    confidence: adapter.confidence,
    note: `${adapter.label}: a holder leaves by calling ${adapter.exitSignature}. Identified by the fingerprint ${adapter.fingerprint.join(", ")} in the decoded selector set.`,
    evidence: [ev({ fingerprint: adapter.fingerprint, matchedFrom: "capabilities.selectorsExtracted", adapter: adapter.id }, adapter.id, req.blockNumber)],
  };
  notifyFork(req.observer, "onForkStep", {
    phase: "exit_action",
    outcome: "completed",
    detail: `${adapter.label}: a holder leaves by calling ${adapter.exitSignature}. Matched on the full fingerprint ${adapter.fingerprint.join(", ")}.`,
    evidence: exitAction.evidence,
  });

  // An adapter whose baseline mechanics have never been exercised live on THIS
  // chain does not get to decide a verdict here. The rule already existed in
  // prose — "each needing its own baseline mechanics + a live validation before
  // it is trusted" — and prose is not a gate.
  if (!validatedHere) {
    notifyFork(req.observer, "onForkStep", {
      phase: "verdict",
      outcome: "inconclusive",
      detail: `The exit action was identified (${adapter.id}), but this archetype has not been validated live on chain ${req.chainId}. The scan stands; the experiment was not run.`,
    });
    return notRun(req, adapter, "no_candidates", `exit action identified (${adapter.id}) but its differential mechanics have not been validated on chain ${req.chainId} (validated on: ${adapter.validatedOn.join(", ") || "no chain"}) — reported honestly rather than run unvalidated`, exitAction);
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
    return notRun(req, adapter, "not_run", err instanceof Error ? err.message : String(err), exitAction);
  }

  const fork = await startAnvilFork({ rpcUrl: req.rpcUrl, blockNumber: req.blockNumber,
      ...(req.expectedBlockHash ? { expectedBlockHash: req.expectedBlockHash } : {}), anvilExecutable });
  try {
    return await runDifferential(req, fork, adapter, exitAction);
  } finally {
    await fork.stop();
  }
}

/**
 * THE PROTOCOL-AGNOSTIC EXECUTOR.
 *
 * Everything here is a rail that must hold for every protocol, which is exactly
 * why none of it is delegated: the control exit that has to succeed before any
 * revert means anything; the snapshot/revert isolation that keeps each candidate
 * independent; the neutral transaction that makes the control branch occupy the
 * same block and guarding-party nonce the mutation will; the clock and
 * starting-state equality that makes the two branches comparable at all; and the
 * fail-closed composition at the end. An adapter supplies protocol knowledge and
 * cannot skip any of this.
 */
async function runDifferential(
  req: ExitRestrictionRequest,
  fork: ForkHandle,
  adapter: ExitProtocolAdapter,
  exitAction: ExitRestriction["exitAction"],
): Promise<ExitRestrictionResult> {
  const evidence: Evidence[] = [];
  const HOLDER: Hex = "0x000000000000000000000000000000000000abc1";
  const CONTROL_SINK: Hex = "0x000000000000000000000000000000000000abc2";
  const deadlineAt = Date.now() + EXECUTOR_BUDGET_MS;

  const ctx: AdapterContext = {
    fork,
    target: req.target,
    chainId: req.chainId,
    reportBlock: req.blockNumber,
    holder: HOLDER,
    controlSink: CONTROL_SINK,
    async read<T>(args: { address: Hex; abi: Abi | readonly unknown[]; functionName: string; args?: readonly unknown[]; phase: string }): Promise<T> {
      const head = await fork.client.getBlock();
      const abi = args.abi as Abi;
      const data = encodeFunctionData({ abi, functionName: args.functionName, ...(args.args ? { args: args.args } : {}) } as never);
      const value = await fork.client.readContract({
        address: args.address, abi, functionName: args.functionName,
        ...(args.args ? { args: args.args } : {}), blockNumber: head.number,
      } as never);
      evidence.push(ev({
        method: "eth_call", address: args.address, data, read: `${args.functionName}()`, phase: args.phase,
        localBlock: head.number.toString(), localTimestamp: head.timestamp.toString(), forkOnly: true,
      }, encodeReadValue(value), req.blockNumber));
      return value as T;
    },
    async send(action, from, tx) {
      const result = await fork.sendFrom(from, tx);
      evidence.push(txEv(action, from, tx, result, req.blockNumber));
      return result;
    },
    async enable(accounts) {
      for (const acct of accounts) {
        await fork.client.setBalance({ address: acct, value: 10n ** 18n });
        await fork.client.impersonateAccount({ address: acct });
      }
    },
    record: (e) => { evidence.push(e); },
    expired: () => Date.now() > deadlineAt,
  };

  const experiment = adapter.create(ctx);

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
    return {
      restrictorRoute: null,
      exitRestriction: mkRestriction(req, adapter, exitAction, {
        outcome: "baseline_unestablished",
        baseline: { status: "unestablished", holder: HOLDER, holderSource: "deterministic sandbox supplier", note: reason, evidence: [...evidence] },
        candidates: [], restrictors: [], evaluationGaps: [reason],
        coverage: { guardedTotal: 1, evaluated: 0 },
        restrictionState: "undetermined", confirmationMethod: "not_confirmed", evidence,
      }),
    };
  };

  const prepared = await experiment.prepare();
  if (isRefusal(prepared)) return baseUnattempted(prepared.refused);

  const sinkCode = await fork.client.getCode({ address: CONTROL_SINK });
  if (sinkCode && sinkCode !== "0x") return baseUnattempted("the neutral control recipient has code; refusing a control transaction with unknown side effects");

  const built = await experiment.buildPosition();
  if (isRefusal(built)) return baseUnattempted(built.refused);
  if (ctx.expired()) return baseUnattempted("the differential ran out of its time budget before a baseline exit could be established");

  // Both branches start from this position. A neutral transaction occupies the
  // mutation's block and guarding-party nonce in the control branch. The fork
  // restores its clock on revert, so corresponding reads and exits have
  // identical times.
  const controlParty = experiment.controlParty();
  const baseSnap = await fork.snapshot();
  const control = await ctx.send("neutral control step", controlParty, { to: CONTROL_SINK, gas: 21_000n });
  if (control.status !== "success") {
    await fork.revert(baseSnap);
    return baseUnattempted("neutral control transaction failed");
  }
  const baselineAttempt = await experiment.exit("baseline holder exit");
  await fork.revert(baseSnap);
  if (!experiment.verifyFullExit(baselineAttempt)) {
    return baseUnattempted("the baseline exit did not both succeed and recover the holder's position; its cause is unestablished, not a demonstrated restriction");
  }

  const summary = experiment.baselineSummary(baselineAttempt);
  const baseline: ExitRestriction["baseline"] = {
    status: "established", holder: HOLDER, holderSource: summary.holderSource, note: summary.note, evidence: [...evidence],
  };
  notifyFork(req.observer, "onForkStep", { phase: "baseline", outcome: "completed", detail: summary.detail, evidence: [...evidence] });

  // --- Part 3: each registered candidate, isolated from the others. ---
  const specs = experiment.candidates();
  // The fork-side classification is kept ALONGSIDE each candidate rather than
  // re-read from the schema field afterwards: `guardingPartyType` widens to the
  // report's enum (which includes `unknown` and `timelock`), and the restrictor
  // route needs the precise eoa/safe/contract answer this run actually observed.
  const evaluated: { candidate: RestrictionCandidate; partyClass: Awaited<ReturnType<typeof classifyOnFork>>; party: ForkParty }[] = [];
  const candidates: RestrictionCandidate[] = [];
  for (const spec of specs) {
    const partyClass = await classifyOnFork(fork, spec.guardingParty);
    const forkParty = (confirmed: boolean): ForkParty => ({
      address: spec.guardingParty,
      type: partyClass.type,
      safeThreshold: partyClass.threshold,
      safeOwners: partyClass.owners,
      signature: spec.signature,
      relation: "can restrict the exit of",
      confirmed,
    });

    if (ctx.expired()) {
      const skipped: RestrictionCandidate = {
        selector: spec.selector, signature: spec.signature, category: spec.category,
        guardingParty: spec.guardingParty, guardingPartyType: partyClass.type, args: spec.args,
        result: "not_evaluated", noticeSeconds: null,
        detail: "the differential ran out of its time budget before this candidate was evaluated — recorded as unevaluated rather than dropped",
        evidence: [],
      };
      candidates.push(skipped);
      evaluated.push({ candidate: skipped, partyClass, party: forkParty(false) });
      continue;
    }

    notifyFork(req.observer, "onForkStart", "mutation");
    const diffSnap = await fork.snapshot();
    const candidateStart = evidence.length;
    let result: RestrictionCandidate["result"] = "inconclusive";
    let detail = "the guarding party's mutation did not establish a cause; no effect on the exit was established";
    try {
      const mutation = await spec.mutate();
      notifyFork(req.observer, "onForkStep", {
        phase: "mutation",
        outcome: mutation.transitioned ? "completed" : "inconclusive",
        detail: mutation.transitioned
          ? `${spec.guardingParty} (${partyClass.type}${partyClass.type === "safe" ? ` ${partyClass.threshold}-of-${partyClass.owners}` : ""}) ${mutation.detail}`
          : `${mutation.detail} A failed or ineffective mutation is NOT evidence that the exit is safe — it is an absence of evidence either way.`,
        evidence: evidence.slice(candidateStart),
        // Not yet `confirmed`: the party has been shown able to change state,
        // but whether that closes the exit is decided by the re-exit below.
        party: forkParty(false),
      });
      if (!mutation.executed) {
        // The privileged call itself reverted, so the party could not act and
        // there is nothing to re-test. Re-running the exit here would only show
        // it still working, which says nothing.
        detail = mutation.detail;
      } else {
        // The mutation RAN, so the exit is re-run even when nothing transitioned:
        // the non-effect is then a recorded observation rather than an inference
        // from a state read, and the branch that produced it is still evidenced.
        notifyFork(req.observer, "onForkStart", "reexit");
        const reexitStart = evidence.length;
        const attempt = await experiment.exit("holder exit after candidate");
        const timesMatch =
          baselineAttempt.before.block === attempt.before.block && baselineAttempt.before.timestamp === attempt.before.timestamp &&
          baselineAttempt.after.block === attempt.after.block && baselineAttempt.after.timestamp === attempt.after.timestamp;
        const stateMatches = experiment.samePosition(baselineAttempt.before, attempt.before);
        if (!timesMatch || !stateMatches) {
          detail = "control and mutation branches did not have matching exit times and starting balances; causality is unestablished";
        } else if (!mutation.transitioned) {
          detail = mutation.detail;
        } else {
          const judged = experiment.judgeReexit({ candidate: spec, baseline: baselineAttempt, attempt, gasLimit: EXIT_GAS_LIMIT });
          result = judged.result;
          detail = judged.detail;
        }
        notifyFork(req.observer, "onForkStep", {
          phase: "reexit",
          outcome: result === "inconclusive" ? "inconclusive" : "completed",
          detail,
          evidence: evidence.slice(reexitStart),
        });
      }
    } finally {
      await fork.revert(diffSnap);
    }

    if (partyClass.type === "safe") {
      detail += ` The ${partyClass.threshold}-of-${partyClass.owners} Safe was impersonated: this result assumes it can authorize and submit the call; signatures, transaction guards and modules were not executed.`;
    } else if (partyClass.type === "contract") {
      detail += " The contract controller was impersonated; its own execution constraints and notice were not established.";
    }
    const candidate: RestrictionCandidate = {
      selector: spec.selector, signature: spec.signature, category: spec.category,
      guardingParty: spec.guardingParty, guardingPartyType: partyClass.type, args: spec.args,
      result, noticeSeconds: partyClass.type === "contract" ? null : "0", detail,
      evidence: evidence.slice(candidateStart),
    };
    candidates.push(candidate);
    evaluated.push({ candidate, partyClass, party: forkParty(result === "restrictor") });
  }

  const conclusion = classifyCandidateEvaluation(candidates, req.enumeration);
  const decisive = evaluated.find((e) => e.candidate.result === "restrictor") ?? null;
  notifyFork(req.observer, "onForkStep", {
    phase: "verdict",
    // Only a demonstrated restrictor is a completed conclusion. The clean tier
    // and the inconclusive tier both leave a question open, and neither may
    // wear the same status as a decisive result.
    outcome: conclusion.outcome === "restrictor_found" ? "completed" : "inconclusive",
    detail: decisive?.candidate.detail ?? candidates[0]?.detail ?? "no candidate was evaluated",
    ...(decisive ? { party: decisive.party } : {}),
  });

  const restrictorRoute = decisive ? buildRestrictorRoute(req.target, decisive.candidate, decisive.partyClass) : null;
  return {
    restrictorRoute,
    exitRestriction: mkRestriction(req, adapter, exitAction, {
      ...conclusion, baseline, candidates,
      coverage: { guardedTotal: specs.length, evaluated: candidates.filter((c) => c.result !== "not_evaluated").length },
      evidence,
    }),
  };
}

/** Assembles the ExitRestriction from the parts that vary, filling the invariant fields. */
function mkRestriction(
  req: ExitRestrictionRequest,
  adapter: ExitProtocolAdapter,
  exitAction: ExitRestriction["exitAction"],
  parts: Pick<ExitRestriction, "outcome" | "baseline" | "candidates" | "restrictors" | "coverage" | "restrictionState" | "confirmationMethod" | "evidence"> &
    Partial<Pick<ExitRestriction, "evaluationGaps">>,
): ExitRestriction {
  return {
    rulesVersion: adapterRegistryVersion,
    attempted: true,
    // The archetype and the extra ceiling items come from the ADAPTER, so a new
    // protocol describes its own scope instead of inheriting Comet's sentence.
    archetype: adapter.archetype,
    exitAction,
    forkBlock: req.blockNumber.toString(),
    sandboxNote: SANDBOX_NOTE,
    ceiling: [...CEILING, ...adapter.coverageLimitations],
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
