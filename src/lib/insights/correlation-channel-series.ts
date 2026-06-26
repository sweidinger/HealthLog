/**
 * v1.21.0 (INTEGFIX) — shared data-fetching helpers for the two non-measurement
 * FDR correlation channels (medication compliance + symptom severity).
 *
 * The pure series shapers live in `correlation-series-builders.ts`; the FDR
 * engine itself is pure over `NamedSeries[]`. These two helpers own the DB reads
 * that feed those shapers — the dose-history ledger (compliance) and the illness
 * day-log (symptom severity) — so EVERY consumer of the discovery matrix (the
 * `/api/insights/correlations` route AND the Coach `get_correlations` tool)
 * builds the channels identically rather than re-implementing the queries, the
 * tz keying, and the episode-span clamping per call site.
 *
 * Each helper degrades to an EMPTY series when the user has no data, so the
 * channel drops out of discovery (it cannot clear the n ≥ 20 floor) rather than
 * fabricating a constant.
 */
import { prisma } from "@/lib/db";
import {
  buildComplianceMedicationContext,
  buildMedicationComplianceBundle,
  lastNonSkippedTakenAt,
  SCHEDULE_COMPLIANCE_SELECT,
} from "@/lib/analytics/compliance";
import {
  MEDICATION_COMPLIANCE_CHANNEL_KEY,
  SYMPTOM_SEVERITY_CHANNEL_KEY,
  type NamedSeries,
} from "@/lib/insights/correlation-discovery";
import {
  buildComplianceDailySeries,
  buildSymptomSeverityDailySeries,
  type SymptomDayLogRow,
  type SymptomEpisodeSpan,
} from "@/lib/insights/correlation-series-builders";
import type { DoseHistoryRow } from "@/lib/medications/scheduling/dose-history";

/**
 * v1.21.0 (FDREXTEND) — build the user's MEDICATION_COMPLIANCE daily series.
 *
 * Pools every active, non-PRN medication's unified dose-history ledger over the
 * window, then collapses to one per-day adherence rate (user-tz day keys). A
 * user with no active medications (or no resolved slots) yields an empty
 * series, so the channel degrades to absent.
 */
export async function fetchComplianceSeries(
  userId: string,
  tz: string,
  since: Date,
): Promise<NamedSeries> {
  const medications = await prisma.medication.findMany({
    // PRN (as-needed) medications have no expected doses → no defensible rate.
    where: { userId, active: true, asNeeded: false },
    include: {
      schedules: { select: SCHEDULE_COMPLIANCE_SELECT },
      scheduleRevisions: { orderBy: { validFrom: "asc" } },
    },
    orderBy: { name: "asc" },
  });
  if (medications.length === 0) {
    return {
      key: MEDICATION_COMPLIANCE_CHANNEL_KEY,
      role: "behaviour",
      points: [],
    };
  }

  const events = await prisma.medicationIntakeEvent.findMany({
    where: {
      userId,
      deletedAt: null,
      medicationId: { in: medications.map((med) => med.id) },
      scheduledFor: { gte: since },
    },
    orderBy: { scheduledFor: "asc" },
    select: {
      medicationId: true,
      scheduledFor: true,
      takenAt: true,
      skipped: true,
    },
  });

  const now = new Date();
  const ledgerRows: DoseHistoryRow[] = [];
  for (const medication of medications) {
    const medEvents = events.filter((e) => e.medicationId === medication.id);
    const ctx = buildComplianceMedicationContext(
      medication,
      lastNonSkippedTakenAt(medEvents),
      tz,
    );
    const bundle = buildMedicationComplianceBundle(
      medEvents,
      medication.schedules,
      ctx,
      now,
    );
    ledgerRows.push(...bundle.ledgerRows);
  }

  return buildComplianceDailySeries(ledgerRows, tz);
}

/**
 * v1.21.0 (FDREXTEND) — build the user's SYMPTOM_SEVERITY daily series in the
 * `outcome` role (callers that need the behaviour role re-tag the returned
 * series — the points are role-invariant). Reads every in-window illness episode
 * + its day-logs; the builder zero-fills healthy days ONLY across real episode
 * spans, so a user with no episodes yields an empty series that degrades to
 * absent.
 */
export async function fetchSymptomSeries(
  userId: string,
  tz: string,
  since: Date,
): Promise<NamedSeries> {
  const now = new Date();
  const episodes = await prisma.illnessEpisode.findMany({
    // An episode overlaps the window when it onset before `now` and either is
    // ongoing or resolved at/after the window start.
    where: {
      userId,
      deletedAt: null,
      onsetAt: { lte: now },
      OR: [{ resolvedAt: null }, { resolvedAt: { gte: since } }],
    },
    select: { id: true, onsetAt: true, resolvedAt: true },
  });
  if (episodes.length === 0) {
    return { key: SYMPTOM_SEVERITY_CHANNEL_KEY, role: "outcome", points: [] };
  }

  const dayLogRows = await prisma.illnessDayLog.findMany({
    where: {
      userId,
      deletedAt: null,
      episodeId: { in: episodes.map((e) => e.id) },
    },
    select: {
      date: true,
      functionalImpact: true,
      symptomLinks: { select: { severity: true } },
    },
  });

  // Collapse each day-log to one burden value (functionalImpact, else the day's
  // max linked symptom severity) — the same rule the recovery-gap track uses.
  const dayLogs: SymptomDayLogRow[] = [];
  for (const row of dayLogRows) {
    if (row.functionalImpact != null) {
      dayLogs.push({ day: row.date, impact: row.functionalImpact });
      continue;
    }
    let maxSeverity: number | null = null;
    for (const link of row.symptomLinks) {
      if (link.severity == null) continue;
      maxSeverity =
        maxSeverity === null
          ? link.severity
          : Math.max(maxSeverity, link.severity);
    }
    if (maxSeverity != null)
      dayLogs.push({ day: row.date, impact: maxSeverity });
  }

  const spans: SymptomEpisodeSpan[] = episodes.map((e) => ({
    onsetAt: e.onsetAt,
    resolvedAt: e.resolvedAt,
  }));

  return buildSymptomSeverityDailySeries({
    dayLogs,
    episodes: spans,
    tz,
    windowStart: since,
    windowEnd: now,
    role: "outcome",
  });
}
