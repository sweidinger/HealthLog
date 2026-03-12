import { createAuthenticationOptions } from "@/lib/auth/passkey";
import { apiSuccess, getClientIp } from "@/lib/api-response";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";

export const POST = apiHandler(async (request: Request) => {
  const ip = getClientIp(request) ?? "unknown";
  const rl = await checkRateLimit(
    `auth:passkey-login-options:${ip}`,
    10,
    15 * 60 * 1000,
  );
  if (!rl.allowed) {
    return NextResponse.json(
      {
        data: null,
        error: "Too many passkey requests. Please try again later.",
      },
      { status: 429, headers: rateLimitHeaders(rl) },
    );
  }

  const { options, challengeId } = await createAuthenticationOptions();

  annotate({ action: { name: "auth.passkey.login-options" } });

  return apiSuccess({ options, challengeId });
});
