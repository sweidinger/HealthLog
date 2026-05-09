import { createHash, randomBytes } from "node:crypto";
import { encrypt, decrypt } from "@/lib/crypto";

/**
 * Codex / ChatGPT-OAuth flow — mirrors the official `openai/codex` CLI
 * (`codex-rs/login/src/server.rs`).
 *
 * The previous v1.4.2-v1.4.6 implementation hit `chatgpt.com/authorize`
 * + `chatgpt.com/oauth/token`, which are NOT OAuth endpoints. ChatGPT
 * silently rendered its normal web-app and the flow dead-ended. The
 * canonical issuer is `auth.openai.com` for both authorize and token
 * exchange.
 *
 * Flow:
 *   1. PKCE authorize → user consents at auth.openai.com
 *   2. Token exchange → returns `{ id_token, access_token, refresh_token }`
 *   3. **API-key exchange** (token-exchange grant, RFC 8693) → trades
 *      the `id_token` for a regular OpenAI API key that bills against
 *      the user's ChatGPT subscription.
 *   4. HealthLog stores the API key (encrypted) and uses it via the
 *      standard OpenAIClient against `https://api.openai.com/v1`.
 *      Refresh tokens are stored too so the API key can be re-issued
 *      when it ages out — the refresh token is the long-lived secret.
 */

const ISSUER = "https://auth.openai.com";

/**
 * Public PKCE client ID hardcoded in the official `openai/codex` CLI
 * (`codex-rs/login/src/auth/manager.rs`). Allows OPS to override via
 * env var if a private OAuth app is registered for this deployment.
 */
const DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

/**
 * Scopes the official Codex CLI requests. Without these the
 * `id_token` returned has no `chatgpt_subscription_active_until` claim
 * and the api-key exchange downstream rejects it.
 */
const CODEX_SCOPES =
  "openid profile email offline_access api.connectors.read api.connectors.invoke";

function base64url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

export function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(96));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function generateState(): string {
  return base64url(randomBytes(32));
}

/**
 * Backwards-compatible no-op type. Kept so any existing callers that
 * imported the error type don't break — the helpers below now always
 * return a value (the public Codex client ID is the safe default).
 */
export class CodexOAuthNotConfiguredError extends Error {
  constructor() {
    super(
      "Codex OAuth is not configured on this instance — set CODEX_OAUTH_CLIENT_ID",
    );
    this.name = "CodexOAuthNotConfiguredError";
  }
}

export function getCodexClientId(): string {
  return process.env.CODEX_OAUTH_CLIENT_ID?.trim() || DEFAULT_CLIENT_ID;
}

/**
 * Codex OAuth is always considered configured because we ship the
 * public Codex CLI client ID as a default. Operators can override via
 * env var if they have a private OAuth app registered with OpenAI.
 */
export function isCodexOAuthConfigured(): boolean {
  return true;
}

export function buildAuthorizationUrl(params: {
  codeChallenge: string;
  state: string;
  redirectUri: string;
}): string {
  const url = new URL(`${ISSUER}/oauth/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", getCodexClientId());
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", CODEX_SCOPES);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", params.state);
  // Required for the api-key exchange step to work — without these
  // claims the id_token cannot be traded for an OpenAI API key.
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  return url.toString();
}

interface RawTokenResponse {
  id_token: string;
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

async function postForm(
  endpoint: string,
  fields: Record<string, string>,
): Promise<Response> {
  const body = new URLSearchParams(fields).toString();
  return fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
}

export interface CodexTokens {
  /** OpenAI API key obtained via the token-exchange grant. */
  apiKey: string;
  /** OAuth refresh token; long-lived, re-issues fresh tokens. */
  refreshToken: string;
  /**
   * Wall-clock expiry of the API key. Once this passes we re-run the
   * refresh + api-key exchange before the next request.
   */
  expiresAt: Date;
}

export async function exchangeCodeForTokens(params: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<CodexTokens> {
  const res = await postForm(`${ISSUER}/oauth/token`, {
    grant_type: "authorization_code",
    client_id: getCodexClientId(),
    code: params.code,
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Codex token exchange failed (${res.status}): ${body}`);
  }
  const tokens = (await res.json()) as RawTokenResponse;
  const apiKey = await obtainApiKey(tokens.id_token);
  return {
    apiKey,
    refreshToken: tokens.refresh_token,
    expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
  };
}

export async function refreshTokens(
  refreshToken: string,
): Promise<CodexTokens> {
  const res = await postForm(`${ISSUER}/oauth/token`, {
    grant_type: "refresh_token",
    client_id: getCodexClientId(),
    refresh_token: refreshToken,
    // The same scopes must be requested on refresh, otherwise the
    // re-issued id_token loses the claims the api-key exchange needs.
    scope: CODEX_SCOPES,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Codex token refresh failed (${res.status}): ${body}`);
  }
  const tokens = (await res.json()) as RawTokenResponse;
  const apiKey = await obtainApiKey(tokens.id_token);
  return {
    apiKey,
    refreshToken: tokens.refresh_token ?? refreshToken,
    expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
  };
}

/**
 * Trade an OpenID `id_token` for an OpenAI API key via the OAuth
 * token-exchange grant (RFC 8693). The resulting key is special: it
 * bills against the user's ChatGPT subscription rather than a separate
 * API plan, which is the entire point of the Codex flow.
 */
export async function obtainApiKey(idToken: string): Promise<string> {
  const res = await postForm(`${ISSUER}/oauth/token`, {
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    client_id: getCodexClientId(),
    requested_token: "openai-api-key",
    subject_token: idToken,
    subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Codex api-key exchange failed (${res.status}): ${body}`);
  }
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) {
    throw new Error("Codex api-key exchange returned no access_token");
  }
  return json.access_token;
}

