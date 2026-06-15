/**
 * v1.17.1 — Vorsorge (measurement) reminder dispatcher.
 *
 * Mirrors the mood-reminder cron (`mood-reminder.ts`): a separate module,
 * a pure due-predicate, a `runMeasurementReminderTick(prisma, now)`
 * runner. The cron fires every 15 minutes so it picks up every IANA
 * timezone crossing the reminder's `notifyHour` without one cron entry
 * per zone.
 *
 * Differences from the mood reminder:
 *
 *   1. No dedicated dispatch-ledger table. The reminder's own
 *      `nextDueAt` IS the dedup guard: after a successful dispatch the
 *      runner advances `nextDueAt` to the next occurrence strictly past
 *      now, so the same due cycle never re-fires. This collapses one
 *      table + one cleanup queue versus the mood pattern.
 *   2. Auto-resolve from an incoming measurement. Before deciding to
 *      fire, the runner checks whether a matching reading of the
 *      reminder's `measurementType` has landed since the last satisfy
 *      (BP matched on `BLOOD_PRESSURE_SYS`). If so it advances
 *      `lastSatisfiedAt` + recomputes `nextDueAt` and skips the nudge —
 *      the user who already measured today never gets nagged. This is a
 *      query in the cron, NOT a hook on the hot iOS batch-ingest path.
 *      Free-text reminders (no `measurementType`) never auto-resolve;
 *      they advance only on a manual satisfy.
 *   3. Per-reminder `clientManaged` suppression of the server-side APNs
 *      (the medication `clientManaged` precedent) is applied for the
 *      whole user via `notificationPrefs.measurementReminder.clientManaged`.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import type { MeasurementType } from "@/generated/prisma/client";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import type { Locale } from "@/lib/i18n/config";
import { defaultLocale, locales } from "@/lib/i18n/config";
import { wallClockInTz } from "@/lib/tz/wall-clock";
import { dispatchNotification } from "@/lib/notifications/dispatcher";
import { getEvent } from "@/lib/logging/context";
import { isMeasurementReminderClientManaged } from "@/lib/validations/notification-prefs";
import {
  computeReminderNextDueAt,
  type ReminderScheduleInput,
} from "@/lib/measurement-reminders/scheduling";

/**
 * Slack added to `now` when scanning for due reminders, so a `nextDueAt`
 * stamped just ahead of a tick still falls inside the same hour window.
 * One tick interval (15 min) — small enough that the in-Node hour gate stays
 * the authoritative fire decision.
 */
const DUE_QUERY_SLACK_MS = 15 * 60_000;

export interface MeasurementReminderSummary {
  candidatesScanned: number;
  inWindow: number;
  dispatched: number;
  autoResolved: number;
  skippedNotDue: number;
  skippedOutsideWindow: number;
  skippedClientManaged: number;
  skippedNoChannel: number;
  failed: number;
}

function resolveLocale(locale: string | null | undefined): Locale {
  return locales.includes(locale as Locale)
    ? (locale as Locale)
    : defaultLocale;
}

/**
 * Pure due-predicate: at this instant, is the reminder due AND inside its
 * local notify-hour window?
 *
 * "Due" = `nextDueAt != null` and `now >= nextDueAt`. The hour gate keeps
 * a reminder that became overdue overnight from firing at 03:00 — it
 * waits for the user's chosen `notifyHour` to come round in their local
 * timezone. Pulled out so the unit tests can pin the window boundary
 * (08:59 → no, 09:00 → yes, 09:59 → yes, 10:00 → no) without the DB.
 */
export function evaluateMeasurementReminderDue(
  reminder: {
    enabled: boolean;
    nextDueAt: Date | null;
    notifyHour: number;
  },
  timezone: string,
  now: Date,
): { fire: boolean; inHourWindow: boolean; isDue: boolean } {
  if (!reminder.enabled || reminder.nextDueAt === null) {
    return { fire: false, inHourWindow: false, isDue: false };
  }
  const isDue = now.getTime() >= reminder.nextDueAt.getTime();
  const parts = wallClockInTz(now, timezone || "Europe/Berlin");
  const inHourWindow = parts.hour === reminder.notifyHour;
  return { fire: isDue && inHourWindow, inHourWindow, isDue };
}

/**
 * Build the localised title + body for the Vorsorge push.
 */
