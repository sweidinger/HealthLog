import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate, getEvent } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { createMedicationSchema } from "@/lib/validations/medication";
import {
  getMedicationCategories,
  setMedicationCategory,
} from "@/lib/medication-category";
import { serializeScheduleRecurrence } from "@/lib/medication-schedule";
import { computeNextDueAt } from "@/lib/medications/scheduling/next-due";
import { getUserTodayBounds } from "@/lib/timezone";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import { cached, caches, type ServerCache } from "@/lib/cache/server-cache";
import { NextRequest } from "next/server";

type MedicationsListResult = Array<Record<string, unknown>>;

async function buildMedicationsList(
  userId: string,
  userTz: string,
): Promise<MedicationsListResult> {
  const { start: todayStartUtc, end: todayEndUtc } = getUserTodayBounds(
    new Date(),
    userTz,
  );

  // v1.15.10 — the slots the user has already acted on near "now", so the
  // next-due search can skip them. A resolved slot is a taken, deliberately
  // skipped, or cron-auto-missed row. Bound the window to [today-start,
  // today-end + 2d] — the next-due lookahead only needs the slots adjacent to
  // now, and a tight window keeps the read cheap. The 60s list cache covers
  // the rest.
  const resolvedWindowEnd = new Date(todayEndUtc.getTime() + 2 * 24 * 60 * 60 * 1000);

  const [medications, latestIntakes, todayEvents, resolvedEvents] =
    await Promise.all([
      prisma.medication.findMany({
        where: { userId },
        include: { schedules: true },
        orderBy: { createdAt: "desc" },
      }),
      prisma.medicationIntakeEvent.groupBy({
        by: ["medicationId"],
        // v1.7.0 sync — exclude tombstoned rows from the last-taken map.
        where: {
          userId,
          deletedAt: null,
          skipped: false,
          takenAt: { not: null },
        },
        _max: { takenAt: true },
      }),
      prisma.medicationIntakeEvent.groupBy({
        by: ["medicationId"],
        // v1.7.0 sync — exclude tombstoned rows from the today-count map.
        where: {
          userId,
          deletedAt: null,
          scheduledFor: { gte: todayStartUtc, lte: todayEndUtc },
        },
        _count: { id: true },
      }),
      prisma.medicationIntakeEvent.findMany({
        where: {
          userId,
          deletedAt: null,
          scheduledFor: { gte: todayStartUtc, lte: resolvedWindowEnd },
          OR: [
            { takenAt: { not: null } },
            { skipped: true },
            { autoMissed: true },
          ],
        },
        select: { medicationId: true, scheduledFor: true },
      }),
    ]);

  const resolvedSlotsByMedId = new Map<string, Date[]>();
  for (const e of resolvedEvents) {
    const list = resolvedSlotsByMedId.get(e.medicationId);
    if (list) list.push(e.scheduledFor);
    else resolvedSlotsByMedId.set(e.medicationId, [e.scheduledFor]);
  }

  const lastTakenAtByMedicationId = Object.fromEntries(
    latestIntakes.map((entry) => [
      entry.medicationId,
      entry._max.takenAt ? entry._max.takenAt.toISOString() : null,
    ]),
  );
  // v1.7.0 SB-SCHED-3 — Date-typed last-intake map for the engine
  // (rolling cadences re-anchor on it). Same groupBy as the ISO map.
  const lastTakenAtDateByMedicationId = Object.fromEntries(
    latestIntakes.map((entry) => [entry.medicationId, entry._max.takenAt]),
  );
  const todayEventCountByMedId = Object.fromEntries(
    todayEvents.map(
      (entry: { medicationId: string; _count: { id: number } }) => [
        entry.medicationId,
        entry._count.id,
      ],
    ),
  );

  let categoryMap: Record<string, string> = {};
  try {
    categoryMap = await getMedicationCategories(medications.map((m) => m.id));
  } catch {
    getEvent()?.addWarning("Medication categories could not be loaded");
  }

  // v1.7.0 SB-SCHED-3 — server-computed next due instant. Time-derived;
  // the list GET is cached 60 s on userId, so a 60 s staleness window is
  // accepted here as it already is for `todayEventCount`.
  const now = new Date();

  return medications.map((m) => {
    const nextDue = computeNextDueAt({
      medication: {
        id: m.id,
        startsOn: m.startsOn,
        endsOn: m.endsOn,
        oneShot: m.oneShot,
        createdAt: m.createdAt,
      },
      schedules: m.schedules,
      now,
      userTz,
      lastIntakeAt: lastTakenAtDateByMedicationId[m.id] ?? null,
      resolvedSlots: resolvedSlotsByMedId.get(m.id) ?? [],
    });
    return {
      ...m,
      category: categoryMap[m.id] ?? "OTHER",
      lastTakenAt: lastTakenAtByMedicationId[m.id] ?? null,
      todayEventCount: todayEventCountByMedId[m.id] ?? 0,
      nextDueAt: nextDue ? nextDue.toISOString() : null,
    };
  });
}

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();

  const userTz = user.timezone || "Europe/Berlin";

  // Cache the list shape on userId. The 60s TTL bounds the cross-midnight
  // staleness window for `todayEventCount` (the only time-of-day-derived
  // field in the response); writes via POST/PUT/DELETE flush through
  // `invalidateUserMedications` before the next read lands.
  const result = await cached(
    caches.medications as ServerCache<MedicationsListResult>,
    user.id,
    () => buildMedicationsList(user.id, userTz),
    annotate,
  );

  annotate({
    action: { name: "medication.list" },
    meta: { count: result.length },
  });

  return apiSuccess(result);
});

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const { data: body, error: jsonError } = await safeJson(request);

  if (jsonError) return jsonError;
  const parsed = createMedicationSchema.safeParse(body);
  if (!parsed.success) {
    // v1.4.43 W6 — multi-issue 422.
    return returnAllZodIssues(parsed.error, 422);
  }

  const {
    name,
    dose,
    category,
    treatmentClass,
    dosesPerUnit,
    deliveryForm,
    trackInjectionSites,
    allowedInjectionSites,
    notificationsEnabled,
    liveActivityEnabled,
    criticalAlarmEnabled,
    atcCode,
    rxNormCode,
    schedules,
    startsOn,
    endsOn,
    oneShot,
  } = parsed.data;

  // ── v1.5 route invariants for the new scheduling primitives ───────
  //
  // The Zod layer already enforces `rrule` xor `rollingIntervalDays`
  // (scheduleSchema.refine). The route layer enforces the cross-field
  // invariants that span medication + schedules:
  //
  //   1. **One-shot consistency** — when `oneShot === true`:
  //      a. The medication has at most ONE schedule.
  //      b. The single schedule carries neither `rrule` nor
  //         `rollingIntervalDays` (a one-shot dose IS the schedule).
  //      c. `endsOn` is normalised to equal `startsOn` on write so the
  //         worker's date-range cap matches the one-and-only slot.
  //
  //   2. **Recurring default** — when `oneShot !== true` AND the
  //      schedule has no `rrule`, no `rollingIntervalDays`, and no
  //      legacy `daysOfWeek`, the route stamps `rrule = "FREQ=DAILY"`
  //      so the canonical recurrence engine has a clean shape going
  //      forward instead of falling through to the legacy parser.
  //
  //   3. **iOS contract dual-write** — when `timesOfDay` is absent or
  //      empty, the route stamps `[windowStart]` so the new engine
  //      always sees a populated `timesOfDay` while legacy iOS clients
  //      (v0.6.x) keep encoding the `windowStart` / `windowEnd` /
  //      `daysOfWeek` shape. Both shapes coexist through v1.5.x.
  if (oneShot === true) {
    if (schedules.length > 1) {
      return apiError(
        "A one-shot medication can have at most one schedule",
        422,
      );
    }
    const s = schedules[0];
    if (s.rrule !== undefined || s.rollingIntervalDays !== undefined) {
      return apiError(
        "A one-shot medication cannot have a recurrence (rrule or rollingIntervalDays)",
        422,
      );
    }
  }

  // Normalise endsOn for one-shot. Zod gives us `Date | null | undefined`.
  const normalisedEndsOn =
    oneShot === true && startsOn ? startsOn : (endsOn ?? undefined);

  const medication = await prisma.medication.create({
    data: {
      userId: user.id,
      name,
      dose,
      // v1.4.25 W4d — treatmentClass + dosesPerUnit are optional in the
      // wire schema; Prisma fills the default GENERIC when omitted.
      ...(treatmentClass !== undefined && { treatmentClass }),
      ...(dosesPerUnit !== undefined && { dosesPerUnit }),
      // v1.6.0 — route of administration; Prisma defaults to ORAL when omitted.
      ...(deliveryForm !== undefined && { deliveryForm }),
      // v1.8.5 — injection-site tracking opt-in + per-medication allowed
      // sites; Prisma defaults to false / [] when omitted.
      ...(trackInjectionSites !== undefined && { trackInjectionSites }),
      ...(allowedInjectionSites !== undefined && { allowedInjectionSites }),
      // v1.7.0 — iOS reminder flags; Prisma defaults both to false.
      ...(liveActivityEnabled !== undefined && { liveActivityEnabled }),
      ...(criticalAlarmEnabled !== undefined && { criticalAlarmEnabled }),
      // v1.9.0 — optional drug-classification codes (ATC / RxNorm).
      // Validated for format by Zod; stored verbatim when present.
      ...(atcCode !== undefined && { atcCode }),
      ...(rxNormCode !== undefined && { rxNormCode }),
      // v1.5 — wizard's reminders toggle now ships through the create
      // payload (was orphaned in the initial diff). Prisma defaults to
      // true when omitted, matching the legacy form's behaviour.
      ...(notificationsEnabled !== undefined && { notificationsEnabled }),
      // v1.5 scheduling primitives — pass-through when supplied.
      ...(startsOn !== undefined && { startsOn }),
      ...(normalisedEndsOn !== undefined && { endsOn: normalisedEndsOn }),
      ...(oneShot !== undefined && { oneShot }),
      schedules: {
        create: schedules.map((s) => {
          // Invariant 2 — default to FREQ=DAILY when nothing else is set.
          // v1.7.0 — PRN schedules carry no cadence, so never default
          // them to FREQ=DAILY (they would otherwise project + remind).
          const hasLegacyDays = (s.daysOfWeek?.length ?? 0) > 0;
          const isPrn = s.scheduleType === "PRN";
          const defaultedRrule =
            !oneShot &&
            !isPrn &&
            s.rrule === undefined &&
            s.rollingIntervalDays === undefined &&
            !hasLegacyDays
              ? "FREQ=DAILY"
              : s.rrule;

          // Invariant 3 — dual-write `timesOfDay` from windowStart when
          // the legacy-shape iOS client doesn't send the new field.
          const effectiveTimesOfDay =
            s.timesOfDay && s.timesOfDay.length > 0
              ? s.timesOfDay
              : [s.windowStart];

          return {
            windowStart: s.windowStart,
            windowEnd: s.windowEnd,
            label: s.label ?? null,
            dose: s.dose ?? null,
            daysOfWeek: serializeScheduleRecurrence({
              daysOfWeek: s.daysOfWeek ?? [],
              intervalWeeks: s.intervalWeeks ?? 1,
            }),
            // v1.5 first-class times-of-day.
            timesOfDay: effectiveTimesOfDay,
            ...(s.reminderGraceMinutes !== undefined && {
              reminderGraceMinutes: s.reminderGraceMinutes,
            }),
            ...(defaultedRrule !== undefined && { rrule: defaultedRrule }),
            ...(s.rollingIntervalDays !== undefined && {
              rollingIntervalDays: s.rollingIntervalDays,
            }),
            // v1.7.0 — schedule type + cyclic weeks, field-by-field.
            ...(s.scheduleType !== undefined && { scheduleType: s.scheduleType }),
            ...(s.cyclicOnWeeks !== undefined && {
              cyclicOnWeeks: s.cyclicOnWeeks,
            }),
            ...(s.cyclicOffWeeks !== undefined && {
              cyclicOffWeeks: s.cyclicOffWeeks,
            }),
            // v1.15.18 — per-dose configurable on-time windows. Stored as the
            // validated `{ timeOfDay, start, end }[]` JSON; absent leaves the
            // column NULL (every slot on the default ±1h derivation).
            ...(s.doseWindows !== undefined && { doseWindows: s.doseWindows }),
          };
        }),
      },
    },
    include: { schedules: true },
  });

  const normalizedCategory = await setMedicationCategory(
    medication.id,
    category,
  );

  await auditLog("medication.create", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { medicationId: medication.id, name },
  });

  annotate({
    action: {
      name: "medication.create",
      entity_type: "medication",
      entity_id: medication.id,
    },
  });

  // v1.4.34 IW-G — bust per-user medications + compliance + achievement
  // caches so the next read reflects the new schedule.
  invalidateUserMedications(user.id);

  return apiSuccess(
    {
      ...medication,
      category: normalizedCategory,
    },
    201,
  );
});
