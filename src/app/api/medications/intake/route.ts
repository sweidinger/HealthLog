/**
 * Top-level medication-intake aggregator + writer.
 *
 *   GET  /api/medications/intake?scope=today
 *     → array of today's intake events for the user (across medications).
 *
 *   GET  /api/medications/intake?scope=compliance&days=N
 *     → per-day { date, scheduled, taken } for the last N days.
 *
 *   POST /api/medications/intake
 *     Body: { intakeId, status: "taken" | "skipped" | "snoozed", takenAt?, snoozedUntil? }
 *     Updates the named MedicationIntakeEvent and returns the updated row.
 */
import { NextRequest } from "next/server";
import { z } from "zod/v4";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { userDayKey, DEFAULT_TIMEZONE } from "@/lib/tz/resolver";
import { cached, caches, type ServerCache } from "@/lib/cache/server-cache";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import { recomputeMedicationComplianceForEvent } from "@/lib/rollups/medication-compliance-rollups";
import {
  buildComplianceMedicationContext,
  expectedSlotCountForDay,
  lastNonSkippedTakenAt,
} from "@/lib/analytics/compliance";
import { getUserTodayBounds } from "@/lib/tz/local-day";
import { projectTodayIntakesAndRecompute } from "@/lib/medications/scheduling/project-today-intakes";
import {
  applyCanonicalSlotWrite,
  resolveForcedSlotForWrite,
  resolveSlotForWriteByBand,
} from "@/lib/medications/scheduling/slot-upsert";
import { resolveInjectionSiteForWrite } from "@/lib/medications/injection-site-write";
import {
  injectionSiteEnum,
  type InjectionSiteValue,
} from "@/lib/validations/medication";

const querySchema = z.object({
  scope: z.enum(["today", "compliance"]),
  days: z.coerce.number().int().min(1).max(365).optional().default(30),
});

const updateSchema = z.object({
  intakeId: z.string().min(1),
  status: z.enum(["taken", "skipped", "snoozed"]),
  takenAt: z.iso
    .datetime({ offset: true })
    .transform((s) => new Date(s))
    .optional(),
  snoozedUntil: z.iso
    .datetime({ offset: true })
    .transform((s) => new Date(s))
    .optional(),
  // v1.8.5 — optional injection site captured alongside a "taken"
  // status toggle. Validated server-side against the medication's
  // effective allowed set; ignored for skipped / snoozed.
  injectionSite: injectionSiteEnum.optional(),
  // v1.15.18 — late-take "attribute anyway" pin. When a "taken" toggle lands
  // outside every dose window the UI can offer to pin the take onto a chosen
  // real slot ("diesem Slot zuordnen?"); the server validates the instant is
  // a real slot of the medication (422 otherwise). Ignored for skip / snooze.
  forceSlotInstant: z.iso
    .datetime({ offset: true })
    .transform((s) => new Date(s))
    .optional(),
});

