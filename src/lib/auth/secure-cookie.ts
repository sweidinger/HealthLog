/**
 * Should the `Secure` flag be set on session-class cookies?
 *
 * Default — the flag is on whenever `NODE_ENV === "production"`, which
 * is the safe choice for any deployment terminated by HTTPS (the
 * documented self-hosting path: Caddy / Traefik / Nginx in front).
 *
 * Opt-out — operators running plain HTTP on a LAN or private VPN can
 * set `SESSION_COOKIE_SECURE=false` to drop the flag. Without the flag
 * a browser will send the cookie back over HTTP, so login round-trips
 * complete on `http://10.x.x.x:3000` and friends. This is intentional
 * for evaluation, NAS / homelab deployments, and Tailscale-only
 * surfaces; it is NOT appropriate for a deployment that ever serves
 * plain HTTP to the open internet, because the session cookie then
 * crosses the wire in cleartext.
 *
 * Opt-in — `SESSION_COOKIE_SECURE=true` forces the flag on even under
 * `NODE_ENV !== "production"`, useful when a developer fronts their
 * `pnpm dev` server with HTTPS for testing the production cookie path.
 *
 * The function is intentionally stateless / re-evaluated per call so a
 * runtime env change (e.g. via `compose.yml` edit + `docker compose up
 * -d`) takes effect on the next request without an app restart.
 */
export function shouldEmitSecureCookie(): boolean {
  const override = process.env.SESSION_COOKIE_SECURE?.trim().toLowerCase();
  if (override === "false") return false;
  if (override === "true") return true;
  return process.env.NODE_ENV === "production";
}

/**
 * One-line diagnostic for the single most common self-host login-loop cause:
 * the app is about to set a `Secure` session cookie
 * (`shouldEmitSecureCookie() === true`) while the request itself arrived over
 * plain HTTP. The browser silently drops a `Secure` cookie on an `http://`
 * origin, so the next request is unauthenticated and the user bounces back to
 * the login page with no error at all — it reads like a wrong password forever.
 *
 * Returns a human-readable message when the mismatch is detected, else `null`.
 * The caller logs it at login time (`console.warn` survives the prod
 * `console.*` strip) so an operator sees WHY login loops without having to find
 * the note buried in three docs. Non-fatal: the login still completes; the
 * cookie just won't stick until `SESSION_COOKIE_SECURE=false` is set (or TLS is
 * fronted).
 *
 * A request counts as HTTPS when `x-forwarded-proto` names https (the shape
 * every documented TLS reverse proxy sets) OR the request URL is already
 * https. A proxy that terminates TLS but omits `x-forwarded-proto` can produce
 * a benign false positive — the message names that case so it stays actionable
 * either way.
 */
export function detectInsecureCookieTransport(req: {
  headers: Headers;
  url: string;
}): string | null {
  if (!shouldEmitSecureCookie()) return null;

  // `x-forwarded-proto` can be a comma-separated proto chain; the left-most
  // entry is the client-facing scheme the browser actually spoke.
  const clientProto = req.headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim()
    .toLowerCase();
  if (clientProto === "https") return null;

  let urlIsHttps = false;
  try {
    urlIsHttps = new URL(req.url).protocol === "https:";
  } catch {
    urlIsHttps = false;
  }
  if (urlIsHttps) return null;

  return (
    "This request arrived over plain HTTP but the session cookie is being " +
    "issued with the `Secure` flag — the browser will drop it and login will " +
    "loop back to the sign-in page with no error message. If you serve HTTP " +
    "directly (LAN / NAS / Tailscale, no TLS reverse proxy), set " +
    "SESSION_COOKIE_SECURE=false. If a reverse proxy terminates TLS in front " +
    "of this container, make sure it forwards `X-Forwarded-Proto: https`."
  );
}
