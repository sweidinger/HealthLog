/**
 * v1.12.2 — `return_scheme` validation for the WHOOP connect-in-app flow.
 *
 * The native client may pass `?return_scheme=<custom-scheme>` to
 * `GET /api/whoop/connect`. When a VALID scheme is supplied, the callback's
 * FINAL redirect targets `<scheme>://whoop?whoop=connected|error&reason=…`
 * instead of the web settings URL, so `ASWebAuthenticationSession`
 * auto-completes on its `callbackURLScheme` match. An invalid/absent scheme
 * falls back to the existing web redirect — this helper NEVER throws and never
 * reflects an arbitrary attacker-supplied scheme.
 *
 * Security: a custom app scheme only. We pin to a small allowlist (easy to
 * extend) AND require the strict RFC-3986 scheme shape, with the dangerous
 * web/script schemes explicitly rejected as defence-in-depth so a future
 * allowlist edit can't accidentally admit `javascript:`/`data:`/etc.
 */

/**
 * RFC 3986 scheme grammar: ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ).
 * Lower-cased before the test so the comparison is case-insensitive in effect.
 */
const SCHEME_PATTERN = /^[a-z][a-z0-9.+-]*$/;

/**
 * Schemes that must never be honoured even if some future edit widens the
 * allowlist. `http`/`https` would turn the redirect into an open-redirect to
 * an arbitrary web origin; the rest are classic XSS / local-resource vectors.
 */
const FORBIDDEN_SCHEMES: ReadonlySet<string> = new Set([
  "http",
  "https",
  "javascript",
  "data",
  "file",
  "vbscript",
]);

/**
 * Allowlist of custom app schemes we honour. Keep this small and explicit;
 * add the exact scheme string a self-host / TestFlight build advertises as its
 * `ASWebAuthenticationSession` `callbackURLScheme`.
 */
const ALLOWED_SCHEMES: ReadonlySet<string> = new Set([
  // The native HealthLog client's advertised custom scheme.
  "dev.healthlog.app",
]);

/**
 * Validate a raw `return_scheme` query value. Returns the normalised
 * (lower-cased) scheme when it passes every gate, or `null` for absent /
 * malformed / forbidden / non-allowlisted input. Callers treat `null` as
 * "use the web redirect".
 */
export function validateReturnScheme(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  // A leading-byte length cap keeps a pathological value out of the DB column
  // and any downstream URL; real custom schemes are short.
  if (raw.length > 64) return null;

  const scheme = raw.toLowerCase();
  if (!SCHEME_PATTERN.test(scheme)) return null;
  if (FORBIDDEN_SCHEMES.has(scheme)) return null;
  if (!ALLOWED_SCHEMES.has(scheme)) return null;

  return scheme;
}

/**
 * Build the native custom-scheme redirect target for the callback's FINAL
 * redirect. `scheme` MUST already be a validated allowlisted scheme (caller
 * passes the result of {@link validateReturnScheme}). Shape:
 *   `<scheme>://whoop?whoop=connected`
 *   `<scheme>://whoop?whoop=error&reason=<code>`
 */
export function buildReturnSchemeRedirect(
  scheme: string,
  outcome: "connected" | "error",
  reason?: string,
): string {
  const query =
    outcome === "error"
      ? `whoop=error&reason=${encodeURIComponent(reason ?? "unknown")}`
      : "whoop=connected";
  return `${scheme}://whoop?${query}`;
}
