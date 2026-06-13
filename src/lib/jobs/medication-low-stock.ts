/**
 * v1.16.11 — medication low-stock notifications (one engine, every
 * tracked medication).
 *
 * Generalises the GLP-1-only low-stock surface (the fixed 4-dose
 * `lowStock` flag the GLP-1 details endpoint computes for its card)
 * into one daily pass over EVERY medication with tracked inventory.
 * The GLP-1 case needs nothing special here: its weekly schedule flows
 * through the same runway math as any other cadence — the card flag
 * stays as the locked iOS read-model, the notification is this engine.
 *
 * Trigger: a medication qualifies when it has tracked inventory (at
 * least one container ever registered — the list payload's
 * `stockUnitsRemaining` non-null predicate) AND its projected runway
 * in days falls strictly below the user's threshold. Runway reuses the
 * shared math verbatim:
 *   - available units: `summariseSupply` (ACTIVE / IN_USE with units
 *     left; EXPIRED visible but never available),
 *   - daily consumption: `estimateDailyDoseCount` over the schedules
 *     (the detail Übersicht's `estimateRunwayDays` source),
 * so the push can never disagree with the detail page's "lasts about
 * N more days" line. A medication whose schedules derive no daily
 * consumption (none, or zero times) has NO runway and never notifies.
 *
 * Threshold: per-user `notificationPrefs.medication.lowStockRunwayDays`
 * (1–60 days, default 7, `null` = off) — surfaced on
 * `GET /api/settings/reminder-thresholds`, written through
 * `PATCH /api/auth/me/notification-prefs`.
 *
 * Anti-spam: notify ONCE per threshold crossing. The stamp lives on
 * the medication row (`lowStockNotifiedAt` +
 * `lowStockNotifiedThresholdDays`); the pass clears it (re-arms) when
 * the runway rises back to / above the threshold (refill), and a
 * stamped threshold that differs from the current one counts as
 * re-armed so a threshold change is heard. A dispatch that reaches no
 * channel leaves the stamp clear, so tomorrow's tick retries.
 *
 * clientManaged is deliberately NOT consulted: that suppression
 * contract covers reminders a client can schedule locally
 * (MEDICATION_REMINDER dose slots, cycle predictions). Inventory state
 * is server-side only — no client can derive it — so this event
 * follows the COACH_NUDGE posture (server-only, prefs-gated).
 *
 * Inactive / paused medications are skipped: nothing consumes their
 * stock, so their runway is not falling.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import {
  estimateDailyDoseCount,
  estimateRunwayDays,
  type RunwaySchedule,
} from "@/components/medications/detail/supply-runway";
import {
  summariseSupply,
  type SupplyItem,
} from "@/lib/medications/inventory/summary";
import { dispatchNotification } from "@/lib/notifications/dispatcher";
import { resolveLowStockRunwayDays } from "@/lib/validations/notification-prefs";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import type { Locale } from "@/lib/i18n/config";
import { defaultLocale, locales } from "@/lib/i18n/config";
import { annotate, getEvent } from "@/lib/logging/context";

/** Pg-boss queue + cron — imported by the reminder worker's bootstrap. */
export const MEDICATION_LOW_STOCK_QUEUE = "medication-low-stock";
/**
 * 09:00 Europe/Berlin — a supply alert is an errand prompt ("order a
 * refill"), not a night signal; it fires once daily at a time the user
 * can act on it.
 */
export const MEDICATION_LOW_STOCK_CRON = "0 9 * * *";

export interface MedicationLowStockSummary {
  usersScanned: number;
  skippedThresholdOff: number;
  medicationsEvaluated: number;
  notified: number;
  rearmed: number;
  skippedAlreadyNotified: number;
  skippedAboveThreshold: number;
  skippedNoRunway: number;
  skippedNoChannel: number;
  failed: number;
}

export interface LowStockEvaluation {
  /** Whole days the available supply covers; null = no runway derivable. */
  runwayDays: number | null;
  dosesRemaining: number;
  unitsRemaining: number;
}

/**
 * Shared runway evaluation: `summariseSupply` availability semantics ÷
 * `estimateDailyDoseCount` consumption. Exported for the unit tests.
 * Zero available doses with a consuming schedule is runway 0 (below
 * every threshold); no consuming schedule is `null` (never notifies).
 */
