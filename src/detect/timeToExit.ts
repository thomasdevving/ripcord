/**
 * Time to exit: how long a holder actually needs to leave, as a LOWER BOUND
 * with its gaps named.
 *
 * Measured: cooldown/unstaking accessors from a curated versioned table
 * (selectors derived via viem, matched exactly); two-step request/claim shapes
 * detected structurally from the dispatcher's selector set, yielding a leg of
 * UNKNOWN length; the pause state at the pinned block (a halted exit is
 * unbounded, not "large"); and exit-blockability from day-2 ACCESS_RESTRICTION
 * capabilities attributed to a holder — capability, never prediction.
 *
 * Measured legs are SUMMED, because these mechanisms are sequential. A claim
 * window adds zero duration — it is a deadline, not a delay — but is recorded
 * so the hazard stays visible.
 *
 * `atLeastSeconds` is always a floor. `tight` is deliberately hard to earn:
 * readable dispatcher, every detected leg measured, nothing currently
 * blocking. An unmeasured leg removes `tight` entirely.
 *
 * Liquidity depth is not modelled — that needs an indexer, and every shortcut
 * produces an authoritative-looking wrong number; `modelled` is a literal
 * false so one cannot be expressed. Where a cooldown's own setter exists the
 * leg records `mutableBy`: a duration the authority can raise is not a
 * protocol constant.
 */
import { decodeFunctionResult, encodeFunctionData, parseAbiItem, toFunctionSelector, type Hex } from "viem";
import type { ChainReader } from "../chain/client.js";
import type {
  CapabilitiesResult,
  DepthConfidence,
  Evidence,
  ExitBlockability,
  ExitLeg,
  ProxyResult,
  TimeToExit,
  UnknownEntry,
} from "../report/schema.js";
import { extractDispatcherSelectors } from "./dispatcher.js";

/** Bump whenever the tables or composition rules below change. Folded into report.rulesetVersion. */
export const exitPatternsVersion = "0.1.0";

/**
 * Cooldown/unstaking accessors, as FULL signatures. Every one returns a
 * duration; the units are stated per entry because getting seconds and blocks
 * confused would silently scale the answer by ~12x in the flattering
 * direction for a blocks-denominated value read as seconds.
 *
 * `specificity` mirrors taxonomy.ts's meaning exactly and is NOT a certainty
 * score: "standard" is a widely-adopted accessor whose name reliably implies
 * an exit delay; "generic" is a plausible-but-reusable name where the match is
 * exact but the meaning varies by project. A generic match still produces a
 * real leg — it just carries a lower confidence, because what the protocol
 * means by `lockPeriod()` is genuinely less certain than what Aave means by
 * `COOLDOWN_SECONDS()`.
 */
export interface CooldownAccessor {
  signature: string;
  kind: "cooldown" | "claim_window";
  units: "seconds" | "blocks";
  specificity: "standard" | "generic";
  /** The setter that would make this duration mutable, if present in the same dispatcher. */
  setter: string | null;
  note: string;
}

