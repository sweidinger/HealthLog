import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { shouldEmitSecureCookie } from "@/lib/auth/secure-cookie";
import { checkRateLimit } from "@/lib/rate-limit";
import { getAuthorizationUrl } from "@/lib/strava/client";
import { getStravaClientCredentials } from "@/lib/strava/credentials";
import {
  OAUTH_STATE_TTL_MS,
  mintSignedState,
  oauthStateCookieName,
} from "@/lib/oauth/signed-state";
import { NextResponse } from "next/server";

/**
 * v1.28.x — redirect the user to the Strava consent screen.
 *
 * Credentials resolve DB-first then env (`getStravaClientCredentials`): a
 * user's BYO Strava client id/secret wins, falling back to the shared env app
 * (`STRAVA_CLIENT_ID` / `STRAVA_CLIENT_SECRET`) when none is stored. CSRF via
 * the stateless signed state (`src/lib/oauth/signed-state.ts`): the same token
 * is the `state` URL param AND an httpOnly cookie. Rate-limited per user.
 */
const CONNECT_RATE_LIMIT = 10;
const CONNECT_WINDOW_MS = 60_000;

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "strava.connect" } });

  const rl = await checkRateLimit(
    `strava:connect:${user.id}`,
    CONNECT_RATE_LIMIT,
    CONNECT_WINDOW_MS,
  );
  if (!rl.allowed) {
    annotate({ action: { name: "strava.connect.rate_limited" } });
    return NextResponse.redirect(
      new URL(
        "/settings/integrations?strava=error&reason=rate_limited",
        process.env.NEXT_PUBLIC_APP_URL!,
      ),
    );
  }

  const creds = await getStravaClientCredentials(user.id);
  if (!creds) {
    return apiError(
      "Strava integration is not configured on this server.",
      400,
    );
  }

  const state = mintSignedState("strava", user.id);
  const url = getAuthorizationUrl(state, creds);

  const response = NextResponse.redirect(url);
  response.cookies.set(oauthStateCookieName("strava"), state, {
    httpOnly: true,
    secure: shouldEmitSecureCookie(),
    sameSite: "lax",
    maxAge: Math.floor(OAUTH_STATE_TTL_MS / 1000),
    path: "/",
  });
  return response;
});
