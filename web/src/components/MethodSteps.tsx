/**
 * The six stages of a run, with the one under the pointer marked.
 *
 * WHY ANY INTERACTION HERE: the list is genuinely a SEQUENCE — each stage
 * consumes what the one before it established, and the last two cannot run
 * without the addresses the first three resolved. Marking the stage a reader is
 * on lets them hold their place in six dense paragraphs without the page
 * asserting anything.
 *
 * TWO RULES, and the first is the one that keeps it honest:
 *
 *  1. EMPHASIS, NEVER REVEAL. Every stage is fully readable at all times.
 *     Nothing is hidden until it is pointed at, so the section is identical
 *     with JavaScript broken or a pointer absent. An interface that hides
 *     content behind an interaction has made that interaction load-bearing.
 *  2. IT FOLLOWS THE READER, IT DOES NOT MOVE ON ITS OWN. Nothing here starts
 *     by itself, which is what keeps a marker travelling down a list of stages
 *     from reading as work in progress — that is exactly what the analysis
 *     screen shows while a real run is happening. The accent marks where the
 *     pointer is and nothing about a result.
 *
 * A TIMED WALK OF ALL SIX WAS BUILT AND REMOVED. It worked, and it was one
 * more thing moving on a page whose job is to be read. What survives is the
 * part that answers to the reader.
 */
import { useState } from "react";
import type { ReactElement } from "react";

export function MethodSteps({ steps }: { steps: { title: string; text: string }[] }): ReactElement {
  const [active, setActive] = useState(-1);

  return (
    <ol className="steps walkable">
      {steps.map((step, i) => (
        <li
          className={`step${i === active ? " active" : ""}`}
          key={step.title}
          onPointerEnter={() => setActive(i)}
          onPointerLeave={() => setActive(-1)}
          onFocus={() => setActive(i)}
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
  );
}