const COOLDOWN_ACCESSORS: CooldownAccessor[] = [
  // Aave's staked-token family (stkAAVE / stkABPT) and its many forks.
  { signature: "COOLDOWN_SECONDS()", kind: "cooldown", units: "seconds", specificity: "standard", setter: null, note: "Aave staked-token cooldown: the wait between requesting an unstake and being able to take it" },
  { signature: "UNSTAKE_WINDOW()", kind: "claim_window", units: "seconds", specificity: "standard", setter: null, note: "Aave staked-token claim window: how long the unstake stays claimable once the cooldown elapses. Missing it restarts the cooldown" },
  // Ethena's staked-USDe family.
  { signature: "cooldownDuration()", kind: "cooldown", units: "seconds", specificity: "standard", setter: "setCooldownDuration(uint24)", note: "ERC4626 staking cooldown (Ethena StakedUSDeV2 shape): non-zero means withdraw/redeem are disabled and exit must go through cooldown → unstake" },
  // Generic named variants seen across staking/vault forks.
  { signature: "cooldownSeconds()", kind: "cooldown", units: "seconds", specificity: "generic", setter: null, note: "generic cooldown accessor" },
  { signature: "withdrawalDelay()", kind: "cooldown", units: "seconds", specificity: "generic", setter: null, note: "generic withdrawal delay" },
  { signature: "withdrawalDelaySeconds()", kind: "cooldown", units: "seconds", specificity: "generic", setter: null, note: "generic withdrawal delay" },
  { signature: "withdrawalDelayBlocks()", kind: "cooldown", units: "blocks", specificity: "generic", setter: null, note: "block-denominated withdrawal delay (EigenLayer shape)" },
  { signature: "unbondingPeriod()", kind: "cooldown", units: "seconds", specificity: "generic", setter: null, note: "generic unbonding period" },
  { signature: "lockPeriod()", kind: "cooldown", units: "seconds", specificity: "generic", setter: null, note: "generic lock period — the name is reused widely, so what it locks varies by project" },
  { signature: "lockupPeriod()", kind: "cooldown", units: "seconds", specificity: "generic", setter: null, note: "generic lockup period" },
  { signature: "exitDelay()", kind: "cooldown", units: "seconds", specificity: "generic", setter: null, note: "generic exit delay" },
  { signature: "waitingPeriod()", kind: "cooldown", units: "seconds", specificity: "generic", setter: null, note: "generic waiting period" },
];

/**
 * Two-step exit shapes, detected from the dispatcher's selector set rather
 * than from a readable duration. A pair matches only when BOTH sides are
 * present: a lone `redeem` is just ERC4626, while `cooldownShares` +
 * `unstake` together is unambiguously a queued exit.
 */
interface TwoStepPattern {
  name: string;
  request: string;
  claim: string;
  note: string;
}

const TWO_STEP_PATTERNS: TwoStepPattern[] = [
  { name: "cooldown→unstake", request: "cooldownShares(uint256)", claim: "unstake(address)", note: "Ethena StakedUSDe shape: shares are queued via cooldown, then claimed via unstake" },
  { name: "cooldown→redeem", request: "cooldown()", claim: "redeem(address,uint256)", note: "Aave staked-token shape: cooldown() starts the wait, redeem() takes the exit" },
  { name: "requestWithdrawal→claim", request: "requestWithdrawals(uint256[],address)", claim: "claimWithdrawals(uint256[],uint256[])", note: "Lido withdrawal-queue shape: a request is minted as an NFT and claimed once finalized" },
  { name: "requestRedeem→claim", request: "requestRedeem(uint256,address,address)", claim: "claimRedeem(uint256)", note: "ERC7540-style asynchronous redemption" },
  { name: "unstake→withdraw", request: "unstake(uint256)", claim: "withdraw(uint256)", note: "generic two-step unstake/withdraw pair" },
];

/**
 * Getters that report whether exit is halted RIGHT NOW at the pinned block.
 * Deliberately short. `paused()` is universal (OZ Pausable); the rest are
 * narrower names that carry the same meaning unambiguously. A non-boolean or
 * unreadable answer is ignored rather than guessed at.
 */
const PAUSE_GETTERS: { signature: string; meaning: string }[] = [
  { signature: "paused()", meaning: "OpenZeppelin Pausable: when true, the functions the protocol chose to gate are disabled" },
  { signature: "isWithdrawPaused()", meaning: "withdrawals specifically are paused" },
  { signature: "withdrawalsPaused()", meaning: "withdrawals specifically are paused" },
];

const uintAbiFor = (signature: string) => parseAbiItem(`function ${signature} view returns (uint256)`);
const boolAbiFor = (signature: string) => parseAbiItem(`function ${signature} view returns (bool)`);

/**
 * Rough seconds-per-block for converting a block-denominated delay. Mainnet
 * has produced a block every 12s since the Merge, so this is a real constant
 * rather than an estimate — but it IS chain-specific, so a block-denominated
 * accessor on a chain we have no constant for yields an UNMEASURED leg rather
 * than a converted guess.
 */
const SECONDS_PER_BLOCK: Record<number, number> = { 1: 12 };

export interface TimeToExitDetection {
  result: TimeToExit;
  unknowns: UnknownEntry[];
}

