/**
 * A short explanation attached to a label, shown on hover, on keyboard focus,
 * and on tap.
 *
 * TWO MECHANISMS HAVE ALREADY FAILED HERE, which is why this one is explicit.
 * The first was the native `title` attribute: it looks like the right tool and
 * is not — a browser-controlled delay of a second or more, unreachable by
 * keyboard, absent on touch, unstyleable. The second was a pure CSS
 * `:hover > .bubble` rule; the stylesheet was correct and the bubble still did
 * not appear reliably on a pointer, so the behaviour is now OWNED BY THIS
 * COMPONENT rather than inferred from a cascade I cannot observe failing.
 *
 * Opening is therefore a state change with four triggers — pointer enter,
 * focus, click (which is what a touch device sends), and nothing else — and
 * closing is pointer leave, blur, or Escape. A hint nobody can open is the same
 * as no hint, and these carry the qualification that stops a label being
 * misread.
 *
 * THE EXPLANATION IS NEVER ONLY HERE. A tooltip is a convenience, not a home
 * for something a reader must not miss: the group glosses are repeated in "How
 * to read this list", and the asset states in the legend above the table.
 *
 * `aria-describedby` rather than `aria-label`, so a screen reader announces the
 * label AND its explanation instead of replacing one with the other.
 */
import { useId, useState } from "react";
import type { ReactElement } from "react";

export function WhyHint({ text, label = "Why?" }: { text: string; label?: string }): ReactElement {
  const id = useId();
  const [open, setOpen] = useState(false);

  return (
    <span
      className={`why-hint${open ? " open" : ""}`}
      tabIndex={0}
      role="note"
      aria-describedby={id}
      aria-expanded={open}
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      // A tap sends no pointerenter that survives, and a click on an already
      // open hint should close it again.
      onClick={() => setOpen((v) => !v)}
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
        // A note is not a button, but it is focusable, so the keys that read as
        // "activate" should do what a click does.
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          setOpen((v) => !v);
        }
      }}
    >
      {label}
      <span className="why-bubble" id={id} role="tooltip">
        {text}
      </span>
    </span>
  );
}
