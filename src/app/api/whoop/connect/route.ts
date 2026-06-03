import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { annotate, getEvent } from "@/lib/logging/context";
import { checkRateLimit } from "@/lib/rate-limit";
import { getAuthorizationUrl } from "@/lib/whoop/client";
import { getUserWhoopCredentials } from "@/lib/whoop/credentials";
import {
  WHOOP_OAUTH_STATE_COOKIE,
  WHOOP_OAUTH_STATE_TTL_MS,
  mintWhoopOAuthStateNonce,
} from "@/lib/whoop/oauth-state";
import { NextRequest, NextResponse } from "next/server";
import { shouldEmitSecureCookie } from "@/lib/auth/secure-cookie";

/**
 * Redirect the user to the WHOOP OAuth authorization page (v1.11.0).
 *
 * Mirrors the Withings connect route: a fully-random base64url state nonce
 * backed by a 10-minute `WhoopOAuthState` ledger row carries the
 * `(nonce → userId)` mapping, so the user id never travels in the OAuth
 * `state` param (which can land in request logs / network captures). The
 * httpOnly + Secure cookie carries JUST the nonce; the callback resolves the
 * user via the row's `userId`.
 *
 * Rate-limited per user (10 calls / 60 s) so a logged-in session can't spam
 * ledger rows for the full 10-min TTL window. Both the rate-limit and
 * create-failure paths redirect (not JSON) because the entry point is a
 * browser navigation — a 429 envelope would surface as a blank page.
 */
const CONNECT_RATE_LIMIT = 10;
const CONNECT_WINDOW_MS = 60_000;

export const GET = apiHandler(async (req: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "whoop.connect" } });

  const rl = await checkRateLimit(
    `whoop:connect:${user.id}`,
    CONNECT_RATE_LIMIT,
    CONNECT_WINDOW_MS,
  );
  if (!rl.allowed) {
    annotate({ action: { name: "whoop.connect.rate_limited" } });
    return NextResponse.redirect(
      new URL(
        "/settings/integrations?whoop=error&reason=rate_limited",
        req.url,
      ),
    );
  }

  const creds = await getUserWhoopCredentials(user.id);
  if (!creds) {
    return apiError(
      "Please configure your WHOOP Client ID and Client Secret in Settings first.",
      400,
    );
  }

  const nonce = mintWhoopOAuthStateNonce();
  try {
    await prisma.whoopOAuthState.create({
      data: {
        nonce,
        userId: user.id,
        expiresAt: new Date(Date.now() + WHOOP_OAUTH_STATE_TTL_MS),
      },
    });
  } catch (err) {
    getEvent()?.setError(err);
    annotate({ action: { name: "whoop.connect.create_failed" } });
    return NextResponse.redirect(
      new URL("/settings/integrations?whoop=error&reason=connect", req.url),
    );
  }

  const url = getAuthorizationUrl(nonce, creds);

  const response = NextResponse.redirect(url);
  response.cookies.set(WHOOP_OAUTH_STATE_COOKIE, nonce, {
    httpOnly: true,
    secure: shouldEmitSecureCookie(),
    sameSite: "lax",
    maxAge: Math.floor(WHOOP_OAUTH_STATE_TTL_MS / 1000),
    path: "/",
  });

  return response;
});