export async function analyseTimeToExit(
  chain: ChainReader,
  target: Hex,
  args: { proxy: ProxyResult; capabilities: CapabilitiesResult },
): Promise<TimeToExitDetection> {
  const unknowns: UnknownEntry[] = [];
  const evidence: Evidence[] = [];
  const legs: ExitLeg[] = [];
  const unmeasuredLegs: { name: string; reason: string }[] = [];

  // The selector set of whatever code actually runs for this address — the
  // implementation for a proxy, exactly as capability detection resolves it.
  // Reused (not recomputed) so the two can never disagree about what the
  // contract exposes.
  const selectorSet = new Set<string>();
  let dispatcherRecognized: boolean;
  const scanAddress = (args.capabilities.scannedAddress ?? target) as Hex;
  {
    const { code, evidence: codeEvidence } = await chain.getCode(scanAddress);
    evidence.push(codeEvidence);
    if (code) {
      const dispatch = extractDispatcherSelectors(code);
      if (dispatch.recognized) {
        dispatcherRecognized = true;
        for (const s of dispatch.selectors) selectorSet.add(s.toLowerCase());
      } else {
        dispatcherRecognized = false;
      }
    } else {
      dispatcherRecognized = false;
    }
  }

  // --- 1. Cooldown / claim-window accessors. ---
  for (const accessor of COOLDOWN_ACCESSORS) {
    const selector = toFunctionSelector(accessor.signature).toLowerCase();
    // Only call accessors the contract actually exposes when we can see its
    // dispatcher: it avoids a pile of pointless reverting calls, and — more
    // importantly — it stops a fallback-returning contract from answering a
    // getter it does not implement.
    if (dispatcherRecognized && !selectorSet.has(selector)) continue;

    const data = encodeFunctionData({ abi: [uintAbiFor(accessor.signature)] });
    const { result, reverted, evidence: callEvidence } = await chain.call(target, data);
    evidence.push(callEvidence);
    if (reverted || !result) continue;

    let raw: bigint;
    try {
      raw = decodeFunctionResult({ abi: [uintAbiFor(accessor.signature)], data: result }) as unknown as bigint;
    } catch {
      unmeasuredLegs.push({
        name: accessor.signature,
        reason: "the accessor resolved but its return value did not decode as a uint256 — recorded as an unmeasured leg rather than dropped",
      });
      continue;
    }

    // A zero cooldown is a real, meaningful reading: for the Ethena shape it
    // is precisely how the protocol signals "exit is currently synchronous."
    // Recorded as a measured zero-length leg, not skipped.
    const secondsPerBlock = SECONDS_PER_BLOCK[chain.chainId];
    if (accessor.units === "blocks" && secondsPerBlock === undefined) {
      unmeasuredLegs.push({
        name: accessor.signature,
        reason: `returns a BLOCK count (${raw}) and Ripcord has no seconds-per-block constant for chain ${chain.chainId} — converting it would be a guess, so the leg is left unmeasured`,
      });
      continue;
    }
    const seconds = accessor.units === "blocks" ? raw * BigInt(secondsPerBlock!) : raw;

    const mutableBy =
      accessor.setter && (!dispatcherRecognized || selectorSet.has(toFunctionSelector(accessor.setter).toLowerCase()))
        ? accessor.setter
        : null;

    legs.push({
      kind: accessor.kind,
      name: accessor.signature,
      // A claim window constrains WHEN you must act, it does not add waiting —
      // see the composition rule in the file header. Recorded with its real
      // duration but contributing zero to the sum (handled below).
      seconds: seconds.toString(),
      measured: true,
      confidence: accessor.specificity === "standard" ? "high" : "medium",
      mutableBy,
      note:
        `${accessor.note}. Read ${raw}${accessor.units === "blocks" ? ` blocks (~${seconds}s at ${secondsPerBlock}s/block)` : "s"}.` +
        (mutableBy
          ? ` NOTE: ${mutableBy} is present in this contract's dispatcher, so this duration is a privileged SETTING, not a constant — the authority can change how long it takes you to leave.`
          : ""),
      evidence: [callEvidence],
    });
  }

  // --- 2. Two-step request/claim shapes, from the selector set. ---
  if (dispatcherRecognized) {
    for (const pattern of TWO_STEP_PATTERNS) {
      const hasRequest = selectorSet.has(toFunctionSelector(pattern.request).toLowerCase());
      const hasClaim = selectorSet.has(toFunctionSelector(pattern.claim).toLowerCase());
      if (!hasRequest || !hasClaim) continue;

      // If a cooldown accessor already measured this protocol's wait, the
      // two-step shape is the same leg seen from the other side — record it,
      // but do not double-count it as an extra unknown wait.
      const alreadyMeasured = legs.some((l) => l.kind === "cooldown" && l.measured);
      legs.push({
        kind: "two_step",
        name: `${pattern.request} → ${pattern.claim}`,
        seconds: null,
        measured: false,
        confidence: "medium",
        mutableBy: null,
        note: alreadyMeasured
          ? `${pattern.note}. The wait between the two steps is the cooldown already measured above; this entry records the exit's shape, and adds no separate unknown.`
          : `${pattern.note}. Exit is queued, and Ripcord could not read how long the queue takes — this leg is of UNKNOWN length, which makes the whole time-to-exit a lower bound.`,
        evidence: [
          {
            kind: "bytecode",
            params: { address: scanAddress, request: pattern.request, claim: pattern.claim },
            rawValue: { requestSelector: toFunctionSelector(pattern.request), claimSelector: toFunctionSelector(pattern.claim) },
            block: chain.blockNumber.toString(),
          },
        ],
      });
      if (!alreadyMeasured) {
        unmeasuredLegs.push({
          name: `${pattern.request} → ${pattern.claim}`,
          reason: "a two-step exit is present but exposes no readable duration accessor, so the queue length is unknown",
        });
      }
    }
  } else {
    unmeasuredLegs.push({
      name: "two-step exit detection",
      reason: `the dispatcher at ${scanAddress} could not be parsed, so request/claim exit shapes could not be enumerated — absence of a detected queue here is NOT evidence there is none`,
    });
  }

  // --- 3. Current pause state at the pinned block. ---
  let currentlyBlocked: { getter: string; meaning: string; evidence: Evidence } | null = null;
  for (const getter of PAUSE_GETTERS) {
    if (dispatcherRecognized && !selectorSet.has(toFunctionSelector(getter.signature).toLowerCase())) continue;
    const data = encodeFunctionData({ abi: [boolAbiFor(getter.signature)] });
    const { result, reverted, evidence: callEvidence } = await chain.call(target, data);
    evidence.push(callEvidence);
    if (reverted || !result) continue;
    let value: boolean;
    try {
      value = decodeFunctionResult({ abi: [boolAbiFor(getter.signature)], data: result }) as unknown as boolean;
    } catch {
      // An undecodable pause getter leaves the CURRENT pause state unread. That
      // is not "not paused": `currentlyBlocked` staying null is what makes the
      // verdict omit the "exit is HALTED" clause, so a failed read here would
      // quietly drop the single most consequential fact in a report (the live
      // PAID case reads `paused() == true`). Recorded as an unmeasured leg.
      unmeasuredLegs.push({
        name: getter.signature,
        reason:
          "the pause getter resolved but its return value did not decode as a bool — the CURRENT pause state is unknown, and must not be read as 'not paused'",
      });
      continue;
    }
    if (value) {
      currentlyBlocked = { getter: getter.signature, meaning: getter.meaning, evidence: callEvidence };
      break;
    }
  }

  // --- 4. Exit blockability, from day-2 capability findings. ---
  const blockable = assessBlockability(args.capabilities, currentlyBlocked);

  // --- Compose. ---
  const composed = compose(legs, unmeasuredLegs, dispatcherRecognized, currentlyBlocked !== null);

  if (!dispatcherRecognized) {
    unknowns.push({
      field: "timeToExit",
      reason: `the dispatcher at ${scanAddress} could not be parsed, so cooldown accessors were called blind and two-step exit shapes could not be enumerated — the time-to-exit model is incomplete by an unknown amount`,
    });
  }
  for (const leg of unmeasuredLegs) {
    unknowns.push({ field: "timeToExit.legs", reason: `${leg.name}: ${leg.reason}` });
  }

  return {
    result: {
      rulesVersion: exitPatternsVersion,
      status: composed.status,
      atLeastSeconds: composed.atLeastSeconds,
      tight: composed.tight,
      legs,
      unmeasuredLegs,
      liquidity: {
        modelled: false,
        reason:
          "Liquidity depth is not modelled. Establishing whether a given position could actually be sold requires pool discovery and depth integration across venues — an indexer, which Ripcord deliberately does not run (same reason its major-token list is curated). Any shortcut available here would produce an authoritative-looking number that is not one, so no number is produced. Practical consequence: for a position large relative to available liquidity the real time-to-exit is LONGER than the figure above, never shorter.",
      },
      blockable,
      confidence: composed.confidence,
      statement: composed.statement,
      evidence,
    },
    unknowns,
  };
}

