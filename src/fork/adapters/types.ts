/**
 * THE PROTOCOL ADAPTER CONTRACT.
 *
 * Before this file, `ExitInterface` described a protocol (a fingerprint, an exit
 * selector) and supplied none of the behaviour needed to actually run an
 * experiment on it, so the behaviour lived in the engine as an explicit branch:
 * `if (iface.id !== "compound-comet-base") return notRun(...)`. Adding a second
 * protocol therefore meant editing the executor, the asset-context service
 * (which independently re-checked for the same interface id) and a funding table
 * keyed by bare token address. "Add one adapter" was not a thing anyone could do.
 *
 * THE SPLIT, and it is the whole point of this file:
 *
 *   THE ADAPTER owns everything protocol-specific — identification, reading the
 *   protocol's own facts, building a position, performing the exit, observing
 *   the holder's state, the privileged mutation, and the semantic judgement of
 *   what a post-mutation exit result MEANS.
 *
 *   THE EXECUTOR owns everything that must be identical for every protocol —
 *   fork lifecycle, snapshot/revert isolation between candidates, the neutral
 *   control step, clock and starting-state matching between the control and
 *   mutation branches, ordered evidence, deadlines, and the fail-closed
 *   composition of the final outcome.
 *
 * The division is not stylistic. Everything in the executor's half is a rail
 * that stops a false-clean, and an adapter author must not be able to weaken one
 * by forgetting it. An adapter cannot skip the control exit, cannot compare
 * across mismatched clocks, and cannot promote its own result past
 * `classifyCandidateEvaluation` — those happen outside its reach.
 *
 * WHAT AN ADAPTER MAY NEVER DO, stated because the type system cannot enforce
 * it: return a positive judgement it has not observed. `no_effect` is a claim
 * that the identical exit still worked, and it must rest on re-verified economic
 * recovery, never on a successful receipt.
 */
import type { Hex } from "viem";
import type { Abi } from "viem";
import type { Evidence } from "../../chain/client.js";
import type { ForkHandle, ForkTransactionResult } from "../anvil.js";
import type { RestrictionCandidate } from "../../report/schema.js";

/**
 * A refusal, carrying its reason. Distinct from `null` and from an empty result
 * on purpose: every early exit in this engine has to say WHY, because a
 * differential that did not run and a differential that found nothing produce
 * the same shaped emptiness.
 */
export interface AdapterRefusal {
  refused: string;
}
export function refuse(reason: string): AdapterRefusal {
  return { refused: reason };
}
export function isRefusal(value: unknown): value is AdapterRefusal {
  return typeof value === "object" && value !== null && typeof (value as AdapterRefusal).refused === "string";
}

/**
 * A position observation. The executor reads only `block`/`timestamp` — which it
 * needs to prove the control and mutation branches ran at the same instant — and
 * treats everything else as opaque, because what constitutes "the holder's
 * position" is exactly the thing that differs between a lending market and a
 * token.
 */
export interface ExitObservation {
  block: bigint;
  timestamp: bigint;
}

/** What the executor hands an adapter. Every mutating or reading helper records evidence. */
export interface AdapterContext {
  fork: ForkHandle;
  target: Hex;
  chainId: number;
  /** The REPORT's block, used to stamp evidence. Fork-local heights live in each entry's params. */
  reportBlock: bigint;
  /** The deterministic sandbox holder. Never the target, never a real user. */
  holder: Hex;
  /** A neutral, codeless recipient for the control step. */
  controlSink: Hex;
  /** An `eth_call` at the fork head, recorded as evidence with its phase. */
  read<T>(args: { address: Hex; abi: Abi | readonly unknown[]; functionName: string; args?: readonly unknown[]; phase: string }): Promise<T>;
  /** An impersonated `eth_sendTransaction`, recorded as a complete ordered witness. */
  send(action: string, from: Hex, tx: { to: Hex; data?: Hex; value?: bigint; gas: bigint }): Promise<ForkTransactionResult>;
  /** Funds gas and enables impersonation for each account. */
  enable(accounts: readonly Hex[]): Promise<void>;
  /** Appends a bespoke evidence entry the helpers above do not cover. */
  record(evidence: Evidence): void;
  /** True once the run is out of time; adapters must check it between expensive steps. */
  expired(): boolean;
}

/** A baseline the adapter established and verified economically, not by receipt. */
export interface BaselineEvidenceSummary {
  /** How the holder came to hold the position, in one sentence for the report. */
  holderSource: string;
  /** What was actually verified — amounts recovered, position cleared. Never "the call succeeded". */
  note: string;
  /** Human-readable line for the progress observer. */
  detail: string;
}

