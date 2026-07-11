/**
 * Server-side aggregator for doctor-report data.
 *
 * Single source of truth for the aggregated payload consumed by both
 * `/api/doctor-report` (JSON, client renders PDF) and
 * `/api/doctor-report/pdf` (server-rendered PDF). Keeps the two endpoints
 * structurally identical so visual parity between client- and server-rendered
 * PDFs is guaranteed by construction, not by drift-prone copy-paste.
 *
 * The data shapes live in `doctor-report-types.ts` and the pure helpers in
 * `doctor-report-helpers.ts`; both are re-exported here so call sites keep a
 * single import surface.
 */

import { prisma } from "@/lib/db";
import {
  getEffectiveRange,
  type ThresholdOverridesJson,
} from "@/lib/analytics/effective-range";
import { resolveGlucoseUnit, thresholdMetricForContext } from "@/lib/glucose";
import { computeGlucoseClinicalMetrics } from "@/lib/analytics/glucose-metrics";
import type {
  GlucoseContext,
  MeasurementType,
} from "@/generated/prisma/client";
import { getEvent } from "@/lib/logging/context";
import { readNote } from "@/lib/crypto/note-cipher";
import {
  reconstructSleepNights,
  type SleepStageRow,
} from "@/lib/analytics/sleep-night";
import {
  DEFAULT_DOCTOR_REPORT_PREFS,
  type DoctorReportPrefs,
} from "@/lib/validations/doctor-report-prefs";
import { buildCycleExportSummary } from "@/lib/cycle/export-data";
import { resolveModuleMap, type ModuleKey } from "@/lib/modules/gate";
import { SCHEDULE_COMPLIANCE_SELECT } from "@/lib/analytics/compliance";
import {
  WELLNESS_SCORE_REPORT_TYPES,
  type CollectDoctorReportOptions,
  type DoctorReportData,
  type DoctorReportMood,
  type DoctorReportRange,
  type DoctorReportStats,
} from "./doctor-report-types";
import {
  buildLedgerCompliance,
  collapseMeasurementsToCanonical,
  decryptAllergyReaction,
  minMaxOf,
  resolveMaxMedicationAdministrations,
  sanitisePracticeName,
  summariseCanonicalRecovery,
} from "./doctor-report-helpers";

export * from "./doctor-report-types";
export * from "./doctor-report-helpers";

const GLUCOSE_CONTEXTS: GlucoseContext[] = [
  "FASTING",
  "POSTPRANDIAL",
  "RANDOM",
  "BEDTIME",
];

/**
 * Aggregate the doctor-report payload for a user over a `[start, end]` range.
 * Pure data assembly — no auth, no rate-limit, no audit. Idempotent.
 *
 * `range` is validated via `normaliseDateRange()` upstream; this function
 * trusts it and uses both bounds in the Prisma `where` clause so a custom
 * window (not just "last N days") filters correctly.
 */
