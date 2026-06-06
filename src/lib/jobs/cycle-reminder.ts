/**
 * v1.15 — cycle reminder dispatcher (period-soon + period-start-confirm).
 *
 * Mirrors `mood-reminder.ts` and the medication-reminder cron: a cron tick
 * fires every 15 minutes, and when it lands inside the user's reminder hour
 * in their local timezone this module scans every cycle-enabled user with a
 * cached `CyclePrediction`, decides who is in-window, and dispatches at most
 * one push per event per local day through the existing
 * APNs → Telegram → ntfy → Web-Push cascade (`dispatchNotification`), which
 * records every attempt in `push_attempts`.
 *
 * Two events, both default-OFF and gated TWICE (per-event default + the
 * `CycleProfile.cycleTrackingEnabled` flag):
 *
 *   - CYCLE_PERIOD_SOON   — a couple of days before the predicted next-period
 *                           start (`PERIOD_SOON_LEAD_DAYS`).
 *   - CYCLE_PERIOD_CONFIRM — a gentle "did your period start?" on/after the
 *                           predicted start while no observed cycle is logged,
 *                           for up to `PERIOD_CONFIRM_GRACE_DAYS`.
 *
 * Two suppression rules ride on top of the dispatcher cascade:
 *
 *   - `notificationPrefs.cycle.clientManaged` — when true, iOS owns the local
 *     reminders, so the server skips its push and emits a
 *     `cycle_reminder.suppressed_client_managed` wide-event annotation (the
 *     medication `clientManaged` precedent).
 *   - `CycleProfile.discreetNotifications` — when true, the push body is the
 *     generic "HealthLog reminder" so no cycle event is named on the lock
 *     screen. The decision is made here, where the localised body is composed.
 *
 * Idempotency is anchored on the `push_attempts` ledger itself (no new table):
 * before dispatching, the runner checks whether an `ok` attempt for the same
 * event already landed for the user's local day. The cron worker runs
 * single-flight (`localConcurrency: 1`) so two ticks never race the
 * fire-and-forget ledger write.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import type { Locale } from "@/lib/i18n/config";
import { defaultLocale, locales } from "@/lib/i18n/config";
import { getLocalDateParts, getUserTodayBounds } from "@/lib/timezone";
import { dayDiff } from "@/lib/cycle/day-math";
import { isCycleEnabled } from "@/lib/cycle/gate";
import { dispatchNotification } from "@/lib/notifications/dispatcher";
import type { EventType } from "@/lib/notifications/types";
import { isCycleReminderClientManaged } from "@/lib/validations/notification-prefs";
import { getEvent } from "@/lib/logging/context";

/**
 * Local-time hour (0–23) at which the daily cycle reminder fires. 09:00 is
 * a calm morning slot that does not collide with the medication-reminder
 * hot path (top of the hour) or the mood reminder (22:00). Fixed for v1.15
 * (no per-user override yet); exported so the tests can pin the window.
 */
export const CYCLE_REMINDER_LOCAL_HOUR = 9;

/** Days before the predicted next-period start that PERIOD_SOON fires. */
export const PERIOD_SOON_LEAD_DAYS = 2;

/**
 * Days on/after the predicted next-period start that PERIOD_CONFIRM keeps
 * nudging while no period is logged. Day 0 (the predicted start) through
 * this many days inclusive; after that the runner gives up for the cycle.
 */
export const PERIOD_CONFIRM_GRACE_DAYS = 3;

export type CycleReminderEvent = "CYCLE_PERIOD_SOON" | "CYCLE_PERIOD_CONFIRM";

export interface CycleReminderSummary {
  candidatesScanned: number;
  inWindow: number;
  dispatchedPeriodSoon: number;
  dispatchedPeriodConfirm: number;
  suppressedClientManaged: number;
  suppressedDiscreet: number;
  skippedAlreadyNotified: number;
  skippedNoChannel: number;
  skippedOutsideWindow: number;
  skippedPredictionDisabled: number;
  skippedAlreadyLogged: number;
  failed: number;
}

function resolveLocale(locale: string | null | undefined): Locale {
  return locales.includes(locale as Locale)
    ? (locale as Locale)
    : defaultLocale;
}

function emptySummary(): CycleReminderSummary {
  return {
    candidatesScanned: 0,
    inWindow: 0,
    dispatchedPeriodSoon: 0,
    dispatchedPeriodConfirm: 0,
    suppressedClientManaged: 0,
    suppressedDiscreet: 0,
    skippedAlreadyNotified: 0,
    skippedNoChannel: 0,
    skippedOutsideWindow: 0,
    skippedPredictionDisabled: 0,
    skippedAlreadyLogged: 0,
    failed: 0,
  };
}

/**
 * Compute the user's local `YYYY-MM-DD` date when `now` falls inside the
 * cycle-reminder hour; `null` otherwise (outside the window). Pulled out so
 * the unit tests can pin the boundary (08:59 → null, 09:00 → date,
 * 09:59 → date, 10:00 → null) without a DB.
 */