function startOfDayInTz(date: Date, tz: string): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const d = parts.find((p) => p.type === "day")?.value ?? "01";
  return new Date(`${y}-${m}-${d}T00:00:00.000Z`);
}

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const parsed = querySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!parsed.success) {
    // v1.4.43 W6 — multi-issue 422 + audit breadcrumb keyed
    // `medications.intake.list.validation-failed`.
    const issues = sanitiseZodIssues(parsed.error.issues);
    annotate({
      action: { name: "medications.intake.list.validation-failed" },
      meta: { issue_count: issues.length },
    });
    // v1.4.49 — strip `message` from the audit-ledger row; iOS-sent
    // query strings can flow into Zod issue messages.
    const auditIssues = sanitiseZodIssues(parsed.error.issues, {
      stripValuesFromMessage: true,
    });
    prisma.auditLog
      .create({
        data: {
          userId: user.id,
          action: "medications.intake.list.validation-failed",
          details: JSON.stringify({ issues: auditIssues }),
        },
      })
      .catch(() => {
        /* swallow — 422 response is the contract */
      });
    return returnAllZodIssues(parsed.error, 422);
  }

  const { scope, days } = parsed.data;

  // v1.4.25 W7b — anchor "today" and per-day compliance buckets to the
  // user's display timezone so a 23:30 reading in Pacific/Auckland lands
  // in today's bucket rather than yesterday's Berlin one.
  const userTz = user.timezone ?? DEFAULT_TIMEZONE;

  if (scope === "today") {
    const todayStart = startOfDayInTz(new Date(), userTz);
    const todayEnd = new Date(todayStart.getTime() + 86_400_000);

    // v1.4.39 W-SERVER-FIX — project pending intake rows for every
    // active schedule whose window opens today, then idempotently
    // backfill any missing rows. Pre-fix the endpoint returned `[]`
    // for daily meds (`schedule.daysOfWeek = null` in the DB) until
    // the reminder worker entered the RED phase at the end of the
    // dose window — leaving the iOS Dashboard tile + the "Erfassen"
    // sheet empty for the whole morning. Shared helper mirrors the
    // dashboard-summary call site so the two routes converge on the
    // same row set.
    const { projected, backfilled } = await projectTodayIntakesAndRecompute({
      userId: user.id,
      userTz,
      todayStart,
      todayEnd,
    });

    const events = await prisma.medicationIntakeEvent.findMany({
      where: {
        userId: user.id,
        // v1.7.0 sync — exclude tombstoned rows from the today list.
        deletedAt: null,
        scheduledFor: { gte: todayStart, lt: todayEnd },
      },
      orderBy: { scheduledFor: "asc" },
      include: { medication: { select: { id: true, snoozedUntil: true } } },
    });

    annotate({
      action: { name: "medications.intake.today" },
      meta: {
        count: events.length,
        projected,
        backfilled,
      },
    });

    return apiSuccess(
      events.map((e) => ({
        id: e.id,
        medicationId: e.medicationId,
        scheduledAt: e.scheduledFor.toISOString(),
        takenAt: e.takenAt?.toISOString() ?? null,
        status: e.skipped
          ? "skipped"
          : e.takenAt
            ? "taken"
            : // v1.15.9 — a never-acted dose the auto-miss cron flipped is a
              // terminal MISS, not a perpetual "pending". (Today's freshly
              // projected rows are < 24 h old so this rarely fires here, but
              // a stale row surfacing in the window reads honestly.)
              e.autoMissed
              ? "missed"
              : e.medication.snoozedUntil &&
                  e.medication.snoozedUntil > new Date()
                ? "snoozed"
                : "pending",
        snoozedUntil: e.medication.snoozedUntil?.toISOString() ?? null,
      })),
    );
  }

  // v1.4.34 IW-G — compliance: per-day scheduled vs taken for the last
  // N days. Cached at a 15-minute TTL because daily compliance buckets
  // are slow-moving (intake events trickle in, yesterday's row doesn't
  // move). Cache key carries the userTz so a user who changes timezone
  // doesn't read another tz's bucketing.
  //
  // v1.15.9 — `scheduled` is now the SCHEDULE-ANCHORED expected-dose count
  // per day (the canonical recurrence engine), NOT the count of logged
  // intake rows. The old rollup-backed path set `scheduled = COUNT(*)` of
  // intake rows, so the dashboard tile's rate (`taken / scheduled`) was ~100%
  // across every window regardless of real adherence — every logged row was
  // both numerator and denominator. Anchoring `scheduled` to the schedule
  // makes the rate genuinely reflect taken-of-expected and lets the 7/30/90
  // windows diverge with partial adherence.
  const result = await cached(
    caches.medicationsIntake as ServerCache<ComplianceBucket[]>,
    `${user.id}|compliance|${days}|${userTz}`,
    () => buildScheduleAnchoredComplianceBuckets(user.id, days, userTz),
    annotate,
  );

  annotate({
    action: { name: "medications.intake.compliance" },
    meta: { days, count: result.length },
  });

  return apiSuccess(result);
});

interface ComplianceBucket {
  date: string;
  scheduled: number;
  taken: number;
}

