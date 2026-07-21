/**
 * Fork ADHS Stage B.2 — medication effect-window check-in reminder.
 *
 * Stage B added the daily guided check-in (side effects + target symptoms) for
 * medications that have a drug profile. A check-in nobody is reminded to do is
 * half a feature — this cron nudges the user to open it, timed to the drug's
 * EFFECT WINDOW rather than a fixed clock hour: a while after the morning
 * intake (is it working + early side effects) and again in the afternoon (the
 * rebound). Both offsets come from the drug profile's `effectWindow`, so the
 * timing is content-driven per drug.
 *
 * Mirrors the mood-reminder shape exactly: the cron fires every 15 minutes and
 * this module short-circuits unless `now` lands in a medication's window, so
 * one cron entry serves every IANA timezone. Idempotency is the
 * `MedicationCheckinReminderDispatch` ledger — the
 * `(userId, medicationId, date, window)` unique guarantees each window fires at
 * most once per local day even across a re-tick or a parallel worker.
 *
 * Strictly a nudge to DOCUMENT: the push links to the check-in surface and
 * never names a dose or carries a suggestion (CLAUDE.md §1). Opt-in is
 * `notificationPrefs.medicationCheckin.enabled` (default OFF) AND the per-event
 * default is OFF, so the user opts in before the server ever nudges.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import type { MedicationCategory } from "@/generated/prisma/client";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import type { Locale } from "@/lib/i18n/config";
import { defaultLocale, locales } from "@/lib/i18n/config";
import { wallClockInTz } from "@/lib/tz/wall-clock";
import { localHmAsUtc } from "@/lib/tz/local-day";
import { dispatchNotification } from "@/lib/notifications/dispatcher";
import { getEvent } from "@/lib/logging/context";
import { isMedicationCheckinReminderEnabled } from "@/lib/validations/notification-prefs";
import {
  profileForTreatmentClass,
  profiledTreatmentClasses,
} from "@/lib/medications/profiles/registry";

/** The two effect-window slots the reminder nudges. */
export type CheckinReminderWindow = "EFFECT" | "REBOUND";

/** Cron cadence — a window fires only inside the tick that covers its target. */
export const CHECKIN_REMINDER_TICK_MS = 15 * 60 * 1000;

export interface MedicationCheckinReminderSummary {
  medicationsScanned: number;
  windowsInWindow: number;
  dispatched: number;
  skippedNotOptedIn: number;
  skippedNoProfileWindow: number;
  skippedNoIntakeTime: number;
  skippedAlreadyDispatched: number;
  skippedNoChannel: number;
  failed: number;
}

function resolveLocale(locale: string | null | undefined): Locale {
  return locales.includes(locale as Locale)
    ? (locale as Locale)
    : defaultLocale;
}

