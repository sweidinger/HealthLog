/**
 * v1.10.0 — Coincident-deviation flag (catalogue metric #2, COMPOSITE).
 *
 * "2 of your vitals are outside their usual range this morning — possible
 * factors: illness, alcohol, altitude, a hard workout." For each vital
 * with an established personal band (#1 `VITALS_BASELINE`), check whether
 * the latest reading falls outside the band; **≥ 2 outside on the same day
 * → fire** a flag listing the contributing vitals. No black-box score — it
 * is a transparent COUNT of deviations, mirroring Apple Vitals' ≥2-metric
 * next-morning notification.
 *
 * Coverage gate: ≥ 2 vitals each with an established band. Below that the
 * flag is `insufficient` (it cannot coincide). The minimum-inputs floor is
 * the composite contract — it never emits a single composite number, and
 * never labels a cause ("illness"); it lists the contributing vitals and
 * frames them as "possible factors" only.
 *
 * Standard: the same MAD / personal-baseline basis as #1 (Hampel 1974;
 * Leys et al. 2013). Multi-signal coincidence is descriptive, NOT a
 * diagnosis. Frame: Apple Vitals / WHOOP Health Monitor / Fitbit Health
 * Metrics / Oura Symptom Radar — all descriptive, none continuous.
 *
 * Server-only — fans the baseline engine across the supported vitals with
 * one shared coverage probe (the pool-contention mitigation). The pure
 * classifier is exported for tests.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import {
  probeRollupCoverage,
  type RollupCoverageMap,
} from "@/lib/rollups/measurement-coverage";
import {
  buildInsufficient,
  buildOk,
  deriveCoverage,
  nowProvenanceTimestamp,
} from "./coverage";
import { computeVitalsBaseline, type BaselineProfile } from "./baseline";
import { VITALS_BASELINE_TYPES } from "./registry";
import type { Derived, DerivedProvenanceSource } from "./types";
import { resolveRestMode } from "@/lib/illness/rest-mode";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 30;
/**
 * Row cap for the latest-day mean read — see `readiness.ts`. A dense intra-day
 * day can hold hundreds of rows; the latest-day mean only needs a bounded
 * sample of the most-recent rows (the dense-intraday retention reasoning). The
 * common single-reading-per-day case is unaffected.
 */
const MAX_LATEST_DAY_ROWS = 50;
/** ≥ this many out-of-band vitals on a day fires the flag. */
export const COINCIDENT_FIRE_THRESHOLD = 2;
/** Need ≥ this many banded vitals before the flag can even coincide. */
export const COINCIDENT_MIN_BANDS = 2;

/** One vital's standing against its personal band today. */
export interface VitalDeviation {
  type: MeasurementType;
  /** Today's value. */
  value: number;
  /** Band center (median). */
  center: number;
  low: number;
  high: number;
  /** True when today's value falls outside [low, high]. */
  outside: boolean;
  /** "above" / "below" the band, or "in" when inside. */
  direction: "above" | "below" | "in";
}

export interface CoincidentDeviationValue {
  /** True when ≥ COINCIDENT_FIRE_THRESHOLD vitals are outside their band. */
  fired: boolean;
  /** All banded vitals checked today (the anatomy view lists them). */
  vitals: VitalDeviation[];
  /** Just the out-of-band vitals (the contributing factors). */
  contributing: VitalDeviation[];
  /** The day the flag was evaluated (YYYY-MM-DD). */
  day: string;
  /**
   * v1.18.1 P4 — Rest Mode reframe. True when the flag fired AND an
   * illness/condition episode is active: the deviations have a known
   * explanation (the user is unwell), so the surface frames them as
   * illness-explained — "your vitals are off because you're ill" — instead of
   * presenting them as an unexplained anomaly. The vital numbers themselves
   * are unchanged; only the framing differs. Resolved server-side; iOS
   * mirrors it.
   */
  illnessExplained: boolean;
}

// ── pure classifier (exported for tests) ───────────────────────────────

/** Classify one vital's latest value against its band. Pure. */
export function classifyDeviation(
  type: MeasurementType,
  value: number,
  low: number,
  high: number,
  center: number,
): VitalDeviation {
  const above = value > high;
  const below = value < low;
  return {
    type,
    value,
    center,
    low,
    high,
    outside: above || below,
    direction: above ? "above" : below ? "below" : "in",
  };
}

// ── compute ─────────────────────────────────────────────────────────────

export interface CoincidentDeviationOpts {
  windowDays?: number;
  now?: Date;
  coverage?: RollupCoverageMap;
}

/**
 * The most recent DAY mean for a type within the window, plus its day key.
 * Bounded raw read; null when no reading in the window.
 */