export function buildMeasurementReminderPayload(
  locale: string | null | undefined,
  label: string,
  location: string | null,
): { title: string; body: string } {
  const t = getServerTranslator(resolveLocale(locale)).t;
  const base = t("measurementReminders.pushBody", { label });
  const body = location
    ? `${base} ${t("measurementReminders.pushLocation", { location })}`
    : base;
  return { title: t("measurementReminders.pushTitle"), body };
}

/**
 * The canonical sentinel measurement type the cron queries for
 * auto-resolve. BP is two rows (SYS + DIA); SYS is the "a BP was measured"
 * anchor (matching both would double-count).
 */
function autoResolveQueryType(
  reminderType: MeasurementType | null,
): MeasurementType | null {
  return reminderType;
}

/**
 * Run one Vorsorge-reminder cron tick. Iterates every live, enabled
 * reminder, auto-resolves the typed ones against incoming readings,
 * and dispatches a `MEASUREMENT_REMINDER` push for any that are due
 * inside the user's local notify-hour window.
 */
export async function runMeasurementReminderTick(
  prisma: PrismaClient,
  now: Date,
  options: {
    dispatch?: typeof dispatchNotification;
  } = {},
): Promise<MeasurementReminderSummary> {
  const dispatchImpl = options.dispatch ?? dispatchNotification;

  const summary: MeasurementReminderSummary = {
    candidatesScanned: 0,
    inWindow: 0,
    dispatched: 0,
    autoResolved: 0,
    skippedNotDue: 0,
    skippedOutsideWindow: 0,
    skippedClientManaged: 0,
    skippedNoChannel: 0,
    failed: 0,
  };

  // Bound the scan to reminders that could plausibly fire this tick so Postgres
  // uses `measurement_reminders_user_id_next_due_at_idx` instead of loading the
  // whole cross-tenant enabled set 4×/hour. `nextDueAt` is stamped at the
  // notify-hour boundary, so anything due is already <= now; the small slack
  // (one tick interval) covers a stamp landing just ahead of a :00 tick. A
  // null `nextDueAt` is a non-recurring reminder that can never fire — the
  // in-Node `evaluateMeasurementReminderDue` short-circuits it anyway, so
  // excluding it here is parity. Reminders satisfied early re-anchor once they
  // cross due, before any nudge fires, so dropping future rows is safe.
  const dueFloor = new Date(now.getTime() + DUE_QUERY_SLACK_MS);
  const reminders = await prisma.measurementReminder.findMany({
    where: {
      deletedAt: null,
      enabled: true,
      nextDueAt: { not: null, lte: dueFloor },
    },
    include: {
      user: {
        select: {
          id: true,
          timezone: true,
          locale: true,
          notificationPrefs: true,
        },
      },
    },
  });

  for (const reminder of reminders) {
    summary.candidatesScanned += 1;
    try {
      const timezone = reminder.user.timezone || "Europe/Berlin";

      // ── Auto-resolve from an incoming measurement ──────────────────
      // Cheap guard, in the cron (not on the ingest path). Only typed
      // reminders auto-resolve; free-text ones wait for a manual satisfy.
      const queryType = autoResolveQueryType(reminder.measurementType);
      if (queryType !== null) {
        // Match readings logged AFTER the last satisfy (or, never
        // satisfied, after the anchor). A reading inside the current due
        // cycle means the user already measured — re-anchor + skip the
        // nudge. `deletedAt: null` so a tombstoned reading never counts.
        const sinceFloor =
          reminder.lastSatisfiedAt ??
          reminder.anchorDate ??
          reminder.createdAt;
        const match = await prisma.measurement.findFirst({
          where: {
            userId: reminder.user.id,
            type: queryType,
            deletedAt: null,
            measuredAt: { gt: sinceFloor },
          },
          orderBy: { measuredAt: "desc" },
          select: { measuredAt: true },
        });
        if (match) {
          const scheduleInput: ReminderScheduleInput = {
            intervalDays: reminder.intervalDays,
            rrule: reminder.rrule,
            anchorDate: reminder.anchorDate,
            notifyHour: reminder.notifyHour,
            lastSatisfiedAt: match.measuredAt,
            createdAt: reminder.createdAt,
          };
          const nextDueAt = computeReminderNextDueAt(
            scheduleInput,
            timezone,
            match.measuredAt,
          );
          await prisma.measurementReminder.update({
            where: { id: reminder.id },
            data: { lastSatisfiedAt: match.measuredAt, nextDueAt },
          });
          summary.autoResolved += 1;
          continue;
        }
      }

      const decision = evaluateMeasurementReminderDue(
        {
          enabled: reminder.enabled,
          nextDueAt: reminder.nextDueAt,
          notifyHour: reminder.notifyHour,
        },
        timezone,
        now,
      );

      if (!decision.isDue) {
        summary.skippedNotDue += 1;
        continue;
      }
      if (!decision.inHourWindow) {
        summary.skippedOutsideWindow += 1;
        continue;
      }

      summary.inWindow += 1;

      // Per-user client-managed suppression (the medication precedent).
      if (
        isMeasurementReminderClientManaged(reminder.user.notificationPrefs)
      ) {
        getEvent()?.addMeta(
          "measurement_reminder.suppressed_client_managed",
          reminder.id,
        );
        summary.skippedClientManaged += 1;
        // Advance past this cycle anyway so a client-managed reminder does
        // not pin the server tick re-evaluating the same overdue slot
        // every 15 minutes for the rest of the day.
        await advanceNextDue(prisma, reminder, timezone, now);
        continue;
      }

      const { title, body } = buildMeasurementReminderPayload(
        reminder.user.locale,
        reminder.label,
        reminder.location,
      );

      const outcome = await dispatchImpl({
        eventType: "MEASUREMENT_REMINDER",
        userId: reminder.user.id,
        title,
        message: body,
        metadata: {
          scheduledAt: now.toISOString(),
          reminderId: reminder.id,
        },
      });

      // No channel succeeded — leave `nextDueAt` where it is so the next
      // tick (or the user's next channel) retries. The reminder simply
      // stays overdue, which the surface already shows as "überfällig".
      if (!outcome.dispatched) {
        summary.skippedNoChannel += 1;
        continue;
      }

      // Dispatch succeeded — advance `nextDueAt` past now so this due
      // cycle never re-fires (the ledger-free dedup guard).
      await advanceNextDue(prisma, reminder, timezone, now);
      summary.dispatched += 1;
    } catch (err: unknown) {
      summary.failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      getEvent()?.addWarning(
        `measurement-reminder per-reminder dispatch failed for ${reminder.id}: ${message}`,
      );
    }
  }

  return summary;
}

