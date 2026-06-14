import { apiSuccess } from "@/lib/api-response";
import { getReminderThresholds } from "@/lib/app-settings";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
import { parseNotificationPrefs } from "@/lib/validations/notification-prefs";

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
  const prefs = parseNotificationPrefs(row?.notificationPrefs ?? null);
  const lowStockRunwayDays = prefs.medication.lowStockRunwayDays;
  // v1.17.0 — the user-level reorder lead default rides along so the
  // medication cards can derive the same reorder-lead-aware trigger the
  // daily cron uses (per-medication overrides come from the list payload's
  // own `reorderLeadDays`).
  const reorderLeadDays = prefs.medication.reorderLeadDays;

  annotate({ action: { name: "settings.reminder-thresholds.get" } });

  return apiSuccess({ ...thresholds, lowStockRunwayDays, reorderLeadDays });
});
