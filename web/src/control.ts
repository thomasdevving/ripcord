/**
 * Control tokens, held in this browser only.
 *
 * A job id travels in a shareable URL. The control token does not: it is the
 * capability to cancel, returned exactly once to whoever started the run, and
 * only its hash is stored server-side. Anyone who is handed an analysis link can
 * watch it; only the submitter can stop it.
 *
 * `sessionStorage` rather than `localStorage`, deliberately. The token is useful
 * for exactly as long as the job runs; keeping it past the tab's life would
 * leave a credential lying around for a job that has long since finished, for no
 * benefit. Every access is wrapped, because storage throws outright in some
 * contexts (private windows, blocked site data) and a cancel button is not worth
 * taking the page down for.
 */
const KEY_PREFIX = "ripcord.control.";

export function rememberControlToken(jobId: string, token: string): void {
  if (!token) return;
  try {
    sessionStorage.setItem(KEY_PREFIX + jobId, token);
  } catch {
    // Storage unavailable. The consequence is a missing Cancel button, which is
    // strictly cosmetic — the job's own timeout still bounds it.
  }
}

export function readControlToken(jobId: string): string | null {
  try {
    return sessionStorage.getItem(KEY_PREFIX + jobId);
  } catch {
    return null;
  }
}

export function forgetControlToken(jobId: string): void {
  try {
    sessionStorage.removeItem(KEY_PREFIX + jobId);
  } catch {
    // As above.
  }
}
