/**
 * Token endpoint (OAuth 2.1) — `authorization_code` + `refresh_token` grants.
 *
 * Exchanges the bridge AS's self-describing artifacts for a REAL `hlk_`
 * `ApiToken` (the access token) minted through `issue-token.ts` with the narrow
 * `health:read` scope (ADR-006). The access token is therefore an ordinary
 * Bearer the `/mcp` resolver already understands — bound to `<userId>:<tokenId>`
 * (REQ-SEC-11), revocable, and short-lived. There is no token passthrough: the
 * MCP layer never forwards a client-presented upstream credential.
 *
 * Gates:
 *   - PKCE — the presented `code_verifier` MUST hash (S256) to the
 *     `code_challenge` bound into the authorization code.
 *   - Single use — the code's `jti` is claimed once through the atomic
 *     rate-limit upsert; a replay within the TTL is rejected.
 *   - Audience — the code's bound `resource` MUST equal the canonical `/mcp`
 *     URI (RFC 8707); a `resource` parameter, when sent, must match too.
 *   - Client binding — the `client_id` presented at `/token` MUST equal the one
 *     the code was issued to.
 *
 * Refresh tokens rotate on every use (OAuth 2.1 public-client rotation): a fresh
 * access + refresh pair is returned and the presented refresh `jti` is claimed
 * so it cannot be reused.
 */
import { randomUUID } from "node:crypto";

import { NextRequest } from "next/server";

import { annotate } from "@/lib/logging/context";
import { withBackgroundEvent } from "@/lib/logging/background";
import { auditLog } from "@/lib/auth/audit";
import { issueApiToken } from "@/lib/auth/issue-token";
import {
  checkRateLimit,
  checkAuthSurfaceRateLimit,
  rateLimitHeaders,
} from "@/lib/rate-limit";
import {
  ACCESS_TOKEN_TTL_MINUTES,
  audienceMatches,
  REFRESH_TOKEN_TTL_DAYS,
  SCOPE_HEALTH_READ,
} from "@/lib/mcp/oauth/config";
import { signArtifact, verifyArtifact } from "@/lib/mcp/oauth/artifacts";
import { verifyPkceS256 } from "@/lib/mcp/oauth/pkce";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TOKEN_LIMIT = 120;
const TOKEN_WINDOW_MS = 15 * 60 * 1000;

function oauthError(
  error: string,
  description: string,
  status = 400,
): Response {
  return Response.json(
    { error, error_description: description },
    { status, headers: { "Cache-Control": "no-store", Pragma: "no-cache" } },
  );
}

function tokenSuccess(body: Record<string, unknown>): Response {
  return Response.json(body, {
    headers: { "Cache-Control": "no-store", Pragma: "no-cache" },
  });
}

/** Claim a one-time-use jti through the atomic limiter (limit 1 ⇒ single use). */
async function claimJti(
  kind: string,
  jti: string,
  ttlMs: number,
): Promise<boolean> {
  if (typeof jti !== "string" || jti.length === 0) return false;
  const rl = await checkRateLimit(`oauth:jti:${kind}:${jti}`, 1, ttlMs);
  return rl.allowed;
}

interface AuthCodeClaims {
  jti: string;
  sub: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
  resource: string;
}

interface RefreshClaims {
  jti: string;
  sub: string;
  client_id: string;
  scope: string;
  resource: string;
}

async function mintTokenPair(args: {
  userId: string;
  clientId: string;
  scope: string;
  resource: string;
  grant: "authorization_code" | "refresh_token";
}): Promise<Response> {
  const access = await issueApiToken({
    userId: args.userId,
    name: "MCP connector",
    permissions: [SCOPE_HEALTH_READ],
    expiresInMinutes: ACCESS_TOKEN_TTL_MINUTES,
  });

  const includeRefresh = args.scope.split(/\s+/).includes("offline_access");
  const refresh = includeRefresh
    ? signArtifact(
        "refreshToken",
        {
          jti: randomUUID(),
          sub: args.userId,
          client_id: args.clientId,
          scope: args.scope,
          resource: args.resource,
        },
        REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
      )
    : undefined;

  await auditLog("mcp.oauth.token.issued", {
    userId: args.userId,
    details: { client_id: args.clientId, grant: args.grant, scope: args.scope },
  });
  annotate({
    action: { name: "mcp.oauth.token.issued" },
    meta: { grant: args.grant },
  });

  return tokenSuccess({
    access_token: access.token,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_MINUTES * 60,
    scope: args.scope,
    ...(refresh ? { refresh_token: refresh } : {}),
  });
}

