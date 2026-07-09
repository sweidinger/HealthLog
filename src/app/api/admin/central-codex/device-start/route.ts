import { NextRequest } from "next/server";
import { apiHandler, requireAdmin, HttpError } from "@/lib/api-handler";
import { checkRateLimit } from "@/lib/rate-limit";
import { requestDeviceCode } from "@/lib/ai/codex-oauth";
import { cookies } from "next/headers";
import { annotate } from "@/lib/logging/context";
import { encrypt } from "@/lib/crypto";
import { apiSuccess } from "@/lib/api-response";
import { shouldEmitSecureCookie } from "@/lib/auth/secure-cookie";

/**
 * Operator-shared central Codex — device-code flow start (admin only).
 *
 * Mirrors the per-user `auth/codex/device-start`, but cookie-only
 * `requireAdmin()` gates it and the device-auth cookie is namespaced
 * (`central_codex_device`) so it never collides with an operator's own per-user
 * Codex connect flow. The device secret is persisted in an encrypted httpOnly
 * cookie for the 15-minute window Hydra allows.
 */
export const POST = apiHandler(async (request: NextRequest) => {
  void request;
  const { user } = await requireAdmin();

  const rl = await checkRateLimit(
    `central-codex-device-start:${user.id}`,
    5,
    60_000,
  );
  if (!rl.allowed) throw new HttpError(429, "Too many requests");

  const code = await requestDeviceCode();

  const cookieStore = await cookies();
  cookieStore.set(
    "central_codex_device",
    encrypt(
      JSON.stringify({
        deviceAuthId: code.deviceAuthId,
        userCode: code.userCode,
      }),
    ),
    {
      httpOnly: true,
      secure: shouldEmitSecureCookie(),
      sameSite: "lax",
      path: "/",
      maxAge: 15 * 60,
    },
  );

  annotate({
    action: { name: "admin.central-codex.device.start" },
    meta: { interval_seconds: code.intervalSeconds },
  });

  return apiSuccess({
    userCode: code.userCode,
    verificationUrl: code.verificationUrl,
    intervalSeconds: code.intervalSeconds,
  });
});