export function evaluateMedicationRunway(
  items: readonly SupplyItem[],
  unitsPerDose: number,
  schedules: RunwaySchedule[],
): LowStockEvaluation {
  const supply = summariseSupply(items, unitsPerDose);
  const perDay = estimateDailyDoseCount(schedules);
  if (perDay <= 0) {
    return {
      runwayDays: null,
      dosesRemaining: supply.dosesRemaining,
      unitsRemaining: supply.unitsRemaining,
    };
  }
  const runwayDays =
    supply.dosesRemaining > 0
      ? (estimateRunwayDays(supply.dosesRemaining, schedules) ?? 0)
      : 0;
  return {
    runwayDays,
    dosesRemaining: supply.dosesRemaining,
    unitsRemaining: supply.unitsRemaining,
  };
}

export type LowStockDecision =
  | "notify"
  | "rearm"
  | "skip_above_threshold"
  | "skip_already_notified"
  | "skip_no_runway";

/**
 * Pure crossing logic — exported for the unit tests so the boundary /
 * dedupe / re-arm semantics stay pinned without a DB.
 *
 *   runway < threshold  → notify, unless the stamp already records THIS
 *                         threshold's crossing (`skip_already_notified`).
 *                         A stamp written against a DIFFERENT threshold
 *                         counts as re-armed and notifies again.
 *   runway ≥ threshold  → re-arm (clear the stamp) when one is set;
 *                         otherwise nothing to do.
 *   runway null         → no runway derivable (schedule-less) — never
 *                         notifies, stamp untouched.
 */
export function decideLowStockAction(input: {
  runwayDays: number | null;
  thresholdDays: number;
  notifiedAt: Date | null;
  notifiedThresholdDays: number | null;
}): LowStockDecision {
  if (input.runwayDays === null) return "skip_no_runway";
  if (input.runwayDays >= input.thresholdDays) {
    return input.notifiedAt !== null ? "rearm" : "skip_above_threshold";
  }
  if (
    input.notifiedAt !== null &&
    input.notifiedThresholdDays === input.thresholdDays
  ) {
    return "skip_already_notified";
  }
  return "notify";
}

function resolveLocale(locale: string | null | undefined): Locale {
  return locales.includes(locale as Locale)
    ? (locale as Locale)
    : defaultLocale;
}

/**
 * Localised push copy: factual, names the medication and the remaining
 * days / units. Runway 0 gets its own line — "about 0 more days" reads
 * broken in every locale.
 */
export function buildLowStockPayload(
  locale: string | null | undefined,
  medName: string,
  runwayDays: number,
  unitsRemaining: number,
): { title: string; body: string } {
  const t = getServerTranslator(resolveLocale(locale)).t;
  return {
    title: t("lowStockReminders.title", { medName }),
    body:
      runwayDays >= 1
        ? t("lowStockReminders.body", {
            medName,
            days: runwayDays,
            units: unitsRemaining,
          })
        : t("lowStockReminders.bodyToday", {
            medName,
            units: unitsRemaining,
          }),
  };
}

/** Pinned wide-event meta shape for `.notified` / `.skipped` entries. */
interface LowStockEventMeta {
  user_id: string;
  medication_id: string;
  runway_days: number | null;
  threshold_days: number;
  doses_remaining: number;
  units_remaining: number;
  reason?: "already_notified" | "no_runway" | "no_channel";
}

/**
 * Run one medication-low-stock cron tick. Per-user work is wrapped in
 * its own try/catch so a single bad row cannot abort the rest of the
 * pass (the coach-nudge posture).
 */