export function cycleReminderLocalDate(
  now: Date,
  timezone: string,
): string | null {
  const parts = getLocalDateParts(now, timezone || "Europe/Berlin");
  if (parts.hour !== CYCLE_REMINDER_LOCAL_HOUR) return null;
  return `${parts.year.toString().padStart(4, "0")}-${parts.month
    .toString()
    .padStart(2, "0")}-${parts.day.toString().padStart(2, "0")}`;
}

/**
 * Pure decision predicate: given the user's local date and their cached
 * forecast, which cycle reminder (if any) should fire today?
 *
 * Returns the event to dispatch, or `null` to skip. Kept DB-free so the
 * windowing contract is unit-testable in isolation:
 *
 *   - PERIOD_SOON   when `dayDiff(nextPeriodStart, today) === lead` and no
 *     period has already been logged near the prediction.
 *   - PERIOD_CONFIRM when today is on/after the predicted start and within
 *     the grace window AND no observed cycle has been logged yet
 *     (`periodAlreadyLogged === false`).
 *
 * Either nudge is suppressed once a period IS logged near the prediction —
 * an early period makes the "soon" nudge stale and the "confirm" nudge moot.
 */
export function evaluateCycleReminder(
  args: {
    today: string;
    nextPeriodStart: string;
    periodAlreadyLogged: boolean;
  },
  leadDays: number = PERIOD_SOON_LEAD_DAYS,
  graceDays: number = PERIOD_CONFIRM_GRACE_DAYS,
): CycleReminderEvent | null {
  // A logged period near the prediction silences both nudges — the forecast
  // is already confirmed (the cache regenerates to the next cycle shortly).
  if (args.periodAlreadyLogged) return null;

  const daysUntil = dayDiff(args.nextPeriodStart, args.today);

  if (daysUntil === leadDays) {
    return "CYCLE_PERIOD_SOON";
  }

  // On/after the predicted start (daysUntil <= 0), within the grace window
  // → nudge to confirm (the already-logged case returned null above).
  if (daysUntil <= 0 && daysUntil >= -graceDays) {
    return "CYCLE_PERIOD_CONFIRM";
  }

  return null;
}

/**
 * Build the localised title + body for a cycle reminder push. When
 * `discreet` is true, both collapse to the generic "HealthLog reminder"
 * copy so no cycle event is named on the lock screen (the §6.4 discreet
 * mode). Pulled out so a template change is testable without the runner.
 */
export function buildCycleReminderPayload(
  event: CycleReminderEvent,
  locale: string | null | undefined,
  discreet: boolean,
): { title: string; body: string } {
  const t = getServerTranslator(resolveLocale(locale)).t;
  if (discreet) {
    return {
      title: t("cycleReminders.discreetTitle"),
      body: t("cycleReminders.discreetBody"),
    };
  }
  if (event === "CYCLE_PERIOD_SOON") {
    return {
      title: t("cycleReminders.periodSoonTitle"),
      body: t("cycleReminders.periodSoonBody"),
    };
  }
  return {
    title: t("cycleReminders.periodConfirmTitle"),
    body: t("cycleReminders.periodConfirmBody"),
  };
}

/**
 * Has an `ok` push attempt for `event` already landed for the user today
 * (their local day window)? The `push_attempts` ledger doubles as the
 * idempotency anchor so no extra table is needed. Best-effort: a DB error
 * biases toward "not yet notified" so a transient blip never silently nukes
 * the day's nudge (the at-most-once trade the mood reminder also makes).
 */
async function alreadyNotifiedToday(
  prisma: PrismaClient,
  userId: string,
  event: EventType,
  localDayStartUtc: Date,
  localDayEndUtc: Date,
): Promise<boolean> {
  try {
    const row = await prisma.pushAttempt.findFirst({
      where: {
        userId,
        eventType: event,
        result: "ok",
        createdAt: { gte: localDayStartUtc, lt: localDayEndUtc },
      },
      select: { id: true },
    });
    return row !== null;
  } catch {
    return false;
  }
}

/**
 * Run one cycle-reminder cron tick. Iterates every user whose cycle
 * tracking is enabled and who has a cached forecast, checks the local-time
 * window + the prediction window, and dispatches at most one push per event
 * per local day, honouring `clientManaged` and `discreetNotifications`.
 *
 * `dispatch` is injectable so the unit tests exercise the decision +
 * suppression logic without a live dispatcher.
 */
