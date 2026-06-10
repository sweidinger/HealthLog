import { prisma } from "@/lib/db";
import {
  consumeInviteToken,
  recordInviteConsumer,
} from "@/lib/auth/invite-token";
import { registerSchema } from "@/lib/validations/auth";
import { hashPassword, checkPasswordStrength } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import {
  apiSuccess,
  apiError,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { checkAuthSurfaceRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { ensureDbCompatibility } from "@/lib/db-compat";
import { NextRequest, NextResponse } from "next/server";
import { apiHandler } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { resolveServerLocale } from "@/lib/i18n/server-locale";
import {
  isValidTimezone,
  resolveServerDefaultTimezone,
} from "@/lib/tz/resolver";

export const POST = apiHandler(async (request: NextRequest) => {
  // v1.4.43 W13 M-4 — tighten to a global bucket when the trust chain
  // is misconfigured; otherwise byte-equivalent per-IP semantics.
  const rl = await checkAuthSurfaceRateLimit(
    request,
    "auth:register",
    5,
    15 * 60 * 1000,
  );
  const ip = rl.ip ?? "unknown";
  if (!rl.allowed) {
    return NextResponse.json(
      {
        data: null,
        error: "Too many registration attempts. Please try again later.",
      },
      { status: 429, headers: rateLimitHeaders(rl) },
    );
  }

  await ensureDbCompatibility();

  const userCount = await prisma.user.count();

  // Check if registration is enabled.
  // Safety valve: when there are zero users, always allow bootstrap registration.
  let registrationEnabled = true;
  try {
    const settings = await prisma.appSettings.findUnique({
      where: { id: "singleton" },
    });
    if (settings && !settings.registrationEnabled && userCount > 0) {
      registrationEnabled = false;
    }
  } catch {
    // Table may not exist yet; allow registration
  }
  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });

  if (jsonError) return jsonError;
  const parsed = registerSchema.safeParse(body);

  if (!parsed.success) {
    // v1.4.43 W6 — multi-issue 422.
    return returnAllZodIssues(parsed.error, 422);
  }

  const {
    email,
    username,
    password,
    timezone: timezoneInput,
    inviteToken,
  } = parsed.data;

  // v1.15.20 — closed registration still admits a valid invite. The
  // token itself is 32 random bytes behind a keyed hash and the surface
  // is rate-limited (5 / 15 min / IP), so a distinct "invalid invite"
  // message is a UX win, not an oracle.
  if (!registrationEnabled && !inviteToken) {
    return apiError("Registration is disabled", 403);
  }

  // v1.4.25 W7 — accept a browser-detected timezone from the
  // registration form. Validate against the runtime IANA list; on
  // any invalid value (or absence), fall back to the admin-
  // configured server default. The `User.timezone` column has a
  // hard-coded "Europe/Berlin" default at the schema layer, so the
  // worst-case chain still produces a usable string.
  let timezone: string;
  const trimmedTimezone = timezoneInput?.trim() ?? "";
  if (trimmedTimezone && isValidTimezone(trimmedTimezone)) {
    timezone = trimmedTimezone;
  } else {
    timezone = await resolveServerDefaultTimezone();
  }

  // Check if email or username already taken (unified message to prevent enumeration)
  const [existingEmail, existingUsername] = await Promise.all([
    prisma.user.findUnique({ where: { email } }),
    prisma.user.findUnique({ where: { username } }),
  ]);
  if (existingEmail || existingUsername) {
    return apiError("Username or email already taken", 409);
  }

  // Validate password strength (locale-aware feedback)
  const locale = await resolveServerLocale({ request });
  const strength = checkPasswordStrength(password, [username, email], locale);
  if (!strength.isAcceptable) {
    return apiError(
      strength.feedback[0] || "Password too weak (score < 3)",
      422,
    );
  }
  const passwordHash = await hashPassword(password);

  // v1.15.20 — consume the invite LAST, after every other validation,
  // so a taken username or weak password can never burn one of the
  // invite's uses. The guarded increment inside `consumeInviteToken`
  // makes the last-use race safe under concurrent signups.
  let inviteId: string | null = null;
  if (!registrationEnabled && inviteToken) {
    const consumed = await consumeInviteToken(inviteToken);
    if (!consumed.ok) {
      annotate({
        action: { name: "auth.register.invite_rejected" },
        meta: { reason: consumed.reason },
      });
      return apiError("Invalid or expired invite", 403);
    }
    inviteId = consumed.inviteId;
  }

  // First user becomes admin
  const role = userCount === 0 ? "ADMIN" : "USER";

  // Create user
  const user = await prisma.user.create({
    data: {
      email,
      username,
      passwordHash,
      role,
      timezone,
    },
  });

  // Create session immediately. v1.4.22 W5 reconcile (Sr-H1) —
  // `createSession` anchors the `hl_onboarding` cookie itself; fresh
  // users are always pending so the proxy redirects on first
  // navigation instead of waiting for hydration.
  const ua = request.headers.get("user-agent");
  await createSession(user.id, true, ip, ua);

  // Stamp the consumer onto the invite (informational, best-effort —
  // the use itself was already counted atomically above).
  if (inviteId) {
    await recordInviteConsumer(inviteId, user.id);
  }

  await auditLog("auth.register", {
    userId: user.id,
    ipAddress: ip,
    details: { method: "password", timezone, invited: inviteId !== null },
  });

  annotate({ action: { name: "auth.register" } });

  return apiSuccess(
    {
      user: { id: user.id, username: user.username, email: user.email },
    },
    201,
  );
});
