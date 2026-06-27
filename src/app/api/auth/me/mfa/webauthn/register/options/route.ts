/**
 * POST /api/auth/me/mfa/webauthn/register/options
 *
 * Begin registering a WebAuthn security key as a second factor. Cookie-only —
 * an API token can never enrol MFA. Returns the SimpleWebAuthn creation
 * options + the server-issued challenge id to present back at /register/verify.
 */
import { apiHandler, requireCookieAuth } from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { createMfaRegistrationOptions } from "@/lib/auth/mfa/webauthn";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async () => {
  const { user } = await requireCookieAuth();

  const rl = await checkRateLimit(
    `mfa:webauthn:register:${user.id}`,
    10,
    15 * 60 * 1000,
  );
  if (!rl.allowed) {
    const res = apiError("Too many requests", 429);
    for (const [k, v] of Object.entries(rateLimitHeaders(rl))) {
      res.headers.set(k, v);
    }
    return res;
  }

  const { options, challengeId } = await createMfaRegistrationOptions(
    user.id,
    user.email ?? user.username,
  );

  annotate({ action: { name: "auth.mfa.webauthn.register-options" } });

  return apiSuccess({ options, challengeId });
});
