import { createHash, randomBytes } from "node:crypto";
import { encrypt, decrypt } from "@/lib/crypto";

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
 * Throws when the operator has not configured `CODEX_OAUTH_CLIENT_ID` —
 * the v1.4.2 build silently dropped the param and rendered a generic
 * chatgpt.com login that never returned a code, so the "Connect with
 * ChatGPT" button effectively did nothing. Failing here lets the route
 * surface a 503 with an actionable message instead of redirecting to
 * a dead-end page.
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
  const id = process.env.CODEX_OAUTH_CLIENT_ID?.trim();
  if (!id) throw new CodexOAuthNotConfiguredError();
  return id;
}

export function isCodexOAuthConfigured(): boolean {
  return Boolean(process.env.CODEX_OAUTH_CLIENT_ID?.trim());
}

export function buildAuthorizationUrl(params: {
  codeChallenge: string;
  state: string;
  redirectUri: string;
}): string {
  const url = new URL("https://chatgpt.com/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", getCodexClientId());
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", params.state);
  url.searchParams.set("redirect_uri", params.redirectUri);
  return url.toString();
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

export async function exchangeCodeForTokens(params: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<TokenResponse> {
  const res = await fetch("https://chatgpt.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: getCodexClientId(),
      code: params.code,
      code_verifier: params.codeVerifier,
      redirect_uri: params.redirectUri,
    }),
  });

  if (!res.ok) {
    throw new Error(`Codex token exchange failed (${res.status})`);
  }

  return res.json();
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const res = await fetch("https://chatgpt.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: getCodexClientId(),
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    throw new Error(`Codex token refresh failed (${res.status})`);
  }

  return res.json();
}

export function encryptTokens(tokens: {
  accessToken: string;
  refreshToken: string;
}): { accessEncrypted: string; refreshEncrypted: string } {
  return {
    accessEncrypted: encrypt(tokens.accessToken),
    refreshEncrypted: encrypt(tokens.refreshToken),
  };
}

export function decryptTokens(encrypted: {
  accessEncrypted: string;
  refreshEncrypted: string;
}): { accessToken: string; refreshToken: string } {
  return {
    accessToken: decrypt(encrypted.accessEncrypted),
    refreshToken: decrypt(encrypted.refreshEncrypted),
  };
}