export async function POST(request: NextRequest): Promise<Response> {
  return withBackgroundEvent("mcp.oauth.token", async () => {
    const rl = await checkAuthSurfaceRateLimit(
      request,
      "mcp:oauth:token",
      TOKEN_LIMIT,
      TOKEN_WINDOW_MS,
    );
    if (!rl.allowed) {
      return Response.json(
        { error: "temporarily_unavailable" },
        {
          status: 429,
          headers: rateLimitHeaders({
            allowed: false,
            remaining: rl.remaining,
            resetAt: rl.resetAt,
          }),
        },
      );
    }

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return oauthError(
        "invalid_request",
        "Expected application/x-www-form-urlencoded body",
      );
    }
    const get = (k: string): string | undefined => {
      const v = form.get(k);
      return typeof v === "string" ? v : undefined;
    };

    const grantType = get("grant_type");

    if (grantType === "authorization_code") {
      const code = get("code");
      const verifier = get("code_verifier");
      const clientId = get("client_id");
      const redirectUri = get("redirect_uri");

      if (!code || !verifier || !clientId || !redirectUri) {
        return oauthError(
          "invalid_request",
          "Missing code, code_verifier, client_id, or redirect_uri",
        );
      }

      const verified = verifyArtifact<AuthCodeClaims>("authCode", code);
      if (!verified.ok) {
        annotate({ action: { name: "mcp.oauth.token.code_rejected" } });
        return oauthError(
          "invalid_grant",
          "Authorization code is invalid or expired",
        );
      }
      const claims = verified.claims;

      // Client + redirect binding.
      if (
        claims.client_id !== clientId ||
        claims.redirect_uri !== redirectUri
      ) {
        return oauthError(
          "invalid_grant",
          "Authorization code was issued to a different client/redirect",
        );
      }
      // Audience: a resource parameter, if present, must also match.
      const resourceParam = get("resource");
      if (resourceParam && !audienceMatches(resourceParam, request.url)) {
        return oauthError(
          "invalid_target",
          "resource does not match the bound audience",
        );
      }
      if (!audienceMatches(claims.resource, request.url)) {
        return oauthError(
          "invalid_target",
          "Authorization code is bound to a different audience",
        );
      }
      // PKCE.
      if (!verifyPkceS256(verifier, claims.code_challenge)) {
        annotate({ action: { name: "mcp.oauth.token.pkce_failed" } });
        return oauthError("invalid_grant", "PKCE verification failed");
      }
      // Single use — claim the code's jti.
      if (!(await claimJti("code", claims.jti, 5 * 60 * 1000))) {
        annotate({ action: { name: "mcp.oauth.token.code_replayed" } });
        return oauthError(
          "invalid_grant",
          "Authorization code has already been used",
        );
      }

      return mintTokenPair({
        userId: claims.sub,
        clientId: claims.client_id,
        scope: claims.scope,
        resource: claims.resource,
        grant: "authorization_code",
      });
    }

    if (grantType === "refresh_token") {
      const refreshToken = get("refresh_token");
      const clientId = get("client_id");
      if (!refreshToken || !clientId) {
        return oauthError(
          "invalid_request",
          "Missing refresh_token or client_id",
        );
      }

      const verified = verifyArtifact<RefreshClaims>(
        "refreshToken",
        refreshToken,
      );
      if (!verified.ok) {
        return oauthError(
          "invalid_grant",
          "Refresh token is invalid or expired",
        );
      }
      const claims = verified.claims;
      if (claims.client_id !== clientId) {
        return oauthError(
          "invalid_grant",
          "Refresh token was issued to a different client",
        );
      }
      if (!audienceMatches(claims.resource, request.url)) {
        return oauthError(
          "invalid_target",
          "Refresh token is bound to a different audience",
        );
      }
      // Rotation: claim the presented refresh jti so it cannot be reused.
      if (
        !(await claimJti(
          "refresh",
          claims.jti,
          REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
        ))
      ) {
        annotate({ action: { name: "mcp.oauth.token.refresh_replayed" } });
        return oauthError(
          "invalid_grant",
          "Refresh token has already been used",
        );
      }

      return mintTokenPair({
        userId: claims.sub,
        clientId: claims.client_id,
        scope: claims.scope,
        resource: claims.resource,
        grant: "refresh_token",
      });
    }

    return oauthError(
      "unsupported_grant_type",
      "Only authorization_code and refresh_token are supported",
    );
  });
}
