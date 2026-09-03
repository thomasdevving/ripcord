/**
 * OPTIONAL, TYPED OBSERVATION of an in-flight analysis.
 *
 * The web layer needs to show a scan happening rather than a spinner that ends
 * in a wall of JSON. That requirement must not be allowed to reach into the
 * engine, so this module is shaped by three constraints:
 *
 *  1. IT CANNOT CHANGE THE RESULT. Every hook is optional, returns void, and is
 *     invoked through `notify` below, which contains the only justified catch in
 *     this file: a presentation callback that throws must not alter, abort or
 *     degrade a deterministic report. It is not silent — it writes a warning to
 *     stderr — but it is contained. A report produced with an observer attached
 *     is byte-identical to one produced without, and `test/observer.test.ts`
 *     asserts exactly that.
 *
 *  2. IT CARRIES NO TRANSPORT METADATA. No timestamps, no sequence numbers, no
 *     job ids. Those are stamped on by the server (server/shared/dto.ts). If a
 *     wall-clock time were minted here it would be one refactor away from being
 *     recorded as evidence, and evidence with a wall-clock in it is no longer
 *     reproducible.
 *
 *  3. IT PASSES ALREADY-COMPUTED VALUES, never re-derived ones. Each hook hands
 *     over the very object the stage produced. The alternative — the observer
 *     computing its own view of "who holds power" — is a second implementation
 *     of the risk logic, and two implementations disagree eventually. The web
 *     layer renders these; it never recomputes them.
 *
 * Stage names and their ORDER mirror `buildReport`'s real `runStage` calls. They
 * are not a storyboard and must not be reordered to suit an animation.
 */
import type {
  AccessControlResult,
  AuthorityIndirection,
  AuthorityResolution,
  CapabilitiesResult,
  Disclosure,
  ExitWindow,
  OwnerField,
  PowerHolder,
  ProxyResult,
  TimeToExit,
  Verdict,
} from "./schema.js";

export type EngineStage =
  | "proxy"
  | "ownership"
  | "accessControl"
  | "capabilities"
  | "authorityResolution"
  | "authorityIndirection"
  | "dependencies"
  | "exitWindow"
  | "timeToExit"
  /** The pinned block's hash, read last. Folded into the "report" phase by the web layer. */
  | "block"
  | "report";

/**
 * How a stage ended.
 *
 * `completed` — it ran and answered. A zero-result answer ("no roles exist
 *   here") is a completion, not a failure.
 * `inconclusive` — it ran and could not answer. First-class in this project:
 *   an undetermined exit window is a finding about the search, not an error.
 * `degraded` — it threw and a fallback value was substituted (see runStage).
 *   Kept distinct from both of the above so a UI can never paint it the same
 *   green as a clean completion: a stage that actually failed, shown as done,
 *   is the false-clean this codebase exists to refuse.
 */
export type StageOutcome = "completed" | "inconclusive" | "degraded";

export interface StageEnd {
  stage: EngineStage;
  outcome: StageOutcome;
  /** One factual line about what was observed. Never a projection. */
  detail: string | null;
  /** Only counts that were actually measured. An absent key means "not measured", never zero. */
  metrics?: Record<string, number | string | boolean | null>;
}

/**
 * Hooks are handed the stage's own output object.
 *
 * NOTE ON DISCLOSURE: `onCapabilities` fires with the full capability result,
 * INCLUDING entries the publication gate may later block. That is safe here
 * because an observer is an in-process callback, not a transport. The server's
 * observer implementation is what decides what may leave the process before the
 * gate has run, and it deliberately forwards no capability signatures, selectors
 * or probe payloads — only the fact that the stage completed and how many
 * selectors it recovered. See server/jobs/observer.ts.
 */
export interface RunObserver {
  onStageStart?(stage: EngineStage): void;
  onStageEnd?(end: StageEnd): void;