/** The result of running the exit once. */
export interface ExitAttempt {
  before: ExitObservation;
  after: ExitObservation;
  tx: ForkTransactionResult;
}

/** One privileged mutation to put through the differential. */
export interface CandidateSpec {
  selector: Hex;
  signature: string;
  category: RestrictionCandidate["category"];
  /** The exit-restricting argument, described for the report. */
  args: string;
  /** The party that guards this function, read from the protocol itself. */
  guardingParty: Hex;
  /**
   * Performs the mutation.
   *
   * TWO booleans, because they mean different things and collapsing them loses a
   * real distinction. `executed` is whether the privileged call itself went
   * through; if it reverted, the party could not even act and there is nothing
   * to re-test. `transitioned` is whether the INTENDED state change is
   * observable afterwards — a call that succeeds while changing nothing
   * establishes no cause, so no later revert could be attributed to it, but the
   * exit is still re-run so the evidence of that non-effect is recorded rather
   * than assumed.
   */
  mutate(): Promise<{ executed: boolean; transitioned: boolean; detail: string }>;
}

/**
 * A protocol experiment bound to one fork and target. Created by the adapter, so
 * all protocol state (base token, guardian, decimals, cached reads) lives in the
 * closure and never leaks into the executor as a type parameter.
 */
export interface ExitExperiment {
  /** Reads the protocol's own facts. Refuse when the archetype cannot apply here. */
  prepare(): Promise<AdapterRefusal | null>;
  /** The party whose nonce and block the neutral control step must occupy. */
  controlParty(): Hex;
  /** Funds and builds the holder's position. Leaves the fork holding it. */
  buildPosition(): Promise<AdapterRefusal | null>;
  /** Observes the holder's position at the fork head. */
  observe(phase: string): Promise<ExitObservation>;
  /** Performs the exit once, returning observations either side of it. */
  exit(phase: string): Promise<ExitAttempt>;
  /**
   * Did this attempt actually get the holder out? Receipt success is never
   * sufficient — this must check that value moved and the position cleared.
   */
  verifyFullExit(attempt: ExitAttempt): boolean;
  /** Are two observations the same starting state? Used to prove branch comparability. */
  samePosition(a: ExitObservation, b: ExitObservation): boolean;
  /**
   * How this adapter describes the baseline it just verified. The adapter writes
   * it because only the adapter knows what was economically established — the
   * executor would otherwise have to say "the exit succeeded", which is the one
   * sentence a baseline must never rest on.
   */
  baselineSummary(attempt: ExitAttempt): BaselineEvidenceSummary;
  /** The candidates this adapter registers. Called after `prepare`. */
  candidates(): CandidateSpec[];
  /**
   * The adapter's semantic judgement of a post-mutation exit, given a verified
   * baseline. The executor has ALREADY checked clock and starting-state
   * equality and that the mutation transitioned; this decides only what the
   * protocol-specific evidence means.
   */
  judgeReexit(args: {
    candidate: CandidateSpec;
    baseline: ExitAttempt;
    attempt: ExitAttempt;
    gasLimit: bigint;
  }): { result: RestrictionCandidate["result"]; detail: string };
}

/**
 * A protocol Ripcord can run the differential against.
 *
 * `validatedOn` is load-bearing and deliberately not a boolean: an adapter is
 * only trustworthy on a chain where its baseline mechanics have been exercised
 * live. An adapter with an empty list is registered but MUST NOT produce a
 * confident result — the registry enforces that, so a half-finished adapter
 * cannot quietly start deciding verdicts.
 */
export interface ExitProtocolAdapter {
  id: string;
  label: string;
  /** Characteristic selectors that must ALL be present. A partial match is not a match. */
  fingerprint: Hex[];
  exitSignature: string;
  exitSelector: Hex;
  confidence: "high" | "medium" | "low";
  /** One line describing the differential this adapter performs, for the report. */
  archetype: string;
  /** Ceiling items specific to this protocol, appended to the engine's universal ones. */
  coverageLimitations: string[];
  /** Chain ids on which this adapter's baseline mechanics have been validated live. */
  validatedOn: number[];
  /** Whether the per-asset scenario sidecar knows how to extend this archetype. */
  supportsAssetScenarios: boolean;
  create(ctx: AdapterContext): ExitExperiment;
}
