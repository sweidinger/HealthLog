import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { annotate, getEvent } from "@/lib/logging/context";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  generatePkcePair,
  getAuthorizationUrl,
} from "@/lib/google-health/client";
import { getUserGoogleHealthCredentials } from "@/lib/google-health/credentials";
import {
  GOOGLE_HEALTH_OAUTH_STATE_COOKIE,
  GOOGLE_HEALTH_OAUTH_STATE_TTL_MS,
  mintGoogleHealthOAuthStateNonce,
} from "@/lib/google-health/oauth-state";
import { NextRequest, NextResponse } from "next/server";
import { shouldEmitSecureCookie } from "@/lib/auth/secure-cookie";

/**
 * Redirect the user to the Google OAuth consent page for the Google Health
 * integration (v1.26.0).
 *
 * Mirrors the Fitbit / WHOOP connect route with PKCE added: a fully-random
 * base64url state nonce backed by a 10-minute `GoogleHealthOAuthState` ledger
 * row carries the `(nonce → userId)` mapping AND the PKCE `code_verifier`, so
 * neither the user id nor the verifier ever travels in the OAuth `state` param
 * (which can land in request logs / network captures). The httpOnly + Secure
 * cookie carries JUST the nonce; the callback resolves the user via the row's
 * `userId` and reads the verifier off the same row.
 *
 * Rate-limited per user (10 calls / 60 s) so a logged-in session can't spam
 * ledger rows for the full 10-min TTL window. Both the rate-limit and
 * create-failure paths redirect (not JSON) because the entry point is a browser
 * navigation — a 429 envelope would surface as a blank page.
 */
const CONNECT_RATE_LIMIT = 10;
const CONNECT_WINDOW_MS = 60_000;

export const GET = apiHandler(async (req: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "google_health.connect" } });

  const rl = await checkRateLimit(
    `google-health:connect:${user.id}`,
    CONNECT_RATE_LIMIT,
    CONNECT_WINDOW_MS,
  );
  if (!rl.allowed) {
    annotate({ action: { name: "google_health.connect.rate_limited" } });
    return NextResponse.redirect(
      new URL(
        "/settings/integrations?googleHealth=error&reason=rate_limited",
        req.url,
      ),
    );
  }

  const creds = await getUserGoogleHealthCredentials(user.id);
  if (!creds) {
    return apiError(
      "Please configure your Google OAuth Client ID and Client Secret in Settings first.",
      400,
    );
  }

  const nonce = mintGoogleHealthOAuthStateNonce();
  const { verifier, challenge } = generatePkcePair();
  try {
    await prisma.googleHealthOAuthState.create({
      data: {
        nonce,
        userId: user.id,
        codeVerifier: verifier,
        expiresAt: new Date(Date.now() + GOOGLE_HEALTH_OAUTH_STATE_TTL_MS),
      },
    });
  } catch (err) {
    getEvent()?.setError(err);
    annotate({ action: { name: "google_health.connect.create_failed" } });
    return NextResponse.redirect(
      new URL(
        "/settings/integrations?googleHealth=error&reason=connect",
        req.url,
      ),
    );
  }

  const url = getAuthorizationUrl(nonce, creds, challenge);

  const response = NextResponse.redirect(url);
  response.cookies.set(GOOGLE_HEALTH_OAUTH_STATE_COOKIE, nonce, {
    httpOnly: true,
    secure: shouldEmitSecureCookie(),
    sameSite: "lax",
    maxAge: Math.floor(GOOGLE_HEALTH_OAUTH_STATE_TTL_MS / 1000),
    path: "/",
  });

  return response;
});
