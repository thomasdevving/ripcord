/**
 * The verdict (day 4, part 3): the two sides composed into one judgement.
 *
 * This is a PURE function of the two assessments — no chain access, no I/O —
 * because the composition rules are the part an auditor will argue with, and
 * rules you can argue with should be rules you can test exhaustively without a
 * network. Everything it needs is already evidence-backed upstream; its job is
 * to combine, not to discover.
 *
 * THE COMPARISON:
 *   time-to-exit >= exit-window  →  you cannot finish leaving before the rules
 *                                   CAN change.
 *
 * `>=`, not `>`, and the difference is not pedantry. sUSDe at the pinned block
 * is the live case that forces it: `cooldownDuration()` reads 86400 and its
 * owner is a TimelockController whose `getMinDelay()` also reads 86400. If you
 * start leaving the instant a change is queued, you become free to move at
 * precisely the moment the change becomes executable. That is a dead heat, not
 * an escape. `marginSeconds` is published alongside so a dead heat reads as
 * one rather than vanishing into a category.
 *
 * WHY `no_notice` IS ITS OWN STATUS, not just `trapped`:
 *   When some route imposes zero notice, the comparison does not merely come
 *   out badly — it stops being a comparison. A change that requires no waiting
 *   and your exit are not orderable events: there is nothing to be faster
 *   than. Reporting that as `trapped` alongside a computed margin would imply
 *   an arithmetic that was never performed. The conclusion is the same; the
 *   REASON is different, and the reason is what an auditor checks.
 *
 * HOW IT DEGRADES:
 *   A crisp verdict requires BOTH sides to be determined, and the time-to-exit
 *   side to be `tight` (see timeToExit.ts — a lower bound with a named gap
 *   cannot support "you can exit in time," though it can still support
 *   "you cannot"). Anything less returns `undetermined` with `missing[]`
 *   naming exactly what is absent. A well-chosen "cannot determine — here is
 *   what is missing" is a correct answer; a crisp wrong one is not.
 *
 *   One asymmetry is deliberate and worth stating: a NON-tight time-to-exit
 *   can still yield `trapped`, because a lower bound that already exceeds the
 *   window can only grow. It can never yield `can_exit_in_time`, because the
 *   unmeasured legs could be arbitrarily long. The uncertainty is allowed to
 *   push the verdict toward caution and never away from it.
 *
 * CAPABILITY, NOT INTENT, in every string: "before the rules CAN change,"
 * never "will."
 */
import type { DepthConfidence, ExitWindow, TimeToExit, Verdict, VerdictInput } from "./schema.js";

/** Weakest-link: the verdict is only as strong as its weakest input. */
function weakest(values: DepthConfidence[]): DepthConfidence {
  if (values.includes("low")) return "low";
  if (values.includes("medium")) return "medium";
  return "high";
}

/** Human-readable duration for the statement strings. Seconds stay authoritative in the data fields. */
export function humanDuration(seconds: bigint): string {
  if (seconds === 0n) return "0s";
  const day = 86_400n;
  const hour = 3_600n;
  if (seconds % day === 0n) return `${seconds / day} day${seconds / day === 1n ? "" : "s"}`;
  if (seconds >= day) return `${(Number(seconds) / 86_400).toFixed(1)} days`;
  if (seconds % hour === 0n) return `${seconds / hour} hour${seconds / hour === 1n ? "" : "s"}`;
  return `${seconds}s`;
}

