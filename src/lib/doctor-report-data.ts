/**
 * Server-side aggregator for doctor-report data.
 *
 * Single source of truth for the aggregated payload consumed by both
 * `/api/doctor-report` (JSON, client renders PDF) and
 * `/api/doctor-report/pdf` (server-rendered PDF). Keeps the two endpoints
 * structurally identical so visual parity between client- and server-rendered
 * PDFs is guaranteed by construction, not by drift-prone copy-paste.
 */

import { prisma } from "@/lib/db";
import {
  getEffectiveRange,
  type ThresholdOverridesJson,
} from "@/lib/analytics/effective-range";
import {
  resolveGlucoseUnit,
  thresholdMetricForContext,
  type GlucoseUnit,
} from "@/lib/glucose";
import type { GlucoseContext } from "@/generated/prisma/client";

export interface DoctorReportStats {
  avg: number;
  min: number;
  max: number;
  count: number;
  latest: number;
}

export interface DoctorReportCompliance {
  total: number;
  taken: number;
  skipped: number;
  missed: number;
}

export interface DoctorReportMood {
  avg: number;
  min: number;
  max: number;
  count: number;
  distribution: Record<number, number>;
}

export interface DoctorReportData {
  period: { days: number; since: string };
  patient: {
    username: string | null;
    dateOfBirth: string | null;
    gender: string | null;
    heightCm: number | null;
  };
  measurements: Record<string, Array<{ value: number; measuredAt: string }>>;
  stats: Record<string, DoctorReportStats>;
  glucoseStats: Record<string, DoctorReportStats>;
  glucoseRanges: Record<string, { min: number; max: number }>;
  glucoseUnit: GlucoseUnit;
  bmi: number | null;
  compliance: Record<string, DoctorReportCompliance>;
  medications: Array<{
    name: string;
    dose: string;
    schedules: Array<{
      windowStart: string;
      windowEnd: string;
      label: string | null;
    }>;
  }>;
  mood: DoctorReportMood | null;
}

const GLUCOSE_CONTEXTS: GlucoseContext[] = [
  "FASTING",
  "POSTPRANDIAL",
  "RANDOM",
  "BEDTIME",
];

/**
 * Validate and normalise the requested reporting window.
 * Accepts an unknown value (typically `body.days`); falls back to 90.
 */
export function normaliseDays(value: unknown, fallback = 90): number {
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 365
  ) {
    return value;
  }
  return fallback;
}

/**
 * Aggregate the doctor-report payload for a user over the last `days` days.
 * Pure data assembly — no auth, no rate-limit, no audit. Idempotent.
 */
export async function collectDoctorReportData(
  userId: string,
  days: number,
): Promise<DoctorReportData> {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const [measurements, medications, intakeEvents, moodEntries, userProfile] =
    await Promise.all([
      prisma.measurement.findMany({
        where: { userId, measuredAt: { gte: since } },
        orderBy: { measuredAt: "asc" },
      }),
      prisma.medication.findMany({
        where: { userId, active: true },
        include: { schedules: true },
      }),
      prisma.medicationIntakeEvent.findMany({
        where: { userId, scheduledFor: { gte: since } },
        include: { medication: { select: { name: true } } },
        orderBy: { scheduledFor: "asc" },
      }),
      prisma.moodEntry.findMany({
        where: { userId, moodLoggedAt: { gte: since } },
        orderBy: { moodLoggedAt: "asc" },
      }),
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          username: true,
          dateOfBirth: true,
          gender: true,
          heightCm: true,
          glucoseUnit: true,
          thresholdsJson: true,
        },
      }),
    ]);

  // Group measurements by type.
  const byType: Record<
    string,
    Array<{ value: number; measuredAt: string }>
  > = {};
  for (const m of measurements) {
    if (!byType[m.type]) byType[m.type] = [];
    byType[m.type].push({
      value: m.value,
      measuredAt: m.measuredAt.toISOString(),
    });
  }

  // Per-type stats.
  const stats: Record<string, DoctorReportStats> = {};
  for (const [type, entries] of Object.entries(byType)) {
    const values = entries.map((e) => e.value);
    stats[type] = {
      avg: values.reduce((a, b) => a + b, 0) / values.length,
      min: Math.min(...values),
      max: Math.max(...values),
      count: values.length,
      latest: values[values.length - 1],
    };
  }

  // Medication compliance.
  const compliance: Record<string, DoctorReportCompliance> = {};
  for (const event of intakeEvents) {
    const name = event.medication.name;
    if (!compliance[name]) {
      compliance[name] = { total: 0, taken: 0, skipped: 0, missed: 0 };
    }
    compliance[name].total++;
    if (event.takenAt) {
      compliance[name].taken++;
    } else if (event.skipped) {
      compliance[name].skipped++;
    } else {
      compliance[name].missed++;
    }
  }

  // Mood summary.
  const moodScores = moodEntries.map((e) => e.score);
  const mood: DoctorReportMood | null =
    moodScores.length > 0
      ? {
          avg: moodScores.reduce((a, b) => a + b, 0) / moodScores.length,
          min: Math.min(...moodScores),
          max: Math.max(...moodScores),
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
  const glucoseRows = measurements.filter((m) => m.type === "BLOOD_GLUCOSE");
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
      min: Math.min(...values),
      max: Math.max(...values),
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

  return {
    period: { days, since: since.toISOString() },
    patient: {
      username: userProfile?.username ?? null,
      dateOfBirth: userProfile?.dateOfBirth
        ? userProfile.dateOfBirth.toISOString()
        : null,
      gender: userProfile?.gender ?? null,
      heightCm: userProfile?.heightCm ?? null,
    },
    measurements: byType,
    stats,
    glucoseStats,
    glucoseRanges,
    glucoseUnit: resolveGlucoseUnit(userProfile?.glucoseUnit ?? null),
    bmi,
    compliance,
    medications: medications.map((m) => ({
      name: m.name,
      dose: m.dose,
      schedules: m.schedules.map((s) => ({
        windowStart: s.windowStart,
        windowEnd: s.windowEnd,
        label: s.label,
      })),
    })),
    mood,
  };
}