/** Parse an `HH:mm` string to minutes-since-midnight, or null if malformed. */
function parseHmToMinutes(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/**
 * The earliest daily intake time (minutes since local midnight) across a
 * medication's schedules — the anchor the effect window offsets add onto.
 * Prefers the first-class `timesOfDay` list; falls back to `windowStart`.
 * Returns null when no schedule carries a clock time (e.g. pure PRN).
 */
export function earliestIntakeMinutes(
  schedules: readonly {
    timesOfDay?: string[] | null;
    windowStart?: string | null;
  }[],
): number | null {
  let earliest: number | null = null;
  for (const s of schedules) {
    const candidates: (number | null)[] = [];
    for (const t of s.timesOfDay ?? []) candidates.push(parseHmToMinutes(t));
    if (!(s.timesOfDay && s.timesOfDay.length)) {
      candidates.push(parseHmToMinutes(s.windowStart));
    }
    for (const c of candidates) {
      if (c === null) continue;
      if (earliest === null || c < earliest) earliest = c;
    }
  }
  return earliest;
}

function isoDateInTz(instant: Date, tz: string): string {
  const p = wallClockInTz(instant, tz || "Europe/Berlin");
  return `${p.year.toString().padStart(4, "0")}-${p.month
    .toString()
    .padStart(2, "0")}-${p.day.toString().padStart(2, "0")}`;
}

/**
 * Pure decision predicate: does the effect-window `offsetHours` after the
 * `intakeMinutes` slot fall inside the current cron tick?
 *
 * Anchors on the slot's DST-safe UTC instant for the local day of `now`
 * (`localHmAsUtc`), adds the offset, and fires when `now` is in
 * `[target, target + tickMs)`. `localDate` is derived from the TARGET instant
 * so the dedup ledger keys the day the window actually belongs to. Pulled out
 * so the boundary contract is unit-testable without a DB.
 */
export function evaluateCheckinWindow(params: {
  tz: string;
  intakeMinutes: number;
  offsetHours: number;
  now: Date;
  tickMs?: number;
}): { fire: boolean; localDate: string | null } {
  const tickMs = params.tickMs ?? CHECKIN_REMINDER_TICK_MS;
  const tz = params.tz || "Europe/Berlin";
  const slotInstant = localHmAsUtc(
    params.now,
    tz,
    Math.floor(params.intakeMinutes / 60),
    params.intakeMinutes % 60,
  );
  const target = new Date(
    slotInstant.getTime() + params.offsetHours * 60 * 60 * 1000,
  );
  const diff = params.now.getTime() - target.getTime();
  const fire = diff >= 0 && diff < tickMs;
  return { fire, localDate: fire ? isoDateInTz(target, tz) : null };
}

/**
 * Localised push copy for a window. Split out so a template change doesn't
 * require re-running the whole tick in tests.
 */
export function buildCheckinReminderPayload(
  locale: string | null | undefined,
  window: CheckinReminderWindow,
): { title: string; body: string } {
  const t = getServerTranslator(resolveLocale(locale)).t;
  return window === "EFFECT"
    ? {
        title: t("medicationCheckinReminders.effectTitle"),
        body: t("medicationCheckinReminders.effectBody"),
      }
    : {
        title: t("medicationCheckinReminders.reboundTitle"),
        body: t("medicationCheckinReminders.reboundBody"),
      };
}

/**
 * Run one effect-window-reminder cron tick. Scans active, non-PRN medications
 * whose class has a drug profile with an `effectWindow`, and for each of the
 * two windows dispatches a `MEDICATION_CHECKIN_REMINDER` when the user has
 * opted in, the window is live, and the ledger slot is free.
 *
 * The ledger row is written only after the dispatcher confirms a channel
 * delivered, so a transient blip leaves the slot free for the next tick rather
 * than silently nuking the day's nudge (the mood-reminder trade-off). Per-item
 * processing is isolated so one bad row can't abort the tick.
 */
export async function runMedicationCheckinReminderTick(
  prisma: PrismaClient,
  now: Date,
  options: { dispatch?: typeof dispatchNotification } = {},
): Promise<MedicationCheckinReminderSummary> {
  const dispatchImpl = options.dispatch ?? dispatchNotification;

  const summary: MedicationCheckinReminderSummary = {
    medicationsScanned: 0,
    windowsInWindow: 0,
    dispatched: 0,
    skippedNotOptedIn: 0,
    skippedNoProfileWindow: 0,
    skippedNoIntakeTime: 0,
    skippedAlreadyDispatched: 0,
    skippedNoChannel: 0,
    failed: 0,
  };

  const classes = profiledTreatmentClasses();
  if (classes.length === 0) return summary;

  const meds = await prisma.medication.findMany({
    where: {
      active: true,
      asNeeded: false,
      oneShot: false,
      treatmentClass: { in: classes as MedicationCategory[] },
    },
    select: {
      id: true,
      userId: true,
      treatmentClass: true,
      user: {
        select: {
          id: true,
          timezone: true,
          locale: true,
          notificationPrefs: true,
        },
      },
      schedules: { select: { timesOfDay: true, windowStart: true } },
    },
  });

  for (const med of meds) {
    summary.medicationsScanned += 1;
    try {
      if (!isMedicationCheckinReminderEnabled(med.user.notificationPrefs)) {
        summary.skippedNotOptedIn += 1;
        continue;
      }

      const profile = profileForTreatmentClass(med.treatmentClass);
      const effectWindow = profile?.effectWindow;
      if (!effectWindow) {
        summary.skippedNoProfileWindow += 1;
        continue;
      }

      const intakeMinutes = earliestIntakeMinutes(med.schedules);
      if (intakeMinutes === null) {
        summary.skippedNoIntakeTime += 1;
        continue;
      }

      const tz = med.user.timezone || "Europe/Berlin";
      const windows: { key: CheckinReminderWindow; offsetHours: number }[] = [
        { key: "EFFECT", offsetHours: effectWindow.effectOffsetHours },
        { key: "REBOUND", offsetHours: effectWindow.reboundOffsetHours },
      ];

      for (const window of windows) {
        const decision = evaluateCheckinWindow({
          tz,
          intakeMinutes,
          offsetHours: window.offsetHours,
          now,
        });
        if (!decision.fire || !decision.localDate) continue;
        summary.windowsInWindow += 1;

        const existing =
          await prisma.medicationCheckinReminderDispatch.findUnique({
            where: {
              userId_medicationId_date_window: {
                userId: med.userId,
                medicationId: med.id,
                date: decision.localDate,
                window: window.key,
              },
            },
            select: { id: true },
          });
        if (existing) {
          summary.skippedAlreadyDispatched += 1;
          continue;
        }

        const { title, body } = buildCheckinReminderPayload(
          med.user.locale,
          window.key,
        );

        const outcome = await dispatchImpl({
          eventType: "MEDICATION_CHECKIN_REMINDER",
          userId: med.userId,
          title,
          message: body,
          metadata: {
            url: `/medications/${med.id}`,
            medicationId: med.id,
            window: window.key,
            // Per-(medication, window) tag so two windows / two meds don't
            // collapse into one lock-screen notification.
            webPushTag: `medication-checkin-${med.id}-${window.key}`,
            scheduledAt: now.toISOString(),
            localDate: decision.localDate,
          },
        });

        if (!outcome.dispatched) {
          summary.skippedNoChannel += 1;
          continue;
        }

        try {
          await prisma.medicationCheckinReminderDispatch.create({
            data: {
              userId: med.userId,
              medicationId: med.id,
              date: decision.localDate,
              window: window.key,
            },
          });
          summary.dispatched += 1;
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          if (
            message.includes("P2002") ||
            message.includes("Unique constraint")
          ) {
            // Lost a race against a parallel worker that also dispatched —
            // both pushed, one ledger row survives. Count as dispatched.
            summary.dispatched += 1;
          } else {
            throw err;
          }
        }
      }
    } catch (err: unknown) {
      summary.failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      getEvent()?.addWarning(
        `medication-checkin-reminder dispatch failed for med ${med.id}: ${message}`,
      );
    }
  }

  return summary;
}