/**
 * v1.15.9 — schedule-anchored per-day compliance buckets for the dashboard
 * tile. Replaces the rollup/legacy path whose `scheduled` was the count of
 * logged intake rows (BUG #1: rate `taken / scheduled` ≈ 100% across every
 * window because every logged row was both numerator and denominator).
 *
 * `scheduled` is now the canonical recurrence engine's expected-dose count
 * for the day, summed across the user's active medications, so days the
 * schedule expected a dose that the user missed pull the rate down — and the
 * 7/30/90 windows genuinely diverge with partial adherence. `taken` stays the
 * count of taken (non-skipped, non-auto-missed) doses that day, capped at the
 * day's expected count so a duplicate log can't push a day above 100%.
 *
 * Pure-ish over a single pinned `now` so a 15-minute cached row is internally
 * consistent. Bounded: one active-medications query + one window-events query,
 * then per-medication-per-day engine expansion over the trailing window.
 */
async function buildScheduleAnchoredComplianceBuckets(
  userId: string,
  days: number,
  userTz: string,
): Promise<ComplianceBucket[]> {
  const now = new Date();
  const nowMs = now.getTime();
  const start = new Date(nowMs - days * 86_400_000);

  const medications = await prisma.medication.findMany({
    where: { userId, active: true },
    include: {
      schedules: true,
      // v1.16.3 — archived schedule eras for era-aware expected counts.
      scheduleRevisions: { orderBy: { validFrom: "asc" } },
    },
  });

  const events = await prisma.medicationIntakeEvent.findMany({
    // v1.7.0 sync — exclude tombstoned rows from the compliance buckets.
    where: { userId, deletedAt: null, scheduledFor: { gte: start } },
    select: {
      medicationId: true,
      scheduledFor: true,
      takenAt: true,
      skipped: true,
      autoMissed: true,
    },
  });

  // Pre-compute each local day's [start, end) bounds + key, oldest → newest.
  const dayKeys: string[] = [];
  const dayBounds = new Map<string, { start: Date; end: Date }>();
  for (let i = days - 1; i >= 0; i--) {
    const representative = new Date(
      nowMs - i * 86_400_000 - 12 * 60 * 60 * 1000,
    );
    const { start: dayStart, end: dayEndInclusive } = getUserTodayBounds(
      representative,
      userTz,
    );
    const key = userDayKey(dayStart, userTz);
    if (dayBounds.has(key)) continue;
    dayKeys.push(key);
    dayBounds.set(key, {
      start: dayStart,
      end: new Date(dayEndInclusive.getTime() + 1), // half-open [start, end)
    });
  }

  const totals = new Map<string, { scheduled: number; taken: number }>();
  for (const key of dayKeys) totals.set(key, { scheduled: 0, taken: 0 });

  // Group events by medication so each med's engine context is built once.
  const eventsByMed = new Map<
    string,
    {
      scheduledFor: Date;
      takenAt: Date | null;
      skipped: boolean;
      autoMissed: boolean;
    }[]
  >();
  for (const e of events) {
    const list = eventsByMed.get(e.medicationId) ?? [];
    list.push({
      scheduledFor: e.scheduledFor,
      takenAt: e.takenAt,
      skipped: e.skipped,
      autoMissed: e.autoMissed,
    });
    eventsByMed.set(e.medicationId, list);
  }

  for (const med of medications) {
    if (med.schedules.length === 0) continue;
    const medEvents = eventsByMed.get(med.id) ?? [];
    const ctx = buildComplianceMedicationContext(
      med,
      lastNonSkippedTakenAt(medEvents),
      userTz,
    );

    for (const key of dayKeys) {
      const bounds = dayBounds.get(key)!;
      // Skip days before the medication existed so a young med doesn't paint
      // missed-denominator days it could not have been dosed on.
      if (bounds.end <= med.createdAt) continue;

      const scheduled = expectedSlotCountForDay(
        med.schedules,
        bounds.start,
        bounds.end,
        ctx,
        medEvents,
      );
      if (scheduled === 0) continue;

      // Taken doses that landed in this day's window (non-skipped, non-auto-
      // missed), capped at the expected count so a duplicate log can't push a
      // single day above 100%.
      const takenThisDay = medEvents.filter(
        (e) =>
          e.takenAt !== null &&
          !e.skipped &&
          !e.autoMissed &&
          e.scheduledFor >= bounds.start &&
          e.scheduledFor < bounds.end,
      ).length;

      const bucket = totals.get(key)!;
      bucket.scheduled += scheduled;
      bucket.taken += Math.min(takenThisDay, scheduled);
    }
  }

  return dayKeys
    .map((date) => {
      const v = totals.get(date)!;
      return { date, scheduled: v.scheduled, taken: v.taken };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const { data: body, error } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });
  if (error) return error;

  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    // v1.4.43 W6 — intake-event update hot path; multi-issue 422 +
    // audit breadcrumb keyed `medications.intake.update.validation-failed`.
    const issues = sanitiseZodIssues(parsed.error.issues);
    annotate({
      action: { name: "medications.intake.update.validation-failed" },
      meta: { issue_count: issues.length },
    });
    // v1.4.49 — strip `message` from the audit-ledger row.
    const auditIssues = sanitiseZodIssues(parsed.error.issues, {
      stripValuesFromMessage: true,
    });
    prisma.auditLog
      .create({
        data: {
          userId: user.id,
          action: "medications.intake.update.validation-failed",
          details: JSON.stringify({ issues: auditIssues }),
        },
      })
      .catch(() => {
        /* swallow — 422 response is the contract */
      });
    return returnAllZodIssues(parsed.error, 422);
  }

  const {
    intakeId,
    status,
    takenAt,
    snoozedUntil,
    injectionSite,
    forceSlotInstant,
  } = parsed.data;

  // v1.7.0 sync — a tombstoned intake 404s on a status toggle; the
  // `deletedAt: null` filter refuses to mutate a soft-deleted row.
  const existing = await prisma.medicationIntakeEvent.findFirst({
    where: { id: intakeId, deletedAt: null },
    include: {
      medication: {
        select: {
          deliveryForm: true,
          trackInjectionSites: true,
          allowedInjectionSites: true,
        },
      },
    },
  });
  if (!existing || existing.userId !== user.id) {
    return apiError("Intake event not found", 404);
  }

  // v1.8.5 — resolve + server-validate the optional injection site for a
  // "taken" toggle. A site outside the medication's effective allowed
  // set is a hard 422; non-injection / tracking-off / non-taken drops it.
  let resolvedInjectionSite: InjectionSiteValue | null = null;
  if (injectionSite !== undefined) {
    const userRow = await prisma.user.findUnique({
      where: { id: user.id },
      select: { globalExcludedInjectionSites: true },
    });
    const resolution = resolveInjectionSiteForWrite({
      submitted: injectionSite,
      taken: status === "taken",
      deliveryForm: existing.medication.deliveryForm,
      trackInjectionSites: existing.medication.trackInjectionSites,
      allowedInjectionSites: existing.medication
        .allowedInjectionSites as InjectionSiteValue[],
      globalExcludedInjectionSites: (userRow?.globalExcludedInjectionSites ??
        []) as InjectionSiteValue[],
    });
    if (resolution.kind === "disallowed") {
      annotate({
        action: { name: "medication.intake.injection_site.disallowed" },
        meta: { medication_id: existing.medicationId, site: resolution.site },
      });
      return apiError(
        "Injection site is not allowed for this medication",
        422,
        {
          errorCode: "medications.intake.injection_site.disallowed",
        },
      );
    }
    resolvedInjectionSite = resolution.site;
  }

  const userTzForHook = user.timezone ?? DEFAULT_TIMEZONE;

  let updated;
  if (status === "taken") {
    const resolvedTakenAt = takenAt ?? new Date();

    // v1.15.18 — re-run window-band attribution on a taken toggle so an
    // edited / off-window take re-binds to the right slot instead of leaving
    // `scheduledFor` stale (audit HIGH-4). `forceSlotInstant` pins onto a
    // named real slot (422 if it is not one); otherwise band membership picks
    // the slot (the take's own time on a miss → ad-hoc). Mirrors the
    // per-event PUT route.
    let targetScheduledFor: Date;
    if (forceSlotInstant !== undefined) {
      const forced = await resolveForcedSlotForWrite({
        userId: user.id,
        medicationId: existing.medicationId,
        userTz: userTzForHook,
        slotInstant: forceSlotInstant,
      });
      if (forced === null) {
        annotate({
          action: { name: "medication.intake.force_slot.invalid" },
          meta: { medication_id: existing.medicationId, intake_id: intakeId },
        });
        return apiError(
          "forceSlotInstant is not a scheduled slot of this medication",
          422,
          { errorCode: "medications.intake.force_slot.invalid" },
        );
      }
      targetScheduledFor = forced;
    } else {
      const attribution = await resolveSlotForWriteByBand({
        userId: user.id,
        medicationId: existing.medicationId,
        userTz: userTzForHook,
        takenAt: resolvedTakenAt,
      });
      targetScheduledFor = attribution.slotInstant ?? resolvedTakenAt;
    }

    const slotMoved =
      targetScheduledFor.getTime() !== existing.scheduledFor.getTime();

    if (!slotMoved) {
      [updated] = await prisma.$transaction([
        prisma.medicationIntakeEvent.update({
          where: { id: intakeId },
          // v1.7.0 sync — bump the reconciliation counter on every
          // server-side mutation so the delta feed echoes a monotonic value.
          data: {
            takenAt: resolvedTakenAt,
            skipped: false,
            syncVersion: { increment: 1 },
            // v1.8.5 — persist the resolved site on the taken branch.
            ...(resolvedInjectionSite !== null && {
              injectionSite: resolvedInjectionSite,
            }),
          },
        }),
        prisma.medication.update({
          where: { id: existing.medicationId },
          data: { snoozedUntil: null },
        }),
      ]);
    } else {
      // The take re-attributed to a different slot. Tombstone the source row
      // and route the dose through the shared canonical-slot upsert, which
      // converges onto any row already at the target slot rather than
      // bare-updating into an occupied slot (P2002-safe).
      await prisma.medicationIntakeEvent.update({
        where: { id: intakeId },
        data: { deletedAt: new Date(), syncVersion: { increment: 1 } },
      });
      const applied = await applyCanonicalSlotWrite({
        client: prisma,
        userId: user.id,
        medicationId: existing.medicationId,
        canonicalSlot: targetScheduledFor,
        takenAt: resolvedTakenAt,
        skipped: false,
        isExplicitTaken: true,
        isExplicitSkip: false,
        idempotencyKey: null,
        createSource: "WEB",
        injectionSite: resolvedInjectionSite,
      });
      updated = applied.row;
      await prisma.medication.update({
        where: { id: existing.medicationId },
        data: { snoozedUntil: null },
      });
    }
  } else if (status === "skipped") {
    updated = await prisma.medicationIntakeEvent.update({
      where: { id: intakeId },
      // v1.7.0 sync — bump the reconciliation counter on the skip toggle.
      data: { takenAt: null, skipped: true, syncVersion: { increment: 1 } },
    });
  } else {
    // snoozed: snoozedUntil lives on the Medication row.
    const until = snoozedUntil ?? new Date(Date.now() + 30 * 60_000); // default +30min
    await prisma.medication.update({
      where: { id: existing.medicationId },
      data: { snoozedUntil: until },
    });
    updated = await prisma.medicationIntakeEvent.findUnique({
      where: { id: intakeId },
    });
  }

  await auditLog("medications.intake.update", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { intakeId, status },
  });

  annotate({
    action: { name: "medications.intake.update" },
    meta: { intakeId, status },
  });

  // v1.4.34 IW-G — bust the medications + compliance + achievement
  // caches for this user so the next read reflects the dose change.
  invalidateUserMedications(user.id);

  // v1.4.39 W-MED — refresh the persistent compliance rollup row for
  // the affected day so the next read after the cache miss returns
  // the up-to-date `(scheduled, taken, skipped)` tuple. Best-effort:
  // a populator failure annotates ops without blocking the response.
  await recomputeMedicationComplianceForEvent({
    userId: user.id,
    medicationId: existing.medicationId,
    scheduledFor: existing.scheduledFor,
    tz: userTzForHook,
  });

  return apiSuccess(updated);
});