export async function runMedicationLowStockTick(
  prisma: PrismaClient,
  now: Date,
  options: {
    dispatch?: typeof dispatchNotification;
  } = {},
): Promise<MedicationLowStockSummary> {
  const dispatchImpl = options.dispatch ?? dispatchNotification;

  const summary: MedicationLowStockSummary = {
    usersScanned: 0,
    skippedThresholdOff: 0,
    medicationsEvaluated: 0,
    notified: 0,
    rearmed: 0,
    skippedAlreadyNotified: 0,
    skippedAboveThreshold: 0,
    skippedNoRunway: 0,
    skippedNoChannel: 0,
    failed: 0,
  };

  const notifiedMeta: LowStockEventMeta[] = [];
  const skippedMeta: LowStockEventMeta[] = [];

  // Only users who own at least one ACTIVE, unpaused medication with
  // tracked inventory (any container ever registered) are candidates.
  const users = await prisma.user.findMany({
    where: {
      medications: {
        some: { active: true, pausedAt: null, inventoryItems: { some: {} } },
      },
    },
    select: { id: true, locale: true, notificationPrefs: true },
  });

  for (const user of users) {
    summary.usersScanned += 1;
    try {
      // Gate — per-user threshold. `null` = the alert is off; the
      // stamps stay as-is and the threshold-change rule re-arms them
      // if the user later re-enables with a different value.
      const thresholdDays = resolveLowStockRunwayDays(user.notificationPrefs);
      if (thresholdDays === null) {
        summary.skippedThresholdOff += 1;
        continue;
      }

      const medications = await prisma.medication.findMany({
        where: {
          userId: user.id,
          active: true,
          pausedAt: null,
          inventoryItems: { some: {} },
        },
        select: {
          id: true,
          name: true,
          unitsPerDose: true,
          lowStockNotifiedAt: true,
          lowStockNotifiedThresholdDays: true,
          inventoryItems: {
            select: { state: true, unitsTotal: true, unitsRemaining: true },
          },
          schedules: {
            select: {
              windowStart: true,
              daysOfWeek: true,
              timesOfDay: true,
              rrule: true,
              rollingIntervalDays: true,
            },
          },
        },
      });

      for (const med of medications) {
        summary.medicationsEvaluated += 1;

        const evaluation = evaluateMedicationRunway(
          // v1.16.12 — Decimal columns → JS numbers for the runway math.
          med.inventoryItems.map((it) => ({
            state: it.state,
            unitsTotal: Number(it.unitsTotal),
            unitsRemaining: Number(it.unitsRemaining),
          })),
          Number(med.unitsPerDose),
          med.schedules,
        );
        const decision = decideLowStockAction({
          runwayDays: evaluation.runwayDays,
          thresholdDays,
          notifiedAt: med.lowStockNotifiedAt,
          notifiedThresholdDays: med.lowStockNotifiedThresholdDays,
        });

        const meta: LowStockEventMeta = {
          user_id: user.id,
          medication_id: med.id,
          runway_days: evaluation.runwayDays,
          threshold_days: thresholdDays,
          doses_remaining: evaluation.dosesRemaining,
          units_remaining: evaluation.unitsRemaining,
        };

        switch (decision) {
          case "skip_no_runway":
            summary.skippedNoRunway += 1;
            skippedMeta.push({ ...meta, reason: "no_runway" });
            break;
          case "skip_above_threshold":
            summary.skippedAboveThreshold += 1;
            break;
          case "skip_already_notified":
            summary.skippedAlreadyNotified += 1;
            skippedMeta.push({ ...meta, reason: "already_notified" });
            break;
          case "rearm":
            await prisma.medication.update({
              where: { id: med.id },
              data: {
                lowStockNotifiedAt: null,
                lowStockNotifiedThresholdDays: null,
              },
            });
            summary.rearmed += 1;
            break;
          case "notify": {
            const { title, body } = buildLowStockPayload(
              user.locale,
              med.name,
              evaluation.runwayDays ?? 0,
              evaluation.unitsRemaining,
            );
            const outcome = await dispatchImpl({
              eventType: "MEDICATION_LOW_STOCK",
              userId: user.id,
              title,
              message: body,
              metadata: {
                scheduledAt: now.toISOString(),
                medicationId: med.id,
                runwayDays: evaluation.runwayDays,
                thresholdDays,
                unitsRemaining: evaluation.unitsRemaining,
                dosesRemaining: evaluation.dosesRemaining,
                // Deep link — the web-push sender threads this into
                // the service-worker payload's click target. Lands on
                // the detail page's Bestand (supply) tab, the surface
                // the alert is about.
                url: `/medications/${med.id}?tab=bestand`,
              },
            });
            if (!outcome.dispatched) {
              // No channel succeeded — leave the stamp clear so the
              // next daily tick retries the crossing.
              summary.skippedNoChannel += 1;
              skippedMeta.push({ ...meta, reason: "no_channel" });
              break;
            }
            await prisma.medication.update({
              where: { id: med.id },
              data: {
                lowStockNotifiedAt: now,
                lowStockNotifiedThresholdDays: thresholdDays,
              },
            });
            summary.notified += 1;
            notifiedMeta.push(meta);
            break;
          }
        }
      }
    } catch (err: unknown) {
      summary.failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      getEvent()?.addWarning(
        `medication-low-stock per-user pass failed for ${user.id}: ${message}`,
      );
    }
  }

  // Wide events — pinned meta shape (see `LowStockEventMeta`), one
  // entry per medication, emitted once per tick.
  if (notifiedMeta.length > 0) {
    annotate({
      meta: { "medication.inventory.low_stock.notified": notifiedMeta },
    });
  }
  if (skippedMeta.length > 0) {
    annotate({
      meta: { "medication.inventory.low_stock.skipped": skippedMeta },
    });
  }

  return summary;
}