/**
 * Advance `nextDueAt` to the next occurrence strictly after `now`. Used
 * after a successful dispatch (and after a client-managed skip) as the
 * ledger-free dedup guard. Does NOT touch `lastSatisfiedAt` — a fired
 * reminder is not "satisfied", it just rolls to its next slot.
 */
async function advanceNextDue(
  prisma: PrismaClient,
  reminder: {
    id: string;
    intervalDays: number | null;
    rrule: string | null;
    anchorDate: Date | null;
    notifyHour: number;
    lastSatisfiedAt: Date | null;
    createdAt: Date;
  },
  timezone: string,
  now: Date,
): Promise<void> {
  // The dedup guard must move the slot strictly forward. For an `rrule`
  // the engine already walks to the next strictly-after-now occurrence,
  // so passing the row as-is is correct. For a ROLLING reminder the
  // engine anchors the first-due slot AT `anchorDate ?? createdAt` when
  // never satisfied, which stays ≤ now and would re-fire every tick — so
  // re-anchor the rolling cadence on `now` (a fire is the rhythm
  // restarting from this dispatch) to roll it forward by exactly one
  // interval. This does NOT advance `lastSatisfiedAt`: a fired reminder
  // is not satisfied, just rescheduled past the slot it nagged on.
  const rolling = reminder.intervalDays !== null;
  const scheduleInput: ReminderScheduleInput = {
    intervalDays: reminder.intervalDays,
    rrule: reminder.rrule,
    anchorDate: reminder.anchorDate,
    notifyHour: reminder.notifyHour,
    lastSatisfiedAt: rolling ? now : reminder.lastSatisfiedAt,
    createdAt: reminder.createdAt,
  };
  const nextDueAt = computeReminderNextDueAt(scheduleInput, timezone, now);
  await prisma.measurementReminder.update({
    where: { id: reminder.id },
    data: { nextDueAt },
  });
}
