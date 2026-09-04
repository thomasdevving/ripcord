/**
 * Turns Mobula's remote logo URLs into inline `data:` URIs at FETCH time.
 *
 * A rendered Ripcord page is a pure function of data already gathered and must
 * not reach the network when someone opens it — verify-pages.mjs rejects any
 * remote `src`, stylesheet, script or `fetch(`. Hotlinking a third-party CDN
 * would break that for decoration and leak every page view to that CDN.
 *
 * So the image is fetched once, here, and embedded. Anything going wrong —
 * timeout, 404, oversized file, a non-image content type — yields `null` and the
 * renderer falls back to a text monogram: a missing logo is cosmetic, a page
 * that phones home is not.
 */

/** Above this, the logo is dropped rather than inlined — pages stay small and diffable. */
const MAX_LOGO_BYTES = 24_000;
const LOGO_TIMEOUT_MS = 10_000;

const ALLOWED_TYPES = new Set(["image/webp", "image/png", "image/jpeg", "image/svg+xml", "image/gif"]);

export async function inlineLogo(url: string | null): Promise<string | null> {
  if (!url || !/^https:\/\//i.test(url)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOGO_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const type = ((res.headers.get("content-type") ?? "").split(";")[0] ?? "").trim().toLowerCase();
    if (!ALLOWED_TYPES.has(type)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > MAX_LOGO_BYTES) return null;
    return `data:${type};base64,${buf.toString("base64")}`;
  } catch {
    // Deliberately silent, and the one place in this project where that is
    // right: this is a decorative asset, the failure has no reading as a fact
    // about the contract, and the caller's fallback is already correct.
    return null;
  } finally {
    clearTimeout(timer);
  }
}
