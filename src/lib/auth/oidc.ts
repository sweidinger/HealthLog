/**
 * OpenID Connect (OIDC) relying-party login. A single, env-configured
 * provider (Authentik / Keycloak / Authelia / Google Workspace / etc.) — no
 * per-provider database table, matching the Polar/Oura/Strava "shared app
 * from env" convention. Discovery, PKCE, and token exchange are hand-rolled
 * over `safeFetch` (same convention as the Codex OAuth client and the MCP
 * OAuth server) rather than pulling in a full OAuth/OIDC framework; `jose`
 * is used only for JWKS fetch + ID-token signature/claims verification,
 * which is not worth hand-rolling.
 */
import { createRemoteJWKSet, jwtVerify } from "jose";
import { safeFetch } from "@/lib/safe-fetch";
import { sanitizeSameOriginPath } from "@/lib/url-safety";

export interface OidcConfig {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  buttonLabel: string;
}

/** `||`, not `??`: the compose whitelist materialises an unset var as `""`. */
function envOrEmpty(name: string): string {
  return process.env[name] || "";
}

export function isOidcConfigured(): boolean {
  return Boolean(
    envOrEmpty("OIDC_ISSUER_URL") &&
    envOrEmpty("OIDC_CLIENT_ID") &&
    envOrEmpty("OIDC_CLIENT_SECRET"),
  );
}

/**
 * `OIDC_ONLY` only takes effect when the provider is actually fully
 * configured — a truthy flag with a half-set (or unset) provider group
 * must never lock every user out of the app, so it silently falls back to
 * "additive" rather than hiding password/passkey login.
 *
 * Enforced server-side on every password/passkey auth route (`/api/auth/
 * login`, `/api/auth/register`, `/api/auth/passkey/{login-options,
 * login-verify}`) — the login page hiding those buttons is not the
 * boundary. There is currently no OIDC-compatible login flow for the
 * native iOS client (it authenticates via password/passkey only, see
 * `src/lib/auth/native-client.ts`), so turning this on locks the iOS app
 * out of authentication entirely until a native SSO flow exists. Documented
 * in `.env.production.example`; check before recommending this to an
 * operator running the iOS app.
 */
export function isOidcOnly(): boolean {
  return isOidcConfigured() && envOrEmpty("OIDC_ONLY").toLowerCase() === "true";
}

export function getOidcConfig(): OidcConfig | null {
  if (!isOidcConfigured()) return null;
  return {
    issuerUrl: envOrEmpty("OIDC_ISSUER_URL").replace(/\/+$/, ""),
    clientId: envOrEmpty("OIDC_CLIENT_ID"),
    clientSecret: envOrEmpty("OIDC_CLIENT_SECRET"),
    scopes: envOrEmpty("OIDC_SCOPES") || "openid email profile",
    buttonLabel: envOrEmpty("OIDC_BUTTON_LABEL") || "Single Sign-On",
  };
}

export function getOidcRedirectUri(): string {
  return `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/oidc/callback`;
}

/**
 * Resolve a caller-supplied post-login `next` path against the request's own
 * origin and only accept it if it stays there — see
 * `sanitizeSameOriginPath` for why a plain `startsWith` check isn't enough.
 */
export function sanitizeOidcNextPath(
  next: string | null,
  requestUrl: string,
): string {
  return sanitizeSameOriginPath(next, requestUrl);
}

export interface OidcMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
}

interface MetadataCacheEntry {
  metadata: OidcMetadata;
  fetchedAt: number;
}

const METADATA_TTL_MS = 10 * 60 * 1000;
let metadataCache: MetadataCacheEntry | null = null;
let metadataInFlight: Promise<OidcMetadata> | null = null;
let jwksCache: {
  issuerUrl: string;
  jwks: ReturnType<typeof createRemoteJWKSet>;
} | null = null;