export function encryptCodexCreds(creds: {
  apiKey: string;
  refreshToken: string;
}): { apiKeyEncrypted: string; refreshEncrypted: string } {
  return {
    apiKeyEncrypted: encrypt(creds.apiKey),
    refreshEncrypted: encrypt(creds.refreshToken),
  };
}

export function decryptCodexCreds(encrypted: {
  apiKeyEncrypted: string;
  refreshEncrypted: string;
}): { apiKey: string; refreshToken: string } {
  return {
    apiKey: decrypt(encrypted.apiKeyEncrypted),
    refreshToken: decrypt(encrypted.refreshEncrypted),
  };
}

// ─── Device-code flow ────────────────────────────────────────────────
//
// For hosted apps (HealthLog), the standard authorization-code redirect
// flow does not work because OpenAI's Hydra only allow-lists localhost
// callbacks for the public Codex CLI client ID. The device-code flow is
// the documented escape hatch: the user goes to chatgpt.com on any
// device, enters a short code, and approves the connection — no
// redirect URI on our domain is involved at all.

const DEVICE_VERIFICATION_URL = `${ISSUER}/codex/device`;
const DEVICE_REDIRECT_URI = `${ISSUER}/deviceauth/callback`;

export interface DeviceCodeStart {
  /** Short user-facing code, e.g. "RGRP-N5F7U". */
  userCode: string;
  /** URL the user opens in their browser to approve. */
  verificationUrl: string;
  /** Opaque per-attempt id used for polling. Server-side only. */
  deviceAuthId: string;
  /** Polling interval in seconds. */
  intervalSeconds: number;
}

export async function requestDeviceCode(): Promise<DeviceCodeStart> {
  const res = await fetch(`${ISSUER}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: getCodexClientId() }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Codex device-code request failed (${res.status}): ${body}`,
    );
  }
  const json = (await res.json()) as {
    device_auth_id: string;
    user_code: string;
    interval: string | number;
  };
  return {
    userCode: json.user_code,
    verificationUrl: DEVICE_VERIFICATION_URL,
    deviceAuthId: json.device_auth_id,
    intervalSeconds:
      typeof json.interval === "string"
        ? Number(json.interval) || 5
        : json.interval || 5,
  };
}

export type DevicePollResult =
  | { status: "pending" }
  | { status: "connected"; tokens: CodexTokens };

/**
 * Single poll attempt against the device-auth token endpoint. Returns
 * "pending" while the user has not yet approved (Hydra answers with
 * 403/404), and "connected" with already-exchanged Codex tokens once
 * the user finishes the approval flow on chatgpt.com.
 */
export async function pollDeviceCode(params: {
  deviceAuthId: string;
  userCode: string;
}): Promise<DevicePollResult> {
  const res = await fetch(`${ISSUER}/api/accounts/deviceauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      device_auth_id: params.deviceAuthId,
      user_code: params.userCode,
    }),
  });

  if (res.status === 403 || res.status === 404) {
    return { status: "pending" };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Codex device-code poll failed (${res.status}): ${body}`);
  }

  const json = (await res.json()) as {
    authorization_code: string;
    code_challenge: string;
    code_verifier: string;
  };

  // Standard PKCE exchange — but with the deviceauth callback URI
  // that Hydra uses internally for this flow. The user never visits
  // this URL; it's just the value Hydra associates with the
  // authorization code so the exchange typechecks.
  const tokenRes = await postForm(`${ISSUER}/oauth/token`, {
    grant_type: "authorization_code",
    client_id: getCodexClientId(),
    code: json.authorization_code,
    redirect_uri: DEVICE_REDIRECT_URI,
    code_verifier: json.code_verifier,
  });
  if (!tokenRes.ok) {
    const body = await tokenRes.text().catch(() => "");
    throw new Error(
      `Codex device-code token exchange failed (${tokenRes.status}): ${body}`,
    );
  }
  const tokens = (await tokenRes.json()) as RawTokenResponse;
  const apiKey = await obtainApiKey(tokens.id_token);
  return {
    status: "connected",
    tokens: {
      apiKey,
      refreshToken: tokens.refresh_token,
      expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
    },
  };
}

// ─── Backwards-compat shims so older callers keep compiling ──────────

/** @deprecated use `encryptCodexCreds`. */
export function encryptTokens(t: {
  accessToken: string;
  refreshToken: string;
}): { accessEncrypted: string; refreshEncrypted: string } {
  return {
    accessEncrypted: encrypt(t.accessToken),
    refreshEncrypted: encrypt(t.refreshToken),
  };
}

/** @deprecated use `decryptCodexCreds`. */
export function decryptTokens(e: {
  accessEncrypted: string;
  refreshEncrypted: string;
}): { accessToken: string; refreshToken: string } {
  return {
    accessToken: decrypt(e.accessEncrypted),
    refreshToken: decrypt(e.refreshEncrypted),
  };
}

/** @deprecated alias for `refreshTokens`. */
export const refreshAccessToken = refreshTokens;