export async function collectDoctorReportData(
  userId: string,
  range: DoctorReportRange,
  options: CollectDoctorReportOptions = {},
): Promise<DoctorReportData> {
  const { start, end, days } = range;

  // Resolve section toggles up-front. Mood is privacy-sensitive: when
  // it's off we don't issue the `MoodEntry` findMany at all so the data
  // never lands in this process's memory. Other sections are queried
  // either way (the queries are cheap on indexed columns) and stripped
  // from the returned payload below — keeping a single source of
  // truth for the data shape regardless of toggle state.
  // v1.18.0 — resolve the per-user module map up-front (once per build). A
  // disabled module's section/resources are excluded from the export so the
  // PDF + FHIR bundle reflect only the modules the user keeps. The map is
  // ANDed over the user's per-report `sections` toggles: a disabled module
  // forces its section off even if the report toggle says on (you can't share
  // data for a module you turned off), while leaving the others untouched.
  // Core clinical sections (weight / BP / pulse / medications) have no module
  // key and stay unconditional. Injectable for tests.
  const moduleMap = options.moduleMap ?? (await resolveModuleMap(userId));

  const sections: DoctorReportPrefs = {
    ...DEFAULT_DOCTOR_REPORT_PREFS,
    ...(options.sections ?? {}),
  };
  // Module gate: a disabled module wins over the report toggle. Each report
  // section maps to its owning module key; core sections (bp/weight/pulse/
  // bmi/compliance) carry no key and are never gated here.
  if (moduleMap.mood === false) sections.mood = false;
  if (moduleMap.sleep === false) sections.sleep = false;
  if (moduleMap.cycle === false) sections.cycle = false;
  if (moduleMap.labs === false) sections.labs = false;
  // Module gates with no `sections` key — applied directly to the data slices
  // below (glucose panel, recovery/strain wellness scores, workout series).
  const glucoseEnabled = moduleMap.glucose !== false;
  const recoveryEnabled = moduleMap.recovery !== false;
  const workoutsEnabled = moduleMap.workouts !== false;

  // v1.28.25 — push the section / module gates INTO the measurement query.
  // `filterMeasurementKeys` below strips gated types from the returned
  // payload anyway, so rows of a disabled section / module were fetched only
  // to be dropped — pure dead weight, and the heaviest series (BLOOD_GLUCOSE
  // minute-grain CGM, gated by the glucose module) is exactly the one that
  // runs to six figures over a 730-day window. Excluding them at the query
  // is output-identical by construction.
  //
  // WEIGHT is deliberately NEVER excluded: the BMI figure (gated by
  // `sections.bmi`, not `sections.weight`) and the GLP-1 weight-delta both
  // read the PRE-filter `byType` / `stats` maps, so weight rows must be
  // present even when the weight section itself is toggled off. No other
  // gated type is read before the filter (each remaining pre-filter read —
  // sleep nights, glucose panel, recovery summary — sits behind the same
  // gate that drives its exclusion here).
  //
  // NOTE a closed include-list is NOT possible here: every ungated type in
  // the window lands in `stats` / `measurements`, which the clinician share
  // view and the MCP doctor-visit summary iterate wholesale
  // (`Object.entries(data.stats)`). Dense ENABLED types (BLOOD_GLUCOSE
  // minute-grain for a glucose-module user, hourly PULSE) therefore remain a
  // known load — the per-day bucket tier is the follow-up for that.
  const excludedMeasurementTypes: MeasurementType[] = [];
  if (sections.bp === false) {
    excludedMeasurementTypes.push("BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA");
  }
  if (sections.pulse === false) excludedMeasurementTypes.push("PULSE");
  if (sections.sleep === false) excludedMeasurementTypes.push("SLEEP_DURATION");
  for (const [type, moduleKey] of Object.entries(MEASUREMENT_TYPE_MODULE)) {
    if (moduleMap[moduleKey] === false) {
      excludedMeasurementTypes.push(type as MeasurementType);
    }
  }

  const [measurements, medications, intakeEvents, moodEntries, userProfile] =
    await Promise.all([
      prisma.measurement.findMany({
        // v1.4.41 W-DELETED-2 — exclude soft-deleted measurements from
        // the doctor-report aggregator so deleted rows never leak into
        // the JSON payload or the server-rendered PDF.
        where: {
          userId,
          measuredAt: { gte: start, lte: end },
          deletedAt: null,
          ...(excludedMeasurementTypes.length > 0
            ? { type: { notIn: excludedMeasurementTypes } }
            : {}),
        },
        orderBy: { measuredAt: "asc" },
        // v1.28.25 — narrow select. The collector reads exactly these seven
        // fields (canonical-source collapse: type / value / measuredAt /
        // source / deviceType; sleep-night reconstruction adds sleepStage;
        // the glucose panel adds glucoseContext). The full-width read pulled
        // every column — including the notesEncrypted Bytes — across up to
        // 730 days of rows, which on a CGM + per-sample-HR account is the
        // v1.28.2x six-figure-row incident class.
        select: {
          type: true,
          value: true,
          measuredAt: true,
          source: true,
          deviceType: true,
          sleepStage: true,
          glucoseContext: true,
        },
      }),
      prisma.medication.findMany({
        where: { userId, active: true },
        include: {
          // v1.15.20 — the shared compliance select (plus `label`, which the
          // FHIR schedule mapping below needs) so a future engine column added
          // to SCHEDULE_COMPLIANCE_SELECT reaches the doctor-report surface.
          schedules: { select: { ...SCHEDULE_COMPLIANCE_SELECT, label: true } },
          // v1.17 W1a — archived schedule eras so the ledger compliance
          // builder segments expected-slot expansion against the schedule
          // that was live on each past day (matches the detail page).
          scheduleRevisions: {
            orderBy: { validFrom: "asc" },
            select: {
              id: true,
              validFrom: true,
              validUntil: true,
              payload: true,
              supersededByRevisionId: true,
            },
          },
          // v1.25 H-MED1 — pause eras so paused days drop out of the denominator.
          pauseEras: { select: { pausedAt: true, resumedAt: true } },
          // v1.4.25 W4d — eager-load dose history + recent intake site
          // for any active medication. Generic meds carry empty arrays
          // so the legacy data path is byte-identical.
          doseChanges: { orderBy: { effectiveFrom: "asc" } },
          intakeEvents: {
            where: { takenAt: { not: null } },
            orderBy: { takenAt: "desc" },
            take: 1,
            select: { takenAt: true, injectionSite: true },
          },
        },
      }),
      prisma.medicationIntakeEvent.findMany({
        // v1.7.0 sync — exclude tombstoned rows from the doctor report.
        where: {
          userId,
          deletedAt: null,
          scheduledFor: { gte: start, lte: end },
        },
        include: {
          // v1.9.0 — carry the medication identity + codes + delivery
          // form so the FHIR MedicationAdministration builder can emit a
          // self-describing `medicationCodeableConcept` and a route.
          medication: {
            select: {
              id: true,
              name: true,
              dose: true,
              atcCode: true,
              rxNormCode: true,
              deliveryForm: true,
              asNeeded: true,
            },
          },
        },
        orderBy: { scheduledFor: "asc" },
      }),
      // Mood data: zero DB read when the user opted out. This is the
      // privacy-by-default contract — the JSON payload + audit log
      // both reflect "mood was never fetched", not "mood was fetched
      // and then dropped".
      sections.mood
        ? prisma.moodEntry.findMany({
            // v1.7.0 sync — exclude tombstoned rows from the doctor report.
            where: {
              userId,
              deletedAt: null,
              moodLoggedAt: { gte: start, lte: end },
            },
            orderBy: { moodLoggedAt: "asc" },
          })
        : Promise.resolve([]),
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          username: true,
          dateOfBirth: true,
          gender: true,
          heightCm: true,
          glucoseUnit: true,
          thresholdsJson: true,
          // v1.17 W1a — the user timezone anchors the ledger compliance
          // band minter (matches the detail page's dose-day attribution).
          timezone: true,
          // v1.17.1 — source-priority feeds the per-night sleep reconstruction
          // so the report's SLEEP_DURATION resolves the same canonical night
          // (multi-source de-dup) the dashboard + iOS feed show.
          sourcePriorityJson: true,
          // v1.7.0 — patient-identity fields for the export cover + FHIR
          // Patient. KVNR is encrypted (and not selected here) — the route
          // decrypts it and hands it to the builders.
          fullName: true,
          insurerName: true,
          insurerIkNumber: true,
        },
      }),
    ]);

  const reportTz = userProfile?.timezone ?? "Europe/Berlin";

  // v1.18.0 — collapse each multi-source metric to its CANONICAL source before
  // grouping, so the report's per-type avg/min/max match the dashboard rather
  // than blending overlapping sources (e.g. WHOOP + Apple Watch resting-heart-
  // rate summed into one inflated mean). See `collapseMeasurementsToCanonical`.
  const canonicalMeasurements = collapseMeasurementsToCanonical(
    measurements,
    reportTz,
    userProfile?.sourcePriorityJson ?? null,
  );

  // Group measurements by type (canonical-source-collapsed).
  const byType: Record<
    string,
    Array<{ value: number; measuredAt: string }>
  > = {};
  for (const m of canonicalMeasurements) {
    if (!byType[m.type]) byType[m.type] = [];
    byType[m.type].push({
      value: m.value,
      measuredAt: m.measuredAt.toISOString(),
    });
  }
  // measuredAt-ascending within each type so `latest` (last element) is the
  // most recent reading after the canonical collapse reorders by bucket.
  for (const entries of Object.values(byType)) {
    entries.sort((a, b) => a.measuredAt.localeCompare(b.measuredAt));
  }

  // v1.17.1 parity — SLEEP_DURATION enters `byType` as RAW per-stage rows (a
  // 40-min DEEP block, a 12-min AWAKE block, …). Every other sleep surface
  // (dashboard slim slice, /insights/sleep, /api/sleep/night, the iOS feed)
  // shows the per-night reconstructed asleep total via `summarizeSleepNights`,
  // and the v1.17.1 stamping fixes rewrite exactly those raw stage rows. Route
  // the report's sleep value through the same engine — one number, one surface
  // — exactly as RECOVERY_SCORE routes through `summariseCanonicalRecovery`.
  const sleepRows = measurements.filter(
    (m) => m.type === "SLEEP_DURATION",
  ) as unknown as SleepStageRow[];
  if (sleepRows.length > 0) {
    const nights = reconstructSleepNights(
      sleepRows,
      reportTz,
      userProfile?.sourcePriorityJson ?? null,
    ).filter((n) => n.asleepMinutes > 0);
    // Per-night asleep totals, ascending by night, replace the raw per-stage
    // rows so the clinical vitals table reads time-asleep hours, not stage-row
    // minutes. Empty (no scorable night) drops SLEEP_DURATION entirely.
    if (nights.length > 0) {
      byType.SLEEP_DURATION = nights.map((n) => ({
        value: n.asleepMinutes,
        measuredAt: n.measuredAt.toISOString(),
      }));
    } else {
      delete byType.SLEEP_DURATION;
    }
  }

  // Per-type stats.
  const stats: Record<string, DoctorReportStats> = {};
  for (const [type, entries] of Object.entries(byType)) {
    const values = entries.map((e) => e.value);
    stats[type] = {
      avg: values.reduce((a, b) => a + b, 0) / values.length,
      ...minMaxOf(values),
      count: values.length,
      latest: values[values.length - 1],
    };
  }

  // v1.17 W1a — medication compliance through the dose-ledger authority (the
  // same engine the detail page uses), NOT a raw-row tally. Routes each
  // scheduled medication's intake rows through the cadence-aware band minter
  // over the report window so the PDF / FHIR adherence % matches the app's
  // detail page (slot dedup, band timing, cadence honoured). As-needed / PRN
  // medications are excluded — no schedule, no expected dose, no fabricated
  // 100 % on a clinical report. The medication itself stays on the list.
  const compliance = buildLedgerCompliance(
    medications.map((m) => ({
      id: m.id,
      name: m.name,
      asNeeded: m.asNeeded,
      startsOn: m.startsOn,
      endsOn: m.endsOn,
      oneShot: m.oneShot,
      createdAt: m.createdAt,
      schedules: m.schedules,
      scheduleRevisions: m.scheduleRevisions,
      pauseEras: m.pauseEras,
    })),
    intakeEvents.map((e) => ({
      medicationId: e.medicationId,
      scheduledFor: e.scheduledFor,
      takenAt: e.takenAt,
      skipped: e.skipped,
      autoMissed: e.autoMissed ?? false,
      attributionSource: e.attributionSource ?? undefined,
    })),
    reportTz,
    start,
    end,
    end,
  );

  // v1.9.0 — MedicationAdministration source rows. One entry per acted
  // intake (taken OR explicitly skipped); pending / missed rows are
  // dropped so the FHIR export never asserts an administration that did
  // not happen, and tombstoned rows are already excluded by the query
  // `deletedAt: null` predicate. The structured `dose` is resolved from
  // the medication's `MedicationDoseChange` history — the latest change
  // effective at or before the administration instant — when one exists.
  //
  // Dose-change history is loaded on the `medications` array (active
  // meds only); a per-medicationId index lets the resolver run in O(1)
  // lookups + a short linear scan over the (typically small) change list.
  const doseChangesByMedId = new Map<
    string,
    Array<{ effectiveFrom: Date; doseValue: number; doseUnit: string }>
  >();
  for (const m of medications) {
    doseChangesByMedId.set(
      m.id,
      m.doseChanges.map((dc) => ({
        effectiveFrom: dc.effectiveFrom,
        doseValue: dc.doseValue,
        doseUnit: dc.doseUnit,
      })),
    );
  }
  const resolveDoseInEffect = (
    medicationId: string,
    at: Date,
  ): { value: number; unit: string } | null => {
    const changes = doseChangesByMedId.get(medicationId);
    if (!changes || changes.length === 0) return null;
    // `doseChanges` are loaded ordered by `effectiveFrom asc`; take the
    // last one whose effectiveFrom is <= the administration instant.
    let inEffect: { value: number; unit: string } | null = null;
    for (const c of changes) {
      if (c.effectiveFrom.getTime() <= at.getTime()) {
        inEffect = { value: c.doseValue, unit: c.doseUnit };
      } else {
        break;
      }
    }
    return inEffect;
  };

  const medicationAdministrations: NonNullable<
    DoctorReportData["medicationAdministrations"]
  > = [];
  for (const event of intakeEvents) {
    // Only acted rows: a taken dose (completed) or an explicit skip
    // (not-done). A scheduled-but-unconfirmed ("missed") slot is not an
    // administration event and is omitted entirely.
    const isTaken = event.takenAt !== null;
    if (!isTaken && !event.skipped) continue;
    const effectiveAt = isTaken ? (event.takenAt as Date) : event.scheduledFor;
    medicationAdministrations.push({
      medicationName: event.medication.name,
      effectiveAt: effectiveAt.toISOString(),
      status: isTaken ? "completed" : "not-done",
      doseText: event.medication.dose || null,
      // Structured dose only meaningful for a taken dose with a
      // dose-change history; a skip records no dose consumed.
      dose: isTaken
        ? resolveDoseInEffect(event.medication.id, effectiveAt)
        : null,
      injectionSite: event.injectionSite ?? null,
      atcCode: event.medication.atcCode ?? null,
      rxNormCode: event.medication.rxNormCode ?? null,
      deliveryForm: event.medication.deliveryForm ?? null,
    });
  }

  // v1.9.0 — bound the administration set. `intakeEvents` is ordered
  // `scheduledFor: asc`, so the most-recent acted rows are at the tail;
  // keep the last N and flag the trim so the FHIR narrative can disclose
  // it. The omitted rows are the OLDEST in the window — recent adherence
  // is preserved intact. The cap is a coarse safety ceiling (the report
  // window is the natural bound; this only guards a pathological
  // multi-year, many-medication export) — resolved per call from
  // `FHIR_MAX_MEDICATION_ADMINISTRATIONS` so an operator override takes
  // effect without a code change.
  const maxMedicationAdministrations = resolveMaxMedicationAdministrations(
    process.env.FHIR_MAX_MEDICATION_ADMINISTRATIONS,
  );
  const totalAdministrations = medicationAdministrations.length;
  const medicationAdministrationsTruncated =
    totalAdministrations > maxMedicationAdministrations;
  const cappedAdministrations = medicationAdministrationsTruncated
    ? medicationAdministrations.slice(
        totalAdministrations - maxMedicationAdministrations,
      )
    : medicationAdministrations;

  // Mood summary.
  const moodScores = moodEntries.map((e) => e.score);
  const mood: DoctorReportMood | null =
    moodScores.length > 0
      ? {
          avg: moodScores.reduce((a, b) => a + b, 0) / moodScores.length,
          min: minMaxOf(moodScores).min,
          max: minMaxOf(moodScores).max,
          count: moodScores.length,
          distribution: {
            1: moodScores.filter((s) => s === 1).length,
            2: moodScores.filter((s) => s === 2).length,
            3: moodScores.filter((s) => s === 3).length,
            4: moodScores.filter((s) => s === 4).length,
            5: moodScores.filter((s) => s === 5).length,
          },
        }
      : null;

  // BMI from latest weight + profile height.
  const weightStats = stats.WEIGHT;
  const bmiRaw =
    weightStats && userProfile?.heightCm
      ? weightStats.latest / (userProfile.heightCm / 100) ** 2
      : null;
  const bmi = bmiRaw !== null ? Math.round(bmiRaw * 10) / 10 : null;

  // Per-context glucose stats + effective ranges (canonical mg/dL).
  const glucoseStats: Record<string, DoctorReportStats> = {};
  const glucoseRanges: Record<string, { min: number; max: number }> = {};
  // v1.18.0 — when the glucose module is disabled, no glucose row enters the
  // panel: stats, ranges, and the clinical metrics all collapse to empty so the
  // PDF + FHIR Observations carry no glucose for this user.
  const glucoseRows = glucoseEnabled
    ? measurements.filter((m) => m.type === "BLOOD_GLUCOSE")
    : [];
  const overrides = (userProfile?.thresholdsJson ??
    null) as ThresholdOverridesJson | null;
  const profileForRange = {
    heightCm: userProfile?.heightCm ?? null,
    dateOfBirth: userProfile?.dateOfBirth ?? null,
    gender: userProfile?.gender ?? null,
  };
  for (const ctx of GLUCOSE_CONTEXTS) {
    const rows = glucoseRows.filter((m) => m.glucoseContext === ctx);
    if (rows.length === 0) continue;
    const values = rows.map((r) => r.value);
    glucoseStats[ctx] = {
      avg: values.reduce((a, b) => a + b, 0) / values.length,
      ...minMaxOf(values),
      count: values.length,
      latest: values[values.length - 1],
    };
    const eff = getEffectiveRange(
      thresholdMetricForContext(ctx),
      profileForRange,
      overrides,
    );
    if (eff.range) {
      glucoseRanges[ctx] = { min: eff.range.greenMin, max: eff.range.greenMax };
    }
  }

  // v1.17.0 — clinical panel over the WHOLE report period (all contexts
  // pooled), computed by the one literature-locked engine the insights panel
  // and the coach also consume. `windowDays` is the report's own period so the
  // TIR / GMI / eA1C / CV% reflect exactly the readings the rest of the report
  // tabulates; `now: end` anchors the window to the report's upper bound. The
  // learning gate keeps a thin period from asserting a clinical AGP off spot
  // data. Values stay canonical mg/dL; the renderer converts with `glucoseUnit`.
  const glucoseClinical = computeGlucoseClinicalMetrics(
    glucoseRows.map((r) => ({ measuredAt: r.measuredAt, mgdl: r.value })),
    { windowDays: days, now: end },
  );

  // `practiceName` is sanitised to a single-line string with a hard length
  // cap. The PDF cover prints it verbatim — never let unbounded input land in
  // a layout-sensitive header.
  const practiceName = sanitisePracticeName(options.practiceName);

  // Apply section toggles. Removing the type's keys from `byType`,
  // `stats`, and `compliance` lets the PDF renderer treat "section
  // disabled" identically to "section had no rows" — both paths skip
  // the table. Mood is already null when disabled (we never queried).
  const filteredByType = filterMeasurementKeys(byType, sections, moduleMap);
  const filteredStats = filterMeasurementKeys(stats, sections, moduleMap);
  const filteredCompliance = sections.compliance ? compliance : {};
  const filteredBmi = sections.bmi ? bmi : null;

  // v1.4.25 W4d — GLP-1 therapy section. Only assembled when the user
  // has at least one active GLP-1 medication AND the compliance toggle
  // is on (per the privacy contract: a doctor-report dose history needs
  // the compliance section enabled to be useful). Generic accounts
  // get `glp1: null` which the PDF renderer skips entirely.
  const glp1Meds = medications.filter((m) => m.treatmentClass === "GLP1");
  let glp1: DoctorReportData["glp1"] = null;
  if (sections.compliance && glp1Meds.length > 0) {
    const weightSorted = (byType.WEIGHT ?? []).slice();
    const weightStartKg = weightSorted[0]?.value ?? null;
    const weightEndKg = weightSorted[weightSorted.length - 1]?.value ?? null;
    const weightDeltaKg =
      weightStartKg !== null && weightEndKg !== null
        ? Math.round((weightEndKg - weightStartKg) * 10) / 10
        : null;

    // Side-effect tag counts (only when mood section is enabled — we
    // already gated the moodEntries read on `sections.mood`, so this
    // collapses to "no tags" when the user opted out).
    const sideEffectTags = new Set([
      "nausea",
      "constipation",
      "diarrhea",
      "fatigue",
      "appetite-loss",
      "heartburn",
      "headache",
      "übelkeit",
      "verstopfung",
      "durchfall",
      "müdigkeit",
      "appetitlosigkeit",
      "sodbrennen",
      "kopfschmerzen",
    ]);
    const sideEffectCounts = new Map<string, number>();
    for (const mood of moodEntries) {
      const rawTags = mood.tags ?? "";
      let tags: string[];
      try {
        const parsed = JSON.parse(rawTags);
        tags = Array.isArray(parsed)
          ? parsed
              .map((v: unknown) => (typeof v === "string" ? v.trim() : ""))
              .filter(Boolean)
          : [];
      } catch {
        tags = rawTags
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean);
      }
      for (const tag of tags) {
        const lower = tag.toLowerCase();
        if (!sideEffectTags.has(lower)) continue;
        sideEffectCounts.set(lower, (sideEffectCounts.get(lower) ?? 0) + 1);
      }
    }

    glp1 = {
      medications: glp1Meds.map((m) => {
        const latest = m.doseChanges[m.doseChanges.length - 1] ?? null;
        const lastIntake = m.intakeEvents[0] ?? null;
        const comp = compliance[m.name] ?? {
          taken: 0,
          total: 0,
          skipped: 0,
          missed: 0,
        };
        return {
          name: m.name,
          currentDose: latest
            ? {
                value: latest.doseValue,
                unit: latest.doseUnit,
                since: latest.effectiveFrom.toISOString(),
              }
            : null,
          doseHistory: m.doseChanges.map((dc) => ({
            value: dc.doseValue,
            unit: dc.doseUnit,
            effectiveFrom: dc.effectiveFrom.toISOString(),
            note: readNote(dc.noteEncrypted, dc.note),
          })),
          lastInjection:
            lastIntake && lastIntake.takenAt
              ? {
                  date: lastIntake.takenAt.toISOString(),
                  site: lastIntake.injectionSite,
                }
              : null,
          compliance: { taken: comp.taken, total: comp.total },
        };
      }),
      weightStartKg,
      weightEndKg,
      weightDeltaKg,
      sideEffects: Array.from(sideEffectCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([tag, count]) => ({ tag, count })),
    };
  }

  // v1.10.0 — wellness-score summary. The persisted `*_SCORE` rows are already
  // in `byType`/`stats` (they're only filtered out of the clinical vitals
  // table). Summarise each present score type for the separate "Wellness
  // summary" section. Empty array → null so the renderer + FHIR builder skip
  // the section entirely.
  //
  // RECOVERY_SCORE carries BOTH the WHOOP-native row and the COMPUTED proxy for
  // the same day; mixing them into one min/avg/max would blend two distinct
  // series. Resolve to the canonical row per day (WHOOP wins) so the PDF reads
  // the SAME value the tile + iOS feed show — one number, one engine.
  const wellnessScoreSummaries = WELLNESS_SCORE_REPORT_TYPES.flatMap((type) => {
    // v1.18.0 — module gate per score type. Recovery + stress are the
    // recovery/readiness signals (recovery module); strain is the
    // training-load signal derived from the workouts table (workouts module).
    // A disabled owning module drops the score from the wellness summary and,
    // since the FHIR exporter sources these Observations from
    // `data.wellnessScores`, from the bundle too.
    if (type === "STRAIN_SCORE" && !workoutsEnabled) return [];
    if (
      (type === "RECOVERY_SCORE" || type === "STRESS_SCORE") &&
      !recoveryEnabled
    ) {
      return [];
    }
    if (type === "RECOVERY_SCORE") {
      const summary = summariseCanonicalRecovery(measurements, reportTz);
      return summary ? [summary] : [];
    }
    const s = stats[type];
    const rows = byType[type];
    if (!s || !rows || rows.length === 0) return [];
    return [
      {
        type,
        latest: Math.round(s.latest),
        avg: Math.round(s.avg),
        min: Math.round(s.min),
        max: Math.round(s.max),
        count: s.count,
        latestAt: rows[rows.length - 1].measuredAt,
      },
    ];
  });
  const wellnessScores =
    wellnessScoreSummaries.length > 0 ? wellnessScoreSummaries : null;

  // v1.15.0 — cycle summary. Privacy default OFF: only read + assemble when
  // the `cycle` section toggle is explicitly ON. Statistics only — the
  // helper never touches `notesEncrypted`, so no plaintext free-text can
  // leak through this surface. `null` when disabled or no observed cycle.
  let cycle: DoctorReportData["cycle"] = null;
  if (sections.cycle) {
    cycle = await buildCycleExportSummary(
      userId,
      end.toISOString().slice(0, 10),
    );
  }

  // v1.17.1 — structured lab results over the window. ON by default; the
  // user recorded these specifically to share with a clinician, so the
  // privacy stance matches BP / weight, not mood / cycle. We reduce to the
  // latest reading per analyte (with a count) so the report is a concise
  // panel, not a raw dump; notes are never read here.
  let labResults: DoctorReportData["labResults"] = null;
  if (sections.labs) {
    const labRows = await prisma.labResult.findMany({
      where: { userId, takenAt: { gte: start, lte: end }, deletedAt: null },
      orderBy: { takenAt: "asc" },
      select: {
        panel: true,
        analyte: true,
        value: true,
        valueText: true,
        unit: true,
        referenceLow: true,
        referenceHigh: true,
        takenAt: true,
      },
    });
    // Latest-per-analyte, keyed case-insensitively so "LDL" / "ldl" fold
    // together; rows are ascending so the last seen wins as the latest.
    const byAnalyte = new Map<
      string,
      NonNullable<DoctorReportData["labResults"]>[number]
    >();
    for (const r of labRows) {
      const key = r.analyte.toLowerCase();
      const prev = byAnalyte.get(key);
      byAnalyte.set(key, {
        panel: r.panel,
        analyte: r.analyte,
        value: r.value,
        valueText: r.valueText,
        unit: r.unit,
        referenceLow: r.referenceLow,
        referenceHigh: r.referenceHigh,
        takenAt: r.takenAt.toISOString(),
        count: (prev?.count ?? 0) + 1,
      });
    }
    const collapsed = Array.from(byAnalyte.values());
    labResults = collapsed.length > 0 ? collapsed : null;
  }

  // v1.18.1 P4 — illness / condition episodes overlapping the window. Gated
  // on the illness module (default-on, opt-out): when off, no read, no section.
  // An episode overlaps when it began on or before the window end AND is
  // either still ongoing or resolved on or after the window start. Labels +
  // lifecycle + dates only — the encrypted note is never selected, so no
  // free-text leaks into the clinical export.
  let illnessEpisodes: DoctorReportData["illnessEpisodes"] = null;
  if (moduleMap.illness !== false) {
    const episodeRows = await prisma.illnessEpisode.findMany({
      where: {
        userId,
        deletedAt: null,
        onsetAt: { lte: end },
        OR: [{ resolvedAt: null }, { resolvedAt: { gte: start } }],
      },
      orderBy: { onsetAt: "asc" },
      select: {
        label: true,
        type: true,
        lifecycle: true,
        onsetAt: true,
        resolvedAt: true,
      },
    });
    const mapped = episodeRows.map((e) => ({
      label: e.label,
      type: e.type,
      lifecycle: e.lifecycle,
      onsetAt: e.onsetAt.toISOString(),
      resolvedAt: e.resolvedAt ? e.resolvedAt.toISOString() : null,
    }));
    illnessEpisodes = mapped.length > 0 ? mapped : null;
  }

  // v1.27.x — structured allergies + family history. Reference data, not
  // time-windowed (a penicillin allergy does not expire with the report
  // window), so no date filter. Riding the section toggles keeps the "you
  // can deselect any section" contract; both default ON — a clinical
  // report without an allergy section is the riskier default. The
  // reaction description decrypts fail-soft per row; the free-text notes
  // are never selected, matching the illness-journal stance.
  let allergies: DoctorReportData["allergies"] = null;
  if (sections.allergies) {
    const rows = await prisma.allergy.findMany({
      where: { userId, deletedAt: null },
      orderBy: { createdAt: "asc" },
      select: {
        substance: true,
        category: true,
        type: true,
        severity: true,
        status: true,
        reactionEncrypted: true,
      },
    });
    const mapped = rows.map((r) => {
      const { reaction, reactionUnreadable } = decryptAllergyReaction(
        r.reactionEncrypted,
      );
      if (reactionUnreadable) {
        // A reaction WAS recorded but is undecryptable (key gap / GCM
        // corruption). It is flagged (not silently blanked) so the PDF renders
        // an honest "unreadable" marker; log the swallowed decrypt so a
        // systemic key-config failure is visible rather than masquerading as
        // "no reaction recorded" on a clinician-facing export.
        getEvent()?.addWarning(
          `doctor-report: allergy reaction decrypt failed for ${userId} (substance=${r.substance})`,
        );
      }
      return {
        substance: r.substance,
        category: r.category,
        type: r.type,
        severity: r.severity,
        status: r.status,
        reaction,
        reactionUnreadable,
      };
    });
    allergies = mapped.length > 0 ? mapped : null;
  }

  let familyHistory: DoctorReportData["familyHistory"] = null;
  if (sections.familyHistory) {
    const rows = await prisma.familyHistoryEntry.findMany({
      where: { userId, deletedAt: null },
      orderBy: { createdAt: "asc" },
      select: { relationship: true, condition: true, ageAtOnset: true },
    });
    familyHistory = rows.length > 0 ? rows : null;
  }

  return {
    period: {
      days,
      // `since` is preserved for backwards compatibility with any in-flight
      // clients that read the old field name; mirrors `start`.
      since: start.toISOString(),
      start: start.toISOString(),
      end: end.toISOString(),
    },
    patient: {
      username: userProfile?.username ?? null,
      dateOfBirth: userProfile?.dateOfBirth
        ? userProfile.dateOfBirth.toISOString()
        : null,
      gender: userProfile?.gender ?? null,
      heightCm: userProfile?.heightCm ?? null,
      fullName: userProfile?.fullName ?? null,
      insurerName: userProfile?.insurerName ?? null,
      insurerIkNumber: userProfile?.insurerIkNumber ?? null,
    },
    practiceName,
    measurements: filteredByType,
    stats: filteredStats,
    glucoseStats,
    glucoseRanges,
    // Surfaced by the insights glucose views; the doctor-PDF / FHIR rendering of
    // these clinical metrics is staged for a later release, so no report
    // consumer reads this field yet — it is forward-populated, not dead.
    glucoseClinical,
    glucoseUnit: resolveGlucoseUnit(userProfile?.glucoseUnit ?? null),
    bmi: filteredBmi,
    compliance: filteredCompliance,
    medications: medications.map((m) => ({
      name: m.name,
      dose: m.dose,
      // v1.9.0 — drug-classification codes for the coded FHIR concept.
      atcCode: m.atcCode,
      rxNormCode: m.rxNormCode,
      schedules: m.schedules.map((s) => ({
        windowStart: s.windowStart,
        windowEnd: s.windowEnd,
        label: s.label,
      })),
    })),
    medicationAdministrations: cappedAdministrations,
    medicationAdministrationsTruncation: medicationAdministrationsTruncated
      ? { total: totalAdministrations, included: cappedAdministrations.length }
      : null,
    mood,
    glp1,
    wellnessScores,
    cycle,
    labResults,
    illnessEpisodes,
    allergies,
    familyHistory,
  };
}

