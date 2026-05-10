import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess } from "@/lib/api-response";
import { summarize, type DataPoint } from "@/lib/analytics/trends";
import { getBpTargets } from "@/lib/analytics/bp-targets";
import { computeBpInTargetWindows } from "@/lib/analytics/bp-in-target";
import type { MeasurementType } from "@/generated/prisma/client";
import { measurementTypeEnum } from "@/lib/validations/measurement";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "analytics.get" } });

  // Derived from canonical enum so a new measurement type is auto-summarised
  // by /api/analytics (V3 audit: enum drift cousins).
  const types = [...measurementTypeEnum.options] as MeasurementType[];

  const measurementsByType = await Promise.all(
    types.map((type) =>
      prisma.measurement
        .findMany({
          where: { userId: user.id, type },
          orderBy: { measuredAt: "asc" },
          select: { value: true, measuredAt: true },
        })
        .then((measurements) => ({
          type,
          summary: summarize(
            measurements.map(
              (m): DataPoint => ({
                date: m.measuredAt,
                value: m.value,
              }),
            ),
          ),
        })),
    ),
  );

  const results: Record<string, ReturnType<typeof summarize>> = {};
  for (const { type, summary } of measurementsByType) {
    results[type] = summary;
  }

  // BMI calculation
  let bmi: number | null = null;
  if (user.heightCm && results.WEIGHT?.latest) {
    const heightM = user.heightCm / 100;
    bmi = Math.round((results.WEIGHT.latest / (heightM * heightM)) * 10) / 10;
  }

  // BP in-target percentage (auto-calculated from date of birth)
  let bpInTargetPct: number | null = null;
  let bpInTargetPct7d: number | null = null;
  let bpInTargetPct30d: number | null = null;
  const bpTargets = getBpTargets(user.dateOfBirth);
  if (bpTargets) {
    const now = new Date();
    // v1.4.19 A1 — fetch ALL paired BP rows, not just the trailing 30
    // days. Up to v1.4.18 we filtered to the last 30 days at the DB
    // level and the headline (`bpInTargetPct`) was routed through
    // `windows.last30Days?.pct` — making the headline a literal copy
    // of the `30T` sub-value. For Marc's data (572 paired readings,
    // recent 30d = 50 %, all-time ≈ 11 %) the tile pinned 50/50/50
    // and looked algorithmically broken. The windowed helper now also
    // returns an independent `allTime` aggregate, which we surface as
    // the headline so the three numbers can diverge naturally.
    const [sysData, diaData] = await Promise.all([
      prisma.measurement.findMany({
        where: { userId: user.id, type: "BLOOD_PRESSURE_SYS" },
        select: { measuredAt: true, value: true },
      }),
      prisma.measurement.findMany({
        where: { userId: user.id, type: "BLOOD_PRESSURE_DIA" },
        select: { measuredAt: true, value: true },
      }),
    ]);

    const windows = computeBpInTargetWindows(sysData, diaData, bpTargets, now);
    bpInTargetPct = windows.allTime?.pct ?? null;
    bpInTargetPct7d = windows.last7Days?.pct ?? null;
    bpInTargetPct30d = windows.last30Days?.pct ?? null;
  }

  // Per-context glucose summaries (canonical mg/dL).
  const glucoseRows = await prisma.measurement.findMany({
    where: { userId: user.id, type: "BLOOD_GLUCOSE" },
    orderBy: { measuredAt: "asc" },
    select: { value: true, measuredAt: true, glucoseContext: true },
  });
  const glucoseByContext: Record<string, ReturnType<typeof summarize>> = {};
  if (glucoseRows.length > 0) {
    const contexts = ["FASTING", "POSTPRANDIAL", "RANDOM", "BEDTIME"] as const;
    for (const ctx of contexts) {
      const ctxRows = glucoseRows.filter((r) => r.glucoseContext === ctx);
      if (ctxRows.length === 0) continue;
      glucoseByContext[ctx] = summarize(
        ctxRows.map((r): DataPoint => ({ date: r.measuredAt, value: r.value })),
      );
    }
  }

  return apiSuccess({
    summaries: results,
    bmi,
    bpInTargetPct,
    bpInTargetPct7d,
    bpInTargetPct30d,
    glucoseByContext,
  });
});
