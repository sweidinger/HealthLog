/**
 * OAuth bridge configuration — origin + canonical resource resolution.
 *
 * The MCP authorization surface is a minimal in-repo Authorization Server that
 * BRIDGES onto HealthLog's existing `hlk_` Bearer model (ADR-006) — it keeps no
 * parallel identity store. Every metadata document, redirect-URI match, and
 * audience check is anchored to ONE canonical origin so a token minted for this
 * deployment can never be replayed against another (RFC 8707 audience binding).
 *
 * Origin precedence mirrors the passkey RP-origin / invite-URL resolution: the
 * operator-configured `APP_URL` / `NEXT_PUBLIC_APP_URL` win over the request
 * origin (which may be an internal hostname behind the reverse proxy). The
 * canonical resource identifier is the `/mcp` endpoint exactly — the same URL a
 * user pastes into Claude.ai / ChatGPT — so the Protected Resource Metadata
 * `resource` value matches the user-entered URL (a Claude.ai requirement).
 */

/**
 * Thrown when the MCP/OAuth surface is asked to resolve its canonical origin but
 * neither `APP_URL` nor `NEXT_PUBLIC_APP_URL` is configured. The surface fails
 * closed in that case (M1): without an operator-pinned origin the issuer,
 * endpoint URLs, and RFC 8707 audience would be derived from the attacker-
 * influenceable `Host` header, so we refuse to serve rather than trust it.
 */
export class McpOriginNotConfiguredError extends Error {
  constructor() {
    super(
      "APP_URL (or NEXT_PUBLIC_APP_URL) must be set to serve the MCP/OAuth surface",
    );
    this.name = "McpOriginNotConfiguredError";
  }
}

/** The operator-configured origin, env-only — `Host` is never trusted. */
function configuredOrigin(): string | null {
  for (const value of [process.env.APP_URL, process.env.NEXT_PUBLIC_APP_URL]) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    try {
      return new URL(trimmed).origin;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** Whether the operator has pinned a canonical origin (M1 fail-closed gate). */
export function isMcpOriginConfigured(): boolean {
  return configuredOrigin() !== null;
}

/**
 * Resolve the public origin of this deployment, e.g. `https://health.example`.
 *
 * Operator config (`APP_URL` → `NEXT_PUBLIC_APP_URL`) is authoritative. The
 * request URL is a last resort retained ONLY for non-security-bearing callers;
 * every MCP/OAuth entry point first asserts `isMcpOriginConfigured()` and fails
 * closed (M1), so on those paths the env value is always what is returned and
 * the `Host`-derived fallback is never reached.
 */
export function resolveBaseOrigin(requestUrl?: string): string {
  const candidates = [
    process.env.APP_URL,
    process.env.NEXT_PUBLIC_APP_URL,
    requestUrl,
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    try {
      return new URL(candidate).origin;
    } catch {
      // try the next candidate
    }
  }
  return "http://localhost:3000";
}

/**
 * Like `resolveBaseOrigin` but fails closed: throws `McpOriginNotConfiguredError`
 * when no operator origin is set. Every MCP/OAuth surface calls this so a
 * missing `APP_URL` refuses service instead of trusting the `Host` header (M1).
 */
export function requireBaseOrigin(): string {
  const origin = configuredOrigin();
  if (!origin) throw new McpOriginNotConfiguredError();
  return origin;
}

/**
 * The canonical MCP resource identifier (RFC 8707 audience). This is the value
 * the AS binds every issued token to and the value a client MUST send as
 * `resource=` — any other value is rejected.
 */
export function canonicalResource(requestUrl?: string): string {
  return `${resolveBaseOrigin(requestUrl)}/mcp`;
}

/**
 * Whether a client-supplied `resource` value matches our canonical resource.
 * Trailing slashes are tolerated (`/mcp` vs `/mcp/`) but the origin + path must
 * otherwise be exact — no substring / prefix matching that could admit a
 * look-alike host (RFC 8707, R-SEC-5).
 */
export function audienceMatches(
  resource: string | null | undefined,
  requestUrl?: string,
): boolean {
  if (!resource) return false;
  const want = canonicalResource(requestUrl).replace(/\/+$/, "");
  const got = resource.trim().replace(/\/+$/, "");
  return want === got;
}

/** The single scope the read MCP surface issues. */
export const SCOPE_HEALTH_READ = "health:read";

/**
 * Scopes the AS advertises + will issue. `health:write` is advertised so a
 * future incremental-consent (SEP-835) challenge can request it, but the read
 * surface only ever issues `health:read`. `offline_access` enables refresh
 * tokens (OAuth 2.1 public-client rotation) — Claude appends it when advertised.
 */
export const SUPPORTED_SCOPES = [
  SCOPE_HEALTH_READ,
  "health:write",
  "offline_access",
] as const;

/** Access-token lifetime (minutes). Short-lived; refresh tokens carry continuity. */
export const ACCESS_TOKEN_TTL_MINUTES = 60;

/** Refresh-token lifetime (days). */
export const REFRESH_TOKEN_TTL_DAYS = 30;

/** Authorization-code lifetime (seconds). Single-redemption, short window. */
export const AUTH_CODE_TTL_SECONDS = 120;