export function _resetOidcCacheForTests(): void {
  metadataCache = null;
  metadataInFlight = null;
  jwksCache = null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Fetch + validate the provider's `.well-known/openid-configuration`.
 * Module-level cached (10 min TTL) with in-flight de-dup so concurrent
 * logins don't stampede the discovery endpoint. The doc's own `issuer`
 * claim must match the configured issuer URL (RFC 8414 §3.3) — a
 * mismatch means the provider is misconfigured or something is spoofing
 * the discovery response.
 */
export async function discoverOidcMetadata(
  config: OidcConfig,
): Promise<OidcMetadata> {
  const now = Date.now();
  if (metadataCache && now - metadataCache.fetchedAt < METADATA_TTL_MS) {
    return metadataCache.metadata;
  }
  if (metadataInFlight) return metadataInFlight;

  metadataInFlight = (async () => {
    try {
      const res = await safeFetch(
        `${config.issuerUrl}/.well-known/openid-configuration`,
        { method: "GET", headers: { Accept: "application/json" } },
      );
      if (!res.ok) {
        throw new Error(`discovery request failed: ${res.status}`);
      }
      const json: unknown = await res.json();
      if (
        !isRecord(json) ||
        typeof json.issuer !== "string" ||
        typeof json.authorization_endpoint !== "string" ||
        typeof json.token_endpoint !== "string" ||
        typeof json.jwks_uri !== "string"
      ) {
        throw new Error("discovery document missing required fields");
      }
      if (json.issuer !== config.issuerUrl) {
        throw new Error(
          `discovery issuer mismatch: expected ${config.issuerUrl}, got ${json.issuer}`,
        );
      }
      const metadata: OidcMetadata = {
        issuer: json.issuer,
        authorization_endpoint: json.authorization_endpoint,
        token_endpoint: json.token_endpoint,
        jwks_uri: json.jwks_uri,
        userinfo_endpoint:
          typeof json.userinfo_endpoint === "string"
            ? json.userinfo_endpoint
            : undefined,
      };
      metadataCache = { metadata, fetchedAt: Date.now() };
      return metadata;
    } finally {
      metadataInFlight = null;
    }
  })();

  return metadataInFlight;
}

function getJwks(metadata: OidcMetadata) {
  if (jwksCache && jwksCache.issuerUrl === metadata.issuer) {
    return jwksCache.jwks;
  }
  // `jose`'s own fetch to the trusted, discovery-supplied `jwks_uri` is a
  // deliberate, scoped exception to the safe-fetch-required convention —
  // the target host comes from the operator-configured issuer, never from
  // user input, and the ESLint rule only lints project source, not
  // library internals.
  const jwks = createRemoteJWKSet(new URL(metadata.jwks_uri));
  jwksCache = { issuerUrl: metadata.issuer, jwks };
  return jwks;
}

export function buildAuthorizationUrl(params: {
  metadata: OidcMetadata;
  config: OidcConfig;
  state: string;
  nonce: string;
  codeChallenge: string;
  redirectUri: string;
}): string {
  const url = new URL(params.metadata.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: params.config.clientId,
    redirect_uri: params.redirectUri,
    scope: params.config.scopes,
    state: params.state,
    nonce: params.nonce,
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

interface OidcTokenResponse {
  id_token?: string;
  access_token?: string;
  token_type?: string;
  expires_in?: number;
}

export async function exchangeCodeForTokens(params: {
  metadata: OidcMetadata;
  config: OidcConfig;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<OidcTokenResponse> {
  const res = await safeFetch(params.metadata.token_endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.redirectUri,
      client_id: params.config.clientId,
      client_secret: params.config.clientSecret,
      code_verifier: params.codeVerifier,
    }).toString(),
  });
  if (!res.ok) {
    throw new Error(`token exchange failed: ${res.status}`);
  }
  const json: unknown = await res.json();
  if (!isRecord(json) || typeof json.id_token !== "string") {
    throw new Error("token response missing id_token");
  }
  return json as OidcTokenResponse;
}

export interface OidcIdentity {
  sub: string;
  email: string | null;
  emailVerified: boolean | undefined;
  name: string | null;
}

/**
 * Verify the ID token's signature (against the provider's live JWKS),
 * `iss`, `aud`, and `exp`, then confirm the `nonce` claim matches the one
 * minted at `/api/auth/oidc/login`. Signature verification matters even
 * though this token arrived over a direct back-channel HTTPS call to the
 * token endpoint (not a browser-relayed redirect) — it's still the
 * documented defense against a provider-side key-confusion attack.
 */
export async function verifyIdToken(params: {
  metadata: OidcMetadata;
  config: OidcConfig;
  idToken: string;
  nonce: string;
}): Promise<OidcIdentity> {
  const jwks = getJwks(params.metadata);
  const { payload } = await jwtVerify(params.idToken, jwks, {
    issuer: params.metadata.issuer,
    audience: params.config.clientId,
  });

  if (typeof payload.sub !== "string" || !payload.sub) {
    throw new Error("id token missing sub claim");
  }
  if (payload.nonce !== params.nonce) {
    throw new Error("id token nonce mismatch");
  }

  return {
    sub: payload.sub,
    email: typeof payload.email === "string" ? payload.email : null,
    emailVerified:
      typeof payload.email_verified === "boolean"
        ? payload.email_verified
        : undefined,
    name: typeof payload.name === "string" ? payload.name : null,
  };
}

/**
 * Fallback for providers that omit `email` from the ID token's granted
 * scopes but expose it via userinfo. Best-effort: any failure here just
 * leaves the identity's email null and the caller rejects the login.
 */
export async function fetchUserinfoEmail(params: {
  metadata: OidcMetadata;
  accessToken: string;
}): Promise<{ email: string | null; emailVerified: boolean | undefined }> {
  if (!params.metadata.userinfo_endpoint) {
    return { email: null, emailVerified: undefined };
  }
  try {
    const res = await safeFetch(params.metadata.userinfo_endpoint, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) return { email: null, emailVerified: undefined };
    const json: unknown = await res.json();
    if (!isRecord(json)) return { email: null, emailVerified: undefined };
    return {
      email: typeof json.email === "string" ? json.email : null,
      emailVerified:
        typeof json.email_verified === "boolean"
          ? json.email_verified
          : undefined,
    };
  } catch {
    return { email: null, emailVerified: undefined };
  }
}

/**
 * Derive a `registerSchema`-valid username (`^[a-zA-Z0-9_-]+$`, 3-30 chars)
 * from an auto-provisioned SSO account's email local-part, de-duped via the
 * caller-supplied existence check. DB-free and pure so it's unit-testable
 * without a Prisma mock; the callback route supplies `exists` bound to
 * `prisma.user.findUnique`.
 */
export async function deriveUniqueUsername(
  email: string,
  exists: (candidate: string) => Promise<boolean>,
): Promise<string> {
  const localPart = email.split("@")[0] ?? "user";
  let base = localPart.replace(/[^a-zA-Z0-9_-]/g, "");
  if (base.length < 3) base = `${base}user`.slice(0, 3).padEnd(3, "0");
  base = base.slice(0, 26); // leave room for a numeric suffix up to 30 chars

  let candidate = base;
  let suffix = 0;
  while (await exists(candidate)) {
    suffix += 1;
    candidate = `${base}${suffix}`;
  }
  return candidate;
}
