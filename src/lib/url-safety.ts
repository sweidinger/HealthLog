/**
 * Isomorphic (client + server) — no `node:crypto`/`jose`/server-only imports,
 * so client components can pull this in without dragging server auth code
 * into the browser bundle.
 */

/**
 * Resolve a caller-supplied "redirect back to" path against a base URL and
 * only accept it if it stays on that origin. A plain `startsWith("/") &&
 * !startsWith("//")` string check is not enough — WHATWG URL parsing treats
 * a leading backslash as a path separator for special schemes, so a value
 * like `/\evil.com` passes that check but resolves off-origin (confirmed:
 * `router.push()` on such a value drives Next.js's client router into a
 * real cross-origin `location.assign()`, not just client-side History
 * state). Resolving through `new URL()` first and comparing the real
 * origin closes that class of bypass instead of pattern-matching the raw
 * string.
 */
export function sanitizeSameOriginPath(
  next: string | null | undefined,
  baseUrl: string,
): string {
  if (!next) return "/";
  try {
    const base = new URL(baseUrl);
    const resolved = new URL(next, baseUrl);
    if (resolved.origin !== base.origin) return "/";
    const result = `${resolved.pathname}${resolved.search}${resolved.hash}`;
    // Consumers commonly RE-RESOLVE the returned value against the origin
    // (`new URL(result, base)` in the OIDC callback redirect, `router.push()`
    // on the login page). A same-origin `next` can still leave a pathname
    // like `//evil.com` — e.g. `/..//evil.com` resolves on-origin here (the
    // `..` collapses at root) yet its pathname is protocol-relative, so the
    // re-resolve escapes to `https://evil.com`. Re-verify that the
    // reconstructed path itself still resolves on-origin; reject otherwise.
    if (new URL(result, base).origin !== base.origin) return "/";
    return result;
  } catch {
    return "/";
  }
}
