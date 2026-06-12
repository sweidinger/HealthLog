import { apiSuccess } from "@/lib/api-response";
import { getReminderThresholds } from "@/lib/app-settings";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
import { resolveLowStockRunwayDays } from "@/lib/validations/notification-prefs";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();

  const thresholds = await getReminderThresholds();

  // v1.16.11 — the low-stock runway threshold rides along so every
  // threshold consumer reads one endpoint. Unlike `lateMinutes` /
  // `missedMinutes` (operator-level singleton) this one is PER-USER:
  // it lives in `notificationPrefs.medication.lowStockRunwayDays`
  // (1–60 days, `null` = alert off, default 7) and is written through
  // the established `PATCH /api/auth/me/notification-prefs` path.
  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { notificationPrefs: true },
  });
  const lowStockRunwayDays = resolveLowStockRunwayDays(
    row?.notificationPrefs ?? null,
  );

  annotate({ action: { name: "settings.reminder-thresholds.get" } });

  return apiSuccess({ ...thresholds, lowStockRunwayDays });
});
