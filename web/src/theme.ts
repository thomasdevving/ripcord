/**
 * Theme selection, held on <html data-theme> and in localStorage.
 *
 * DARK IS THE DEFAULT, AND NOT BY POLLING THE OS. `prefers-color-scheme` is
 * deliberately not consulted: this app is shown on projectors and on other
 * people's laptops, and an interface that appears in a different palette
 * depending on the machine it is opened from is a worse demo than one that
 * always looks the same. Light is available because reading a long report in a
 * bright room is a real need, and because the printed report has been light all
 * along — it is a reader's choice, so it is stored as one.
 *
 * The stylesheet does the rest: every colour in the app resolves through the
 * token block, so switching themes touches no component.
 */
export type Theme = "dark" | "light";

const STORAGE_KEY = "ripcord.theme";

/**
 * Reading localStorage THROWS in some browser configurations (Safari's private
 * mode historically, and anything set to block site data) rather than returning
 * null. A theme preference is not worth taking the app down for, so a failure
 * falls back to the default — the same direction every other optional read in
 * this project takes.
 */
export function readTheme(): Theme {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // The theme still applies for this session; only its persistence is lost.
  }
}