/**
 * Per-measurement-type → section-toggle mapping. Keys not listed here
 * (e.g., glucose contexts, body fat, oxygen saturation) bypass the
 * toggles for now — those sections will get their own flags in a
 * future iteration. The current scope per the maintainer's directive is the
 * "big five" plus mood + compliance.
 */
const MEASUREMENT_TYPE_SECTION: Record<string, keyof DoctorReportPrefs> = {
  BLOOD_PRESSURE_SYS: "bp",
  BLOOD_PRESSURE_DIA: "bp",
  WEIGHT: "weight",
  PULSE: "pulse",
  SLEEP_DURATION: "sleep",
};

/**
 * v1.18.0 — per-measurement-type → owning module mapping for the types that
 * carry no `sections` toggle but DO belong to a toggleable module. When the
 * module is disabled, the type is stripped from `measurements` + `stats` so the
 * series never reaches the PDF tables or a FHIR Observation.
 *
 *   - `workouts` owns the activity / movement series (steps, active energy,
 *     distance, flights, the walking-gait + stair metrics) and the
 *     training-load `STRAIN_SCORE`.
 *   - `recovery` owns the readiness signals `RECOVERY_SCORE` + `STRESS_SCORE`.
 *   - `glucose` owns the raw `BLOOD_GLUCOSE` series (the glucose panel itself is
 *     gated where it is assembled; this strips the raw rows too).
 *
 * Core clinical types (BP / weight / pulse / body-composition / vitals) carry
 * no module and are never gated here. `sleep` / `mood` / `cycle` / `labs` ride
 * the `sections` mechanism instead.
 */
