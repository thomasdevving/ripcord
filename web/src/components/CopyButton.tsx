import { useState } from "react";
import type { ReactElement } from "react";

/**
 * Copy-to-clipboard with a visible confirmation. The confirmation is not
 * decoration: addresses here are 42 characters and visually similar, so "did
 * that work?" is a real question, and re-clicking a silent button is how someone
 * ends up pasting the wrong address.
 *
 * `navigator.clipboard` is unavailable on insecure origins and can be denied by
 * policy; the failure is reported in the button's own label rather than
 * swallowed, so the address stays selectable as the fallback.
 */
export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }): ReactElement {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  return (
    <button
      type="button"
      className="copy-btn"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setState("copied");
        } catch {
          setState("failed");
        }
        setTimeout(() => setState("idle"), 1800);
      }}
    >
      {state === "copied" ? "Copied" : state === "failed" ? "Copy blocked — select it manually" : label}
    </button>
  );
}