export async function runCycleReminderTick(
  prisma: PrismaClient,
  now: Date,
  options: {
    dispatch?: typeof dispatchNotification;
  } = {},
): Promise<CycleReminderSummary> {
  const dispatchImpl = options.dispatch ?? dispatchNotification;
  const summary = emptySummary();

  // Only users with a cached forecast can be in-window; the join also
  // narrows to the cohort that has logged enough to predict.
  const predictions = await prisma.cyclePrediction.findMany({
    select: {
      userId: true,
      nextPeriodStart: true,
      user: {
        select: {
          id: true,
          gender: true,
          timezone: true,
          locale: true,
          notificationPrefs: true,
          cycleProfile: {
            select: {
              cycleTrackingEnabled: true,
              predictionEnabled: true,
              discreetNotifications: true,
            },
          },
        },
      },
    },
  });

  for (const pred of predictions) {
    summary.candidatesScanned += 1;
    const user = pred.user;
    try {
      const profile = user.cycleProfile;

      // Gate ENTIRELY on cycle tracking being enabled (gender-derived or
      // explicit opt-in) — a disabled account never receives a cycle push.
      if (!isCycleEnabled(user.gender, profile)) {
        summary.skippedOutsideWindow += 1;
        continue;
      }

      // No predictions when the user opted out of algorithmic interpretation.
      if (profile && profile.predictionEnabled === false) {
        summary.skippedPredictionDisabled += 1;
        continue;
      }

      const timezone = user.timezone || "Europe/Berlin";
      const today = cycleReminderLocalDate(now, timezone);
      if (!today) {
        summary.skippedOutsideWindow += 1;
        continue;
      }

      summary.inWindow += 1;

      // Has the user already logged an observed (non-predicted) cycle
      // starting on/around the predicted day? If so, the confirm nudge is
      // moot. We look for any observed cycle whose start is within the
      // grace window of the prediction.
      const periodAlreadyLogged = await hasObservedPeriodNearPrediction(
        prisma,
        user.id,
        pred.nextPeriodStart,
      );

      const event = evaluateCycleReminder({
        today,
        nextPeriodStart: pred.nextPeriodStart,
        periodAlreadyLogged,
      });

      if (!event) {
        if (periodAlreadyLogged) summary.skippedAlreadyLogged += 1;
        else summary.skippedOutsideWindow += 1;
        continue;
      }

      // clientManaged suppression — iOS owns the local reminders. Mirror the
      // medication path: skip the server push, emit the annotation.
      if (isCycleReminderClientManaged(user.notificationPrefs)) {
        summary.suppressedClientManaged += 1;
        getEvent()?.addMeta(
          "cycle_reminder_suppressed_client_managed",
          `${event}:${today}`,
        );
        getEvent()?.addMeta("cycle_reminder_suppressed_meta", {
          user_id: user.id,
          event,
          local_date: today,
        });
        continue;
      }

      // Idempotency: one push per event per local day. Compute the local
      // day's UTC bounds for the ledger lookup. `end` is the last
      // millisecond of the day, so add 1 ms to make the range half-open.
      const { start: dayStartUtc, end: dayEndInclusive } = getUserTodayBounds(
        now,
        timezone,
      );
      const seen = await alreadyNotifiedToday(
        prisma,
        user.id,
        event,
        dayStartUtc,
        new Date(dayEndInclusive.getTime() + 1),
      );
      if (seen) {
        summary.skippedAlreadyNotified += 1;
        continue;
      }

      const discreet = profile?.discreetNotifications === true;
      if (discreet) summary.suppressedDiscreet += 1;

      const { title, body } = buildCycleReminderPayload(
        event,
        user.locale,
        discreet,
      );

      const outcome = await dispatchImpl({
        eventType: event,
        userId: user.id,
        title,
        message: body,
        metadata: {
          scheduledAt: now.toISOString(),
          localDate: today,
        },
      });

      if (!outcome.dispatched) {
        summary.skippedNoChannel += 1;
        continue;
      }

      if (event === "CYCLE_PERIOD_SOON") summary.dispatchedPeriodSoon += 1;
      else summary.dispatchedPeriodConfirm += 1;
    } catch (err: unknown) {
      summary.failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      getEvent()?.addWarning(
        `cycle-reminder per-user dispatch failed for ${user.id}: ${message}`,
      );
    }
  }

  return summary;
}

/**
 * Observed (non-predicted, non-deleted) period logged within the grace
 * window of the predicted start? Used to suppress the confirm nudge once
 * the user has logged their period. A query failure biases toward "not
 * logged" so the nudge still fires rather than silently going quiet.
 */
async function hasObservedPeriodNearPrediction(
  prisma: PrismaClient,
  userId: string,
  predictedStart: string,
): Promise<boolean> {
  try {
    const candidates = await prisma.menstrualCycle.findMany({
      where: { userId, isPredicted: false, deletedAt: null },
      select: { startDate: true },
      orderBy: { startDate: "desc" },
      take: 12,
    });
    return candidates.some((c) => {
      const delta = dayDiff(c.startDate, predictedStart);
      return delta >= -PERIOD_CONFIRM_GRACE_DAYS && delta <= PERIOD_SOON_LEAD_DAYS;
    });
  } catch {
    return false;
  }
}
