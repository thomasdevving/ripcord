/**
 * The six stages of a run, walked in the order they execute.
 *
 * WHY ANY MOTION HERE AT ALL: the list is genuinely a SEQUENCE — each stage
 * consumes what the one before it established, and the last two cannot run
 * without the addresses the first three resolved. A static list says six things
 * happen; walking it says they happen in an order that matters, which is the
 * one thing the prose has to keep asserting.
 *
 * THREE RULES, and the first is the one that keeps this honest:
 *
 *  1. IT IS EMPHASIS, NEVER REVEAL. Every stage is fully readable before,
 *     during and after the walk. Nothing is hidden until it animates, so the
 *     page works identically with JavaScript broken, motion disabled, or the
 *     walk never started. An interface that hides content behind an animation
 *     has made the animation load-bearing.
 *  2. IT MUST NOT LOOK LIKE A RUN. This is a landing page, and a marker
 *     travelling down a list of stages is exactly what the real analysis screen
 *     shows while work is happening. So it says so in words, and it borrows
 *     none of the status colours — no green "finished" pips, no phase chips.
 *     The accent marks POSITION IN A SEQUENCE, nothing about a result.
 *  3. IT STOPS, AND IT IS ASKED FOR. One pass, started by a control, and then
 *     it is over. A perpetual loop beside a body of text is a distraction that
 *     never ends; motion that starts on its own is one a reader did not choose.
 *
 * AN AUTOMATIC START WAS BUILT AND REMOVED, and the reason is worth recording:
 * two triggers were tried — IntersectionObserver, then a plain geometry check
 * on scroll — and neither could be demonstrated firing in the browser
 * available here. Shipping a trigger I could not show working would have put a
 * dead feature on the page that reads as working code, which is precisely the
 * failure this project spends its time hunting. The pass is therefore driven
 * by a button, whose behaviour is obvious and testable, and the pointer
 * interaction below works whether or not anyone presses it.
 *
 * Reduced motion is respected the strong way: no walk, no transitions, and the
 * control is not offered at all. Hovering or focusing a stage still marks it,
 * because that is a pointer following a reader's own attention rather than
 * motion imposed on them.
 */
import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";

const STEP_MS = 1500;

export function MethodSteps({ steps }: { steps: { title: string; text: string }[] }): ReactElement {
  // -1 is "not walking", which is also the resting state after a pass. It is
  // deliberately not 0: a first stage left permanently marked would read as a
  // run stuck on its first phase.
  const [active, setActive] = useState(-1);
  // Only labels the control: "Walk the sequence" the first time, "again" after.
  const [walked, setWalked] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const reduced = () =>
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const stop = () => {
    if (timer.current !== undefined) {
      window.clearInterval(timer.current);
      timer.current = undefined;
    }
  };

  const walk = () => {
    if (reduced()) return;
    stop();
    setActive(0);
    let i = 0;
    timer.current = window.setInterval(() => {
      i += 1;
      if (i >= steps.length) {
        stop();
        setActive(-1);
        setWalked(true);
        return;
      }
      setActive(i);
    }, STEP_MS);
  };

  useEffect(() => stop, []);

  return (
    <div className="method-steps">
      <ol className="steps walkable">
        {steps.map((step, i) => (
          <li
            className={`step${i === active ? " active" : ""}`}
            key={step.title}
            // A pointer or a keyboard following the reader's own attention
            // marks a stage; it also ends the walk, because two things moving
            // at once is worse than either.
            onPointerEnter={() => {
              stop();
              setActive(i);
            }}
            onPointerLeave={() => setActive(-1)}
            onFocus={() => {
              stop();
              setActive(i);
            }}
            onBlur={() => setActive(-1)}
            tabIndex={0}
          >
            <span className="step-n" aria-hidden="true">{String(i + 1).padStart(2, "0")}</span>
            <div className="step-body">
              <h4 className="step-title">{step.title}</h4>
              <p className="step-text">{step.text}</p>
            </div>
          </li>
        ))}
      </ol>

      {/* The control, and the sentence that stops the movement being mistaken
          for a live run. Both are hidden under reduced motion, where neither
          applies. */}
      <p className="method-note reduced-hide">
        <button type="button" className="link small" onClick={walk}>
          {walked ? "Walk it again" : "Walk the sequence"}
        </button>
        <span>An illustration of the order — no analysis is running.</span>
      </p>
    </div>
  );
}