/**
 * Who can stop you leaving. Two independent signals, kept separate because
 * they answer different questions: `currently_blocked` is read state right now
 * (exit is halted at this block), while `blockable` is a capability that
 * exists and is attributed to a holder. The second is never phrased as a
 * prediction — it says a holder CAN, not that anyone will.
 */
function assessBlockability(
  capabilities: CapabilitiesResult,
  currentlyBlocked: { getter: string; meaning: string; evidence: Evidence } | null,
): ExitBlockability {
  const restrictions = capabilities.findings.filter((f) => f.category === "ACCESS_RESTRICTION");
  const holders = [
    ...new Set(
      restrictions.flatMap((f) => (f.guard.status === "attributed" ? f.guard.holders : [])).map((h) => h.toLowerCase()),
    ),
  ];
  const unattributed = restrictions.filter((f) => f.guard.status !== "attributed");
  const manual = capabilities.needsManualVerification.filter((e) => e.category === "ACCESS_RESTRICTION");

  if (currentlyBlocked) {
    return {
      status: "currently_blocked",
      by: holders,
      note: `${currentlyBlocked.getter} reads true at the pinned block — ${currentlyBlocked.meaning}. Time-to-exit is not merely long here, it is unbounded until that state changes.`,
      evidence: [currentlyBlocked.evidence],
    };
  }
  if (holders.length > 0) {
    return {
      status: "blockable",
      by: holders,
      note: `${restrictions.length} ACCESS_RESTRICTION capability/capabilities (${restrictions
        .map((f) => f.signature)
        .join(", ")}) are attributed to ${holders.length} holder(s). Those holders CAN restrict transfers or halt the protocol — a capability, not a prediction. Where such a holder is also on an un-delayed authority route, the same party that can change the rules can also stop you leaving before the change lands.`,
      evidence: restrictions.flatMap((f) => f.guard.evidence),
    };
  }
  if (unattributed.length > 0 || manual.length > 0) {
    return {
      status: "undetermined",
      by: [],
      note: `${unattributed.length + manual.length} ACCESS_RESTRICTION capability/capabilities were detected but could not be attributed to an identified holder, so whether exit can be blocked — and by whom — is undetermined, not absent.`,
      evidence: [],
    };
  }
  if (capabilities.dispatcherRecognized) {
    return {
      status: "not_observed",
      by: [],
      note: "no ACCESS_RESTRICTION capability was found in this contract's taxonomy-matched selectors. This is an observation, not a guarantee: unmatched selectors were not evaluated for privilege.",
      evidence: [],
    };
  }
  return {
    status: "undetermined",
    by: [],
    note: "the dispatcher could not be parsed, so no capability set was available and exit-blockability could not be assessed either way.",
    evidence: [],
  };
}