const MEASUREMENT_TYPE_MODULE: Record<string, ModuleKey> = {
  ACTIVITY_STEPS: "workouts",
  ACTIVE_ENERGY_BURNED: "workouts",
  FLIGHTS_CLIMBED: "workouts",
  WALKING_RUNNING_DISTANCE: "workouts",
  WALKING_SPEED: "workouts",
  WALKING_ASYMMETRY: "workouts",
  WALKING_STEP_LENGTH: "workouts",
  WALKING_DOUBLE_SUPPORT: "workouts",
  SIX_MINUTE_WALK_DISTANCE: "workouts",
  STAIR_ASCENT_SPEED: "workouts",
  STAIR_DESCENT_SPEED: "workouts",
  STRAIN_SCORE: "workouts",
  RECOVERY_SCORE: "recovery",
  STRESS_SCORE: "recovery",
  BLOOD_GLUCOSE: "glucose",
  // v1.25.0 — the PHQ-9 / GAD-7 screener TOTALS ride the doctor-report / FHIR
  // export only when the opt-in mental-health module is on (default OFF →
  // excluded by default, privacy-by-default). Item-level answers are never a
  // Measurement, so they can never leak through this path regardless. The total
  // is the intended clinical artefact (total + band per clinical-instruments.md
  // §4); gating it on the module keeps the export consistent with how mood /
  // sleep / glucose are gated and avoids exporting a screener the account never
  // opted into.
  PHQ9_SCORE: "mentalHealth",
  GAD7_SCORE: "mentalHealth",
  // v1.27.9 — the WHO-5 / SCI totals ride the same module gate.
  WHO5_SCORE: "mentalHealth",
  SCI_SCORE: "mentalHealth",
};

function filterMeasurementKeys<T>(
  map: Record<string, T>,
  sections: DoctorReportPrefs,
  moduleMap: Record<ModuleKey, boolean>,
): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [type, value] of Object.entries(map)) {
    const sectionKey = MEASUREMENT_TYPE_SECTION[type];
    if (sectionKey && sections[sectionKey] === false) continue;
    const moduleKey = MEASUREMENT_TYPE_MODULE[type];
    if (moduleKey && moduleMap[moduleKey] === false) continue;
    out[type] = value;
  }
  return out;
}
