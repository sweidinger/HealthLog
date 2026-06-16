import { prisma } from "@/lib/db";
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { NextRequest, NextResponse } from "next/server";
import { invalidateAllCaches } from "@/lib/cache/invalidate";

export const dynamic = "force-dynamic";

/**
 * Admin-only global wipe of all health/integration data.
 * Keeps users/passkeys so access to the app remains possible.
 */
export const DELETE = apiHandler(async (request: NextRequest) => {
  const ip = getClientIp(request);
  const rl = await checkRateLimit(`admin-data-delete:${ip}`, 5, 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json(
      { data: null, error: "Rate limit exceeded" },
      { status: 429, headers: rateLimitHeaders(rl) },
    );
  }

  const { user } = await requireAdmin();
  annotate({ action: { name: "admin.data.delete" } });

  // v1.18.1 — the documented convention buckets authenticated admin
  // mutations on `userId`, not the (pre-auth, spoofable) client IP. The
  // IP bucket above is the anonymous first-line throttle; this is the
  // canonical per-admin bucket the rate-limit contract specifies.
  const userRl = await checkRateLimit(
    `admin-data-delete:${user.id}`,
    5,
    60 * 1000,
  );
  if (!userRl.allowed) {
    return NextResponse.json(
      { data: null, error: "Rate limit exceeded" },
      { status: 429, headers: rateLimitHeaders(userRl) },
    );
  }

  let confirm = "";
  try {
    const raw = await request.text();
    if (raw.length > 64 * 1024) {
      return apiError(`Request body exceeds ${64 * 1024} bytes`, 413);
    }
    const body = JSON.parse(raw);
    confirm = typeof body?.confirm === "string" ? body.confirm : "";
  } catch {
    return apiError("Invalid request", 422);
  }

  if (confirm !== "DELETE ALL") {
    return apiError("Confirmation missing", 422);
  }

  // Audit-log the *intent* before the transaction begins so the trail
  // describing "an admin is about to wipe data" survives even if the
  // operation crashes midway. AuditLog rows are intentionally NOT
  // deleted as part of the wipe — the entire point of an audit trail
  // is to outlive the data it documents.
  await auditLog("admin.data.clear.start", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { confirm: "DELETE ALL" },
  });

  const result = await prisma.$transaction(async (tx) => {
    const measurements = await tx.measurement.deleteMany({});
    const intakeEvents = await tx.medicationIntakeEvent.deleteMany({});
    const medications = await tx.medication.deleteMany({});
    const apiTokens = await tx.apiToken.deleteMany({});
    const withingsConnections = await tx.withingsConnection.deleteMany({});
    const authChallenges = await tx.authChallenge.deleteMany({});

    // v1.4.6 left these out, so encrypted Telegram bot tokens
    // (NotificationChannel.config) and Web Push endpoints survived a
    // wipe. Cascading via NotificationPreference is handled by the
    // schema's onDelete: Cascade on the channel FK.
    const notificationChannels = await tx.notificationChannel.deleteMany({});
    const pushSubscriptions = await tx.pushSubscription.deleteMany({});
    const telegramScheduledDeletions =
      await tx.telegramScheduledDeletion.deleteMany({});

    await tx.user.updateMany({
      data: {
        heightCm: null,
        dateOfBirth: null,
        gender: null,
        insightsPrivacyMode: "aggregated",
        insightsCachedAt: null,
        insightsCachedText: null,
        telegramBotToken: null,
        telegramChatId: null,
        telegramEnabled: false,
        withingsClientIdEncrypted: null,
        withingsClientSecretEncrypted: null,
        onboardingCompletedAt: null,
      },
    });

    return {
      measurements: measurements.count,
      intakeEvents: intakeEvents.count,
      medications: medications.count,
      apiTokens: apiTokens.count,
      withingsConnections: withingsConnections.count,
      authChallenges: authChallenges.count,
      notificationChannels: notificationChannels.count,
      pushSubscriptions: pushSubscriptions.count,
      telegramScheduledDeletions: telegramScheduledDeletions.count,
    };
  });

  await auditLog("admin.data.clear", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: result,
  });

  // v1.16.9 — the wipe touched every user's rows; clear every cache
  // bucket so no per-user payload survives the reset.
  invalidateAllCaches();

  return apiSuccess({ cleared: true, ...result });
});