/**
 * Turns the legs into a lower bound plus an honest label. The rules here are
 * the ones an auditor should push on, so they are explicit:
 *   - Only `cooldown` and `queue` legs add waiting. A `claim_window` records a
 *     deadline, not a delay, and contributes zero.
 *   - `tight` requires everything: a readable dispatcher, no unmeasured leg,
 *     and no current block. Any gap removes it.
 *   - No detected mechanism, with a readable dispatcher, is a real positive
 *     observation at MEDIUM confidence — never "high", because the pattern
 *     tables here are curated and finite.
 */
function compose(
  legs: ExitLeg[],
  unmeasuredLegs: { name: string; reason: string }[],
  dispatcherRecognized: boolean,
  currentlyBlocked: boolean,
): { status: TimeToExit["status"]; atLeastSeconds: string | null; tight: boolean; confidence: DepthConfidence; statement: string } {
  const waiting = legs.filter((l) => l.kind === "cooldown" || l.kind === "queue");
  const measuredWait = waiting.filter((l) => l.measured && l.seconds !== null);
  const sum = measuredWait.reduce((acc, l) => acc + BigInt(l.seconds!), 0n);
  const mutable = legs.filter((l) => l.mutableBy !== null);

  if (currentlyBlocked) {
    return {
      status: "blocked",
      atLeastSeconds: sum.toString(),
      tight: false,
      confidence: "high",
      statement:
        "Exit is halted at the pinned block: a pause getter reads true. Time-to-exit is unbounded — not long, but undefined — until that state is lifted by whoever controls it.",
    };
  }

  if (!dispatcherRecognized) {
    return {
      status: "undetermined",
      atLeastSeconds: measuredWait.length > 0 ? sum.toString() : null,
      tight: false,
      confidence: "low",
      statement:
        "Time-to-exit undetermined: this contract's dispatcher could not be parsed, so its exit mechanisms could not be enumerated. Nothing found here should be read as nothing present.",
    };
  }

  if (legs.length === 0) {
    return {
      status: "no_mechanism_detected",
      atLeastSeconds: "0",
      tight: true,
      confidence: "medium",
      statement:
        "No exit-delay mechanism was detected: none of the cooldown/unstaking accessors Ripcord knows resolve, and no two-step request/claim exit shape is present in the dispatcher. Exit appears to be synchronous. This is a positive observation over a curated, finite pattern table — not proof that no delay exists.",
    };
  }

  const tight = unmeasuredLegs.length === 0;
  const mutableNote =
    mutable.length > 0
      ? ` Note that ${mutable.length} leg(s) are privileged SETTINGS rather than constants (${mutable
          .map((l) => `${l.name} via ${l.mutableBy}`)
          .join(", ")}), so this duration reflects the authority's current choice and can be raised.`
      : "";

  if (!tight) {
    return {
      status: "lower_bound",
      atLeastSeconds: sum.toString(),
      tight: false,
      confidence: "medium",
      statement: `Time to exit is AT LEAST ${sum}s, possibly more: ${measuredWait.length} waiting leg(s) were measured but ${unmeasuredLegs.length} detected leg(s) could not be (${unmeasuredLegs
        .map((l) => l.name)
        .join("; ")}). The unmeasured legs are named rather than treated as zero, which is why this is a floor and not a value.${mutableNote}`,
    };
  }

  // Only legs that actually add waiting are quoted with a duration. A
  // claim_window has a real duration that adds nothing to the wait, and a
  // two_step leg has none at all — quoting either as "= Ns" alongside the
  // cooldown would misrepresent the arithmetic that produced the total.
  const waitDesc = measuredWait.map((l) => `${l.name} = ${l.seconds}s`).join(" + ") || "no waiting legs";
  const shapeDesc = legs
    .filter((l) => !measuredWait.includes(l))
    .map((l) => (l.seconds !== null ? `${l.name} (${l.kind}, ${l.seconds}s, adds no waiting)` : `${l.name} (${l.kind})`))
    .join(", ");
  return {
    status: "measured",
    atLeastSeconds: sum.toString(),
    tight: true,
    confidence: legs.every((l) => l.confidence === "high") ? "high" : "medium",
    statement:
      `Time to exit is ${sum}s: ${waitDesc}.` +
      (shapeDesc ? ` Also detected, adding no waiting: ${shapeDesc}.` : "") +
      ` Every leg that adds waiting was read.${mutableNote} Liquidity depth is not modelled, so a position large relative to available liquidity would take longer.`,
  };
}
