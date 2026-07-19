/**
 * POST /api/auth/step-up/options
 *
 * Begin a primary-passkey assertion for the step-up mint below. Returns
 * SimpleWebAuthn assertion options scoped to the calling account's registered
 * passkeys, plus the server-issued challenge id to present back at
 * `POST /api/auth/step-up`.
 *
 * Bearer-only (`requireBearerAuth`) — a browser has no use for this surface; it
 * re-proves a factor at login and carries the result on its session row. The
 * allow-list is never empty by construction: an account with no passkey gets a
 * 409 telling the client to use the password arm instead.
 */
import { NextRequest } from "next/server";
import { apiHandler, requireBearerAuth } from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
import { checkAuthSurfaceRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { createAuthenticationOptions } from "@/lib/auth/passkey";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireBearerAuth();

  const rl = await checkAuthSurfaceRateLimit(
    request,
    "auth:step-up",
    20,
    15 * 60 * 1000,
  );
  if (!rl.allowed) {
    return apiError("Too many attempts. Please try again later.", 429, {
      headers: rateLimitHeaders(rl),
    });
  }

  const passkeyCount = await prisma.passkey.count({
    where: { userId: user.id },
  });
  if (passkeyCount === 0) {
    annotate({ action: { name: "auth.stepup.passkey.none" } });
    return apiError("No passkey registered", 409);
  }

  const { options, challengeId } = await createAuthenticationOptions(user.id);

  annotate({ action: { name: "auth.stepup.passkey.options" } });
  return apiSuccess({ options, challengeId });
});
