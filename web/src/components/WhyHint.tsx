/**
 * A short explanation attached to a label, shown on hover and on keyboard
 * focus.
 *
 * IT IS NOT `title`. The first version used the native attribute, which looks
 * like the right tool and is not: it appears after a browser-controlled delay
 * of a second or more, it cannot be reached by keyboard at all, it does not
 * exist on touch, and it is unstyleable — so the explanation was, in practice,
 * invisible. A hint nobody sees is the same as no hint, and these hints carry
 * the qualification that stops a label being misread.
 *
 * THE EXPLANATION IS ALSO ALWAYS AVAILABLE UNFOLDED SOMEWHERE ELSE. A tooltip
 * is a convenience, never the only home for something a reader must not miss —
 * the group glosses are repeated in "How to read this list", and the asset
 * states in the legend above the table.
 *
 * `aria-describedby` rather than `aria-label`, so a screen reader announces the
 * label AND its explanation instead of replacing one with the other.
 */
import { useId } from "react";
import type { ReactElement } from "react";

export function WhyHint({ text, label = "Why?" }: { text: string; label?: string }): ReactElement {
  const id = useId();
  return (
    <span className="why-hint" tabIndex={0} role="note" aria-describedby={id}>
      {label}
      <span className="why-bubble" id={id} role="tooltip">
        {text}
      </span>
    </span>
  );
}
