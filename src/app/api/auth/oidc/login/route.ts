import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { apiHandler } from "@/lib/api-handler";
import { annotate, getEvent } from "@/lib/logging/context";
import { checkAuthSurfaceRateLimit } from "@/lib/rate-limit";
import { encrypt } from "@/lib/crypto";
import { shouldEmitSecureCookie } from "@/lib/auth/secure-cookie";
import { s256Challenge } from "@/lib/mcp/oauth/pkce";
import {
  buildAuthorizationUrl,
  discoverOidcMetadata,
  getOidcConfig,
  getOidcRedirectUri,
  oidcAppUrl,
  sanitizeOidcNextPath,
} from "@/lib/auth/oidc";
import {
  OIDC_STATE_COOKIE,
  OIDC_STATE_COOKIE_PATH,
  OIDC_STATE_TTL_MS,
} from "@/lib/auth/oidc-cookie";

/**
 * Redirects the browser to the configured OIDC provider's authorization
 * endpoint. Full-page navigation, not a fetch — every failure branch
 * redirects to `/auth/login?error=...` rather than returning a JSON
 * envelope, mirroring `src/app/api/withings/connect/route.ts`.
 */
export const GET = apiHandler(async (req: NextRequest) => {
  annotate({ action: { name: "auth.oidc.login" } });

  const config = getOidcConfig();
  if (!config) {
    return NextResponse.redirect(oidcAppUrl("/auth/login?error=oidc_disabled"));
  }

  const rl = await checkAuthSurfaceRateLimit(
    req,
    "auth:oidc:login",
    10,
    15 * 60 * 1000,
  );
  if (!rl.allowed) {
    return NextResponse.redirect(
      oidcAppUrl("/auth/login?error=oidc_rate_limited"),
    );
  }

  let metadata;
  try {
    metadata = await discoverOidcMetadata(config);
  } catch (err) {
    getEvent()?.setError(err);
    return NextResponse.redirect(oidcAppUrl("/auth/login?error=oidc_failed"));
  }

  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const codeVerifier = randomBytes(64).toString("base64url");
  const codeChallenge = s256Challenge(codeVerifier);

  const safeNext = sanitizeOidcNextPath(
    req.nextUrl.searchParams.get("next"),
    req.url,
  );

  const redirectUri = getOidcRedirectUri();
  const authorizationUrl = buildAuthorizationUrl({
    metadata,
    config,
    state,
    nonce,
    codeChallenge,
    redirectUri,
  });

  const response = NextResponse.redirect(authorizationUrl);
  const cookiePayload = encrypt(
    JSON.stringify({ state, nonce, codeVerifier, next: safeNext }),
  );
  response.cookies.set(OIDC_STATE_COOKIE, cookiePayload, {
    httpOnly: true,
    secure: shouldEmitSecureCookie(),
    // Cross-site top-level redirect back from the IdP, same reasoning as
    // the session cookie and the Withings OAuth state cookie.
    sameSite: "lax",
    maxAge: Math.floor(OIDC_STATE_TTL_MS / 1000),
    // Shared constant — the callback's delete must repeat this exact path
    // (RFC 6265 keys cookies by name+domain+path).
    path: OIDC_STATE_COOKIE_PATH,
  });

  return response;
});