async function readLatestDayMean(
  userId: string,
  type: MeasurementType,
  windowDays: number,
  now: Date,
): Promise<{ value: number; day: string } | null> {
  const since = new Date(now.getTime() - windowDays * MS_PER_DAY);
  const rows = await prisma.measurement.findMany({
    where: { userId, type, deletedAt: null, measuredAt: { gte: since } },
    orderBy: { measuredAt: "desc" },
    take: MAX_LATEST_DAY_ROWS,
    select: { value: true, measuredAt: true },
  });
  if (rows.length === 0) return null;
  // Derive the most-recent day defensively (do not assume the DB ordering)
  // so the "today" reading is always the genuine latest, then mean its rows.
  let day = "";
  for (const r of rows) {
    const d = r.measuredAt.toISOString().slice(0, 10);
    if (d > day) day = d;
  }
  const sameDay = rows.filter(
    (r) => r.measuredAt.toISOString().slice(0, 10) === day,
  );
  return {
    value: sameDay.reduce((s, r) => s + r.value, 0) / sameDay.length,
    day,
  };
}

/**
 * Compute the coincident-deviation flag across the supported vitals. Below
 * `COINCIDENT_MIN_BANDS` banded vitals it returns `insufficient`.
 */
export async function computeCoincidentDeviation(
  userId: string,
  profile: BaselineProfile,
  opts: CoincidentDeviationOpts = {},
): Promise<Derived<CoincidentDeviationValue>> {
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const now = opts.now ?? new Date();
  const computedAt = nowProvenanceTimestamp(now);
  const coverage = opts.coverage ?? (await probeRollupCoverage(userId));

  const vitals: VitalDeviation[] = [];
  let latestDay = "";
  let anyDaySource = false;
  let maxHistoryDays = 0;

  // Fan the baseline engine across the supported vitals. Each baseline read
  // shares the one coverage probe (no per-vital re-probe).
  for (const type of VITALS_BASELINE_TYPES) {
    const baseline = await computeVitalsBaseline(userId, profile, {
      type,
      windowDays,
      now,
      coverage,
    });
    if (baseline.status !== "ok") continue;
    if (baseline.provenance.source === "DAY") anyDaySource = true;
    const latest = await readLatestDayMean(userId, type, windowDays, now);
    if (!latest) continue;
    if (latest.day > latestDay) latestDay = latest.day;
    if (baseline.coverage.historyDays > maxHistoryDays) {
      maxHistoryDays = baseline.coverage.historyDays;
    }
    vitals.push(
      classifyDeviation(
        type,
        latest.value,
        baseline.value.low,
        baseline.value.high,
        baseline.value.center,
      ),
    );
  }

  const inputs = vitals.map((v) => String(v.type));
  const source: DerivedProvenanceSource =
    vitals.length === 0 ? "none" : anyDaySource ? "DAY" : "live";

  if (vitals.length < COINCIDENT_MIN_BANDS) {
    const { coverage: cov } = deriveCoverage({
      requiredInputs: COINCIDENT_MIN_BANDS,
      presentInputs: vitals.length,
      historyDays: 0,
      missing: [],
      fullHistoryDays: windowDays,
    });
    return buildInsufficient<CoincidentDeviationValue>({
      coverage: cov,
      provenance: {
        inputs: inputs.length > 0 ? inputs : VITALS_BASELINE_TYPES.map(String),
        source,
        windowDays,
        computedAt,
      },
      reason: "too_few_banded_vitals",
    });
  }

  const contributing = vitals.filter((v) => v.outside);
  const fired = contributing.length >= COINCIDENT_FIRE_THRESHOLD;

  // v1.18.1 P4 — when the flag fired, reframe it as illness-explained if an
  // episode is active. Only resolved when the flag fired (no read on the
  // common quiet day). Annotation only — the vital deviations are unchanged.
  const illnessExplained = fired
    ? (await resolveRestMode(userId, now)).active
    : false;

  const { coverage: cov, confidence } = deriveCoverage({
    // The coverage axis is "how many vitals could have coincided".
    requiredInputs: vitals.length,
    presentInputs: vitals.length,
    // v1.10.0 QA: the REAL distinct-history-days backing the deepest
    // contributing vital, not the constant `windowDays` (which pinned
    // `historyFraction` to 1 so a 7-day and a 30-day blend reported the same
    // confidence). The composite is at least as well-backed as its
    // best-supported vital.
    historyDays: maxHistoryDays,
    missing: [],
    fullHistoryDays: windowDays,
  });

  return buildOk<CoincidentDeviationValue>({
    value: {
      fired,
      vitals,
      contributing,
      day: latestDay,
      illnessExplained,
    },
    coverage: cov,
    confidence,
    provenance: { inputs, source, windowDays, computedAt },
  });
}