  onProxy?(proxy: ProxyResult): void;
  onOwnership?(ownership: { owner: OwnerField; pendingOwner: OwnerField }): void;
  onAccessControl?(accessControl: AccessControlResult): void;
  onCapabilities?(capabilities: CapabilitiesResult): void;
  onPowerHolders?(holders: PowerHolder[]): void;
  onAuthority?(resolution: AuthorityResolution | null): void;
  onAuthorityIndirection?(indirection: AuthorityIndirection | null): void;
  onExitWindow?(exitWindow: ExitWindow | null): void;
  onTimeToExit?(timeToExit: TimeToExit | null): void;
  onVerdict?(verdict: Verdict | null, disclosure: Disclosure): void;
}

// --- fork differential -------------------------------------------------------

/**
 * The three evidence blocks the fork differential produces, plus the two steps
 * that bracket them. These mirror `runCometArchetype`'s real sequence: identify
 * the exit action, establish the control, mutate, re-run the identical exit.
 *
 * The ORDER is causal, not decorative. A UI that showed the mutation before the
 * baseline would be showing an experiment with no control, which is the thing
 * this engine exists to avoid asserting.
 */
export type ForkPhase = "exit_action" | "baseline" | "mutation" | "reexit" | "verdict";

/**
 * A party the differential impersonated, and what it was able to do.
 *
 * This is FOUND INFORMATION like any other — read from the contract (Comet's
 * `pauseGuardian()`), classified on the fork, and then demonstrated. It is
 * reported separately from the prose so the power map can show it as a node,
 * because otherwise the most consequential party in the whole analysis appears
 * only in the report text: the static detectors never see it, since it is
 * reached through neither owner(), a role, nor the proxy admin.
 */
export interface ForkParty {
  address: string;
  type: "eoa" | "safe" | "contract";
  /** Only when the fork actually read them. */
  safeThreshold: number | null;
  safeOwners: number | null;
  /** The function it was shown to be able to call. */
  signature: string;
  /** A direction-unambiguous relation, e.g. "can pause withdrawals of". */
  relation: string;
  /** True only once the differential positively confirmed the restriction. */
  confirmed: boolean;
}

export interface ForkStep {
  phase: ForkPhase;
  outcome: StageOutcome;
  detail: string;
  /** Present on the mutation and verdict steps once a guarding party has been identified. */
  party?: ForkParty;
  /**
   * Evidence THE ENGINE ALREADY RECORDED for this step — fork transaction
   * receipts and reads, passed by reference. The observer never synthesises a
   * receipt fact, so what a viewer sees in the UI and what a downloaded report
   * contains are the same bytes.
   */
  evidence?: readonly unknown[];
}

export interface ForkObserver {
  onForkStart?(phase: ForkPhase): void;
  onForkStep?(step: ForkStep): void;
}

/** Same containment guarantee as `notify`, for the fork engine's observer. */
export function notifyFork<K extends keyof ForkObserver>(
  observer: ForkObserver | undefined,
  hook: K,
  ...args: Parameters<NonNullable<ForkObserver[K]>>
): void {
  const fn = observer?.[hook];
  if (typeof fn !== "function") return;
  try {
    (fn as (...a: unknown[]) => void).apply(observer, args);
  } catch (err) {
    console.error(
      `[ripcord] fork observer hook "${String(hook)}" threw and was contained; the differential is unaffected: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Invokes one observer hook.
 *
 * THE CATCH HERE IS DELIBERATE AND IS THE ONLY ONE. Rule 3 of this project
 * forbids silent catches; this one is neither silent (it warns on stderr) nor a
 * swallowed failure of a chain read. It contains a failure in PRESENTATION code
 * so that it cannot corrupt an ANALYSIS: a broken SSE consumer must not be able
 * to change what a report says about a contract, and a browser closing its tab
 * mid-scan must not alter the outcome. The failure direction is the safe one —
 * we lose a progress frame, never a fact.
 */
export function notify<K extends keyof RunObserver>(
  observer: RunObserver | undefined,
  hook: K,
  ...args: Parameters<NonNullable<RunObserver[K]>>
): void {
  const fn = observer?.[hook];
  if (typeof fn !== "function") return;
  try {
    (fn as (...a: unknown[]) => void).apply(observer, args);
  } catch (err) {
    console.error(
      `[ripcord] observer hook "${String(hook)}" threw and was contained; the analysis is unaffected: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
