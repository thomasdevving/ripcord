/**
 * The phase timeline.
 *
 * Phases are listed in the ENGINE'S REAL ORDER and only those the selected mode
 * actually runs. There is no percentage bar: a percentage would have to be
 * invented, because the engine does not know in advance how many RPC round-trips
 * a role reconstruction will take, and a bar that walks to 100% independently of
 * the work is a progress indicator that lies. Discrete phases with real statuses
 * say more and claim less.
 *
 * FOUR DISTINCT NON-PENDING STATUSES, and the distinctions are load-bearing:
 *   completed    — ran and answered. A zero-result answer counts (no roles is an
 *                  answer). This is the ONLY green, and it means the step
 *                  finished, never that the contract is safe.
 *   inconclusive — ran and could not answer. First-class here, not a failure.
 *   degraded     — threw, and a fallback value was substituted. Never green: an
 *                  unconditional green on a stage that actually failed is the
 *                  false-clean this project exists to refuse.
 *   failed       — stopped the run.
 */
import type { PhaseSnapshot } from "@shared/dto";
import { PHASES } from "@shared/dto";
import type { ReactElement } from "react";

export function PhaseTimeline({ phases }: { phases: PhaseSnapshot[] }): ReactElement {
  return (
    <div className="timeline" role="list" aria-label="Analysis phases">
      {phases.map((phase) => {
        const descriptor = PHASES.find((p) => p.id === phase.id);
        const statusWord =
          phase.status === "completed"
            ? "finished"
            : phase.status === "inconclusive"
              ? "ran, could not answer"
              : phase.status === "degraded"
                ? "failed, fallback used"
                : phase.status;
        return (
          <div
            key={phase.id}
            role="listitem"
            className={`phase ${phase.status}`}
            title={`${descriptor?.description ?? ""}${phase.detail ? `\n\n${phase.detail}` : ""}`}
          >
            <span className="dot" aria-hidden="true" />
            <span>{descriptor?.label ?? phase.id}</span>
            {/* A text label beside the colour, so status never depends on hue
                alone — for colour-vision differences and for a projector that
                washes the palette out. */}
            <span className="muted" style={{ fontSize: 10.5 }}>
              {statusWord}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** The phase currently running, for the run header. Null when nothing is in flight. */
export function currentPhaseLabel(phases: PhaseSnapshot[]): string | null {
  const running = phases.find((p) => p.status === "running");
  if (!running) return null;
  return PHASES.find((p) => p.id === running.id)?.label ?? running.id;
}
