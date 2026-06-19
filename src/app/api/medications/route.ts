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
import {
  computeDisplayDue,
  OVERDUE_LOOKBACK_MS,
  toResolvedSlotMark,
  type ResolvedSlotMark,
} from "@/lib/medications/scheduling/next-due";
import { getUserTodayBounds } from "@/lib/tz/local-day";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import { cachedSwr, caches, type ServerCache } from "@/lib/cache/server-cache";
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
  const resolvedWindowEnd = new Date(
    todayEndUtc.getTime() + 2 * 24 * 60 * 60 * 1000,
  );
  // v1.16.4 — the open-overdue search reaches back as far as the widest
  // band tail (weekly on-time + overdue), so the resolved-slot read must
  // cover the same horizon or a long-resolved past slot would resurface
  // as "overdue".
  const resolvedWindowStart = new Date(
    todayStartUtc.getTime() - OVERDUE_LOOKBACK_MS,
  );

  const [
    medications,
    latestIntakes,
    todayEvents,
    resolvedEvents,
    eraFloors,
    usableStock,
    inventoryCounts,
  ] = await Promise.all([
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
      // v1.16.9 — count only ACTIONED rows (taken or skipped). The
      // dashboard projector mints pending rows for every slot of the
      // day, so counting all rows made `todayEventCount` cover every
      // passed dose after any dashboard visit — and the cards'
      // overdue-pill suppression (`todayEventCount < passedDoseCount`)
      // went dark nondeterministically for genuinely overdue doses.
      where: {
        userId,
        deletedAt: null,
        scheduledFor: { gte: todayStartUtc, lte: todayEndUtc },
        OR: [{ takenAt: { not: null } }, { skipped: true }],
      },
      _count: { id: true },
    }),
    prisma.medicationIntakeEvent.findMany({
      where: {
        userId,
        deletedAt: null,
        scheduledFor: { gte: resolvedWindowStart, lte: resolvedWindowEnd },
        OR: [
          { takenAt: { not: null } },
          { skipped: true },
          { autoMissed: true },
        ],
      },
      // v1.16.9 — `takenAt` rides along so the ad-hoc shape
      // (`scheduledFor === takenAt`) is detectable: such a row must not
      // ±6h-resolve a DIFFERENT slot (a 14:30 ad-hoc take hid tonight's
      // genuinely-due 20:00 dose).
      select: { medicationId: true, scheduledFor: true, takenAt: true },
    }),
    // v1.16.4 — current-era floor per medication: the newest revision's
    // `validUntil` is where the LIVE schedule rows became valid. The
    // open-overdue search mints from the live rows, so it must not reach
    // past this boundary into a previous era's cadence.
    prisma.medicationScheduleRevision.groupBy({
      by: ["medicationId"],
      // Superseded rows are audit records — a correction may have
      // shortened the era, so the boundary reads only active rows.
      where: { medication: { userId }, supersededByRevisionId: null },
      _max: { validUntil: true },
    }),
    // v1.16.10 — usable stock per medication (one batched aggregate,
    // not per-row): the sum of `unitsRemaining` over ACTIVE / IN_USE
    // containers with units left — the same usable-container filter
    // the GLP-1 details endpoint applies. Feeds the list payload's
    // `stockUnitsRemaining` / `stockDosesRemaining` for the table view.
    prisma.medicationInventoryItem.groupBy({
      by: ["medicationId"],
      where: {
        userId,
        state: { in: ["ACTIVE", "IN_USE"] },
        unitsRemaining: { gt: 0 },
      },
      _sum: { unitsRemaining: true },
    }),
    // …and the any-state item count, so a medication whose containers
    // are all used up / expired reads as stock 0 (tracking is ON, the
    // supply ran out) instead of null (tracking off).
    prisma.medicationInventoryItem.groupBy({
      by: ["medicationId"],
      where: { userId },
      _count: { id: true },
    }),
  ]);

  const resolvedSlotsByMedId = new Map<string, ResolvedSlotMark[]>();
  for (const e of resolvedEvents) {
    const mark = toResolvedSlotMark(e);
    const list = resolvedSlotsByMedId.get(e.medicationId);
    if (list) list.push(mark);
    else resolvedSlotsByMedId.set(e.medicationId, [mark]);
  }

  const eraStartByMedId = new Map<string, Date>();
  for (const f of eraFloors) {
    if (f._max.validUntil)
      eraStartByMedId.set(f.medicationId, f._max.validUntil);
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

  const usableUnitsByMedId = new Map<string, number>();
  for (const entry of usableStock) {
    usableUnitsByMedId.set(
      entry.medicationId,
      Number(entry._sum.unitsRemaining ?? 0),
    );
  }
  const trackedMedIds = new Set(inventoryCounts.map((e) => e.medicationId));

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
    // v1.16.4 — an OPEN overdue slot (anchor passed, still inside its
    // catch-up band, unresolved) surfaces FIRST with `nextDueOverdue:
    // true`; only a closed or resolved band falls through to the future
    // next-due. Keeps the card on the still-takeable dose instead of
    // jumping ahead the minute the anchor passes.
    const display = computeDisplayDue({
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
      eraStart: eraStartByMedId.get(m.id) ?? null,
    });
    // v1.16.10 — dose-derived stock for the table view. NULL when the
    // medication has no inventory items at all (tracking off); 0 when
    // tracking is on but every container is used up / expired.
    const tracksInventory = trackedMedIds.has(m.id);
    const stockUnitsRemaining = tracksInventory
      ? (usableUnitsByMedId.get(m.id) ?? 0)
      : null;
    const stockDosesRemaining =
      stockUnitsRemaining === null
        ? null
        : Math.floor(stockUnitsRemaining / (Number(m.unitsPerDose) || 1));
    return {
      ...m,
      // v1.16.12 — Decimal → number so the wire stays a JSON number, not
      // the string Prisma would otherwise serialise a Decimal to.
      unitsPerDose: Number(m.unitsPerDose),
      category: categoryMap[m.id] ?? "OTHER",
      lastTakenAt: lastTakenAtByMedicationId[m.id] ?? null,
      todayEventCount: todayEventCountByMedId[m.id] ?? 0,
      nextDueAt: display ? display.at.toISOString() : null,
      nextDueOverdue: display?.overdue ?? false,
      stockUnitsRemaining,
      stockDosesRemaining,
    };
  });
}

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();

  const userTz = user.timezone || "Europe/Berlin";

  // Cache the list shape on userId. The 60 s fresh TTL bounds the
  // cross-midnight staleness window for `todayEventCount` and the
  // next-due fields; v1.16.8 reads through `cachedSwr`, so a visit
  // minutes after the last one serves the prior list immediately while
  // one background recompute warms a fresh entry (the 10-minute stale
  // window bounds how old that served list can be). Interactive writes
  // via POST/PUT/DELETE hard-evict through
  // `invalidateUserMedications({ evict: true })` before the next read
  // lands; background sync paths mark the bucket stale instead.
  const result = await cachedSwr(
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

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });

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
    unitsPerDose,
    reorderLeadDays,
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
    asNeeded,
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
  //   4. **As-needed (v1.16.11, #316)** — when `asNeeded === true` the
  //      medication carries ZERO schedules (the Zod refine already
  //      rejects a populated array, mutual exclusion with `oneShot`
  //      included). Every "never due / never reminded / never scored"
  //      surface follows structurally from the empty schedule list.
  const scheduleInputs = schedules ?? [];
  if (oneShot === true) {
    if (scheduleInputs.length > 1) {
      return apiError(
        "A one-shot medication can have at most one schedule",
        422,
      );
    }
    const s = scheduleInputs[0];
    if (s && (s.rrule !== undefined || s.rollingIntervalDays !== undefined)) {
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
      // v1.16.10 — units consumed per dose; Prisma defaults to 1 when omitted.
      ...(unitsPerDose !== undefined && { unitsPerDose }),
      // v1.17.0 — optional reorder lead override; null/omitted = inherit
      // the user-level default in the low-stock alert.
      ...(reorderLeadDays !== undefined && { reorderLeadDays }),
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
      // v1.16.11 — as-needed flag, field-by-field. An asNeeded create
      // carries an empty `scheduleInputs`, so the nested create below
      // persists zero schedule rows.
      ...(asNeeded !== undefined && { asNeeded }),
      schedules: {
        create: scheduleInputs.map((s) => {
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
            ...(s.scheduleType !== undefined && {
              scheduleType: s.scheduleType,
            }),
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
  invalidateUserMedications(user.id, { evict: true });

  return apiSuccess(
    {
      ...medication,
      unitsPerDose: Number(medication.unitsPerDose),
      category: normalizedCategory,
    },
    201,
  );
});