export function composeVerdict(exitWindow: ExitWindow | null, timeToExit: TimeToExit | null): Verdict {
  const inputs: VerdictInput[] = [];
  const missing: string[] = [];

  if (!exitWindow) missing.push("the exit-window stage did not run (see errors[])");
  if (!timeToExit) missing.push("the time-to-exit stage did not run (see errors[])");

  if (exitWindow) {
    inputs.push({
      name: "exitWindow.assessment.status",
      value: exitWindow.assessment.status,
      confidence: exitWindow.assessment.confidence,
      source: `exitWindow (rules ${exitWindow.rulesVersion}), ${exitWindow.routes.length} authority route(s), ${exitWindow.bypasses.length} bypass(es), ${exitWindow.checksPerformed.filter((c) => c.performed).length}/${exitWindow.checksPerformed.length} checks performed`,
    });
    inputs.push({
      name: "exitWindow.windowSeconds",
      value: exitWindow.assessment.status === "binding" ? exitWindow.assessment.windowSeconds : null,
      confidence: exitWindow.assessment.confidence,
      source:
        exitWindow.assessment.status === "binding"
          ? "minimum proven-binding delay across all resolved authority routes"
          : `no window value is available in status "${exitWindow.assessment.status}" — by design, an unproven delay is never expressed as a window`,
    });
  }
  if (timeToExit) {
    inputs.push({
      name: "timeToExit.atLeastSeconds",
      value: timeToExit.atLeastSeconds,
      confidence: timeToExit.confidence,
      source: `timeToExit (rules ${timeToExit.rulesVersion}), status=${timeToExit.status}, tight=${timeToExit.tight}, ${timeToExit.legs.length} leg(s), ${timeToExit.unmeasuredLegs.length} unmeasured`,
    });
    inputs.push({
      name: "timeToExit.blockable.status",
      value: timeToExit.blockable.status,
      confidence: timeToExit.confidence,
      source: "ACCESS_RESTRICTION capabilities attributed to a holder, plus pause state read at the pinned block",
    });
    inputs.push({
      name: "timeToExit.liquidity.modelled",
      value: "false",
      confidence: "low",
      source: "liquidity depth is explicitly not modelled — see timeToExit.liquidity.reason",
    });
  }

  const undetermined = (reasons: string[], confidence: DepthConfidence, statement: string): Verdict => ({
    status: "undetermined",
    statement,
    exitWindowSeconds: null,
    timeToExitSeconds: timeToExit?.atLeastSeconds ?? null,
    marginSeconds: null,
    confidence,
    missing: [...missing, ...reasons],
    inputs,
  });

  if (!exitWindow || !timeToExit) {
    return undetermined(
      [],
      "low",
      "Verdict undetermined: one or both sides of the comparison could not be produced. Nothing here should be read as an absence of risk.",
    );
  }

  const blockedSuffix =
    timeToExit.blockable.status === "currently_blocked"
      ? " Separately, exit is HALTED at the pinned block, so the time to leave is currently unbounded regardless of the arithmetic above."
      : timeToExit.blockable.status === "blockable"
        ? ` Separately, ${timeToExit.blockable.by.length} holder(s) hold an attributed capability that CAN restrict transfers or halt the protocol — the exit itself can be closed, which no notice period protects against.`
        : "";

  // --- The window side collapses the comparison. ---
  if (exitWindow.assessment.status === "no_notice") {
    return {
      status: "no_notice",
      statement: `You cannot exit ahead of a rule change here: at least one authority route can change the rules with ZERO notice, so there is no interval to move inside — however fast the exit is. ${exitWindow.assessment.statement}${blockedSuffix}`,
      exitWindowSeconds: "0",
      timeToExitSeconds: timeToExit.atLeastSeconds,
      marginSeconds: null,
      confidence: weakest([exitWindow.assessment.confidence, timeToExit.confidence]),
      missing: [],
      inputs,
    };
  }

  if (exitWindow.assessment.status === "no_rule_change_route_found") {
    return {
      status: "no_rule_change_route_found",
      statement: `No exit-window risk was identified: no upgrade path, owner, role or attributed privileged capability was found, so no authority was found that could change the rules on a holder. ${exitWindow.assessment.caveats.join(" ")}${blockedSuffix}`,
      exitWindowSeconds: null,
      timeToExitSeconds: timeToExit.atLeastSeconds,
      marginSeconds: null,
      confidence: weakest([exitWindow.assessment.confidence, timeToExit.confidence]),
      missing: [],
      inputs,
    };
  }

  if (exitWindow.assessment.status === "undetermined" || exitWindow.assessment.status === "not_proven_binding") {
    const windowMissing = exitWindow.assessment.missing;
    // An unverified window still supports one honest statement: if the exit
    // ALREADY takes longer than the most generous delay observed, no
    // resolution of the remaining uncertainty can rescue it — every unresolved
    // route can only make the window shorter, never longer.
    const nominal =
      exitWindow.assessment.status === "not_proven_binding" ? exitWindow.assessment.nominalDelaySeconds : null;
    if (nominal !== null && timeToExit.atLeastSeconds !== null && BigInt(timeToExit.atLeastSeconds) >= BigInt(nominal)) {
      return {
        status: "trapped",
        statement: `You cannot exit before the rules CAN change. Leaving takes at least ${humanDuration(BigInt(timeToExit.atLeastSeconds))}, while the most notice any resolved authority route imposes is ${humanDuration(BigInt(nominal))}. The remaining unresolved routes can only make the real window SHORTER, never longer, so resolving them cannot change this conclusion — which is why a verdict is reachable here despite the window itself not being established.${blockedSuffix}`,
        exitWindowSeconds: null,
        timeToExitSeconds: timeToExit.atLeastSeconds,
        marginSeconds: (BigInt(nominal) - BigInt(timeToExit.atLeastSeconds)).toString(),
        confidence: weakest([exitWindow.assessment.confidence, timeToExit.confidence]),
        missing: windowMissing,
        inputs,
      };
    }
    return undetermined(
      windowMissing,
      weakest([exitWindow.assessment.confidence, timeToExit.confidence]),
      `Verdict undetermined on the exit-window side: ${exitWindow.assessment.statement} Time to exit is ${
        timeToExit.atLeastSeconds === null ? "also undetermined" : `at least ${humanDuration(BigInt(timeToExit.atLeastSeconds))}`
      }, but the comparison cannot be made against a window that was not established.${blockedSuffix}`,
    );
  }

  // --- The window is a proven, binding, non-zero number. ---
  const windowSeconds = BigInt(exitWindow.assessment.windowSeconds);

  if (timeToExit.status === "undetermined" || timeToExit.atLeastSeconds === null) {
    return undetermined(
      [`time to exit could not be determined: ${timeToExit.statement}`],
      weakest([exitWindow.assessment.confidence, timeToExit.confidence]),
      `Verdict undetermined on the exit side: the rules cannot change for at least ${humanDuration(windowSeconds)}, but how long a holder needs to leave could not be established, so the two cannot be compared.${blockedSuffix}`,
    );
  }

  const exitSeconds = BigInt(timeToExit.atLeastSeconds);
  const margin = windowSeconds - exitSeconds;

  if (exitSeconds >= windowSeconds) {
    const dead = margin === 0n;
    return {
      status: "trapped",
      statement: dead
        ? `Dead heat: the rules CAN change after ${humanDuration(windowSeconds)} of notice, and leaving takes ${humanDuration(exitSeconds)} — exactly the same. You would finish exiting at the instant the change becomes effective, not before it. Any latency, missed claim window, or queue congestion puts you on the wrong side of it.${blockedSuffix}`
        : `You cannot exit before the rules CAN change: the notice period is ${humanDuration(windowSeconds)}, leaving takes at least ${humanDuration(exitSeconds)}, and you are ${humanDuration(-margin)} short.${blockedSuffix}`,
      exitWindowSeconds: windowSeconds.toString(),
      timeToExitSeconds: exitSeconds.toString(),
      marginSeconds: margin.toString(),
      confidence: weakest([exitWindow.assessment.confidence, timeToExit.confidence]),
      missing: [],
      inputs,
    };
  }

  // exitSeconds < windowSeconds. A two-sided "you can leave in time" claim
  // requires the exit bound to be tight — an unmeasured leg could be longer
  // than the whole margin, so uncertainty must not buy a favourable verdict.
  if (!timeToExit.tight) {
    return undetermined(
      [
        `time to exit is a LOWER bound of ${timeToExit.atLeastSeconds}s with ${timeToExit.unmeasuredLegs.length} unmeasured leg(s): ${timeToExit.unmeasuredLegs.map((l) => l.name).join("; ")}`,
      ],
      weakest([exitWindow.assessment.confidence, timeToExit.confidence]),
      `Verdict undetermined: the rules cannot change for at least ${humanDuration(windowSeconds)}, and the measured part of leaving takes ${humanDuration(exitSeconds)} — but ${timeToExit.unmeasuredLegs.length} leg(s) of the exit could not be measured, and any one of them could exceed the ${humanDuration(margin)} of slack. An unmeasured leg is not a zero-length one.${blockedSuffix}`,
    );
  }

  return {
    status: "can_exit_in_time",
    statement: `You can exit before the rules CAN change: the notice period is ${humanDuration(windowSeconds)}, leaving takes ${humanDuration(exitSeconds)}, leaving ${humanDuration(margin)} of slack. Liquidity depth is not modelled, so a position large relative to available liquidity could still take longer than the measured exit path.${blockedSuffix}`,
    exitWindowSeconds: windowSeconds.toString(),
    timeToExitSeconds: exitSeconds.toString(),
    marginSeconds: margin.toString(),
    confidence: weakest([exitWindow.assessment.confidence, timeToExit.confidence]),
    missing: [],
    inputs,
  };
}
