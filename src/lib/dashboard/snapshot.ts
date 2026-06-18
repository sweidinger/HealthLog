/**
 * v1.7.0 W6 — unified dashboard first-paint snapshot.
 *
 * `buildDashboardSnapshot` assembles every above-the-fold tile field in
 * a single server round-trip from the existing rollup / mood / widget
 * helpers plus a read-only lift of the pre-generated daily briefing.
 * The whole strip therefore shares one completion moment instead of the
 * legacy four-cell waterfall (slim analytics + thick analytics + mood +
 * widget layout, each gated behind `/api/auth/me`).
 *
 * Two-phase shape — the deliberate trade-off documented in the
 * R-firstpaint spec §6 "Risks":
 *
 *   - `tiles` — fast, ALWAYS present. The slim summaries slice, the
 *     mood block, the resolved widget layout, the derived user profile
 *     fields. These resolve sub-second on a warm rollup tenant.
 *   - `extras` — thick, MAY be null. The BD-Zielbereich (`bpInTargetPct*`)
 *     and per-context glucose tiles ride the slowest reads (the
 *     `computeBpInTargetFastPath` fast-path falls back to multi-second
 *     live SQL on a rollup-coverage miss). Collapsing them into the
 *     fast phase would make the WHOLE strip wait for the slowest
 *     sub-query. Instead the builder runs both phases concurrently
 *     inside one `Promise.all`; on a coverage miss `extras` is emitted
 *     `null` so the BD/glucose tiles fall back to a per-tile shimmer
 *     while every other tile paints together. Warm-rollup tenants get
 *     everything in the single payload because the thick reads resolve
 *     inside the same fast window.
 *
 * No LLM is reachable from this builder. The briefing is lifted
 * read-only from `User.insightsCachedText`; a cache miss / stale row
 * yields `briefingState: "preparing"` (with the last good briefing
 * delivered under `briefingStale: true` when one exists) and the
 * `insight-pregenerate` cron refills it — or `"no-provider"` when no
 * AI provider is configured anywhere, so clients can stop waiting.
 * The builder NEVER POSTs `/api/insights/generate`.
 */
import type {
  PrismaClient,
  MeasurementType,
} from "@/generated/prisma/client";
import { computeSummariesSlice } from "@/lib/analytics/summaries-slice";
import { getUnitForType } from "@/lib/validations/measurement";
import {
  summarize,
  type DataPoint,
  type DataSummary,
} from "@/lib/analytics/trends";
import { getBpTargets, type BpTargets } from "@/lib/analytics/bp-targets";
import {
  buildTrafficLightBands,
  buildTrafficRange,
  buildWeightBandsFromHeight,
  buildWeightRangeFromHeight,
  getBodyFatTargetRange,
  type ValueBand,
  type TrafficRange,
} from "@/lib/analytics/value-bands";
import {
  getAgeFromDateOfBirth,
  getPersonalizedPulseTarget,
} from "@/lib/analytics/pulse-targets";
import {
  computeGlucoseClinicalMetrics,
  GLUCOSE_PANEL_WINDOW_DAYS,
  type GlucoseClinicalMetrics,
} from "@/lib/analytics/glucose-metrics";
import {
  computeBpInTargetFastPath,
  type BpInTargetEnvelope,
} from "@/lib/analytics/bp-in-target-fast-path";
import { buildHealthScoreBpInputs } from "@/lib/analytics/health-score-inputs";
import { deriveBpWindow90 } from "@/lib/analytics/window-confidence";
import {
  probeRollupCoverage,
  type RollupCoverageMap,
} from "@/lib/rollups/measurement-coverage";
import { buildMoodDailySeries } from "@/lib/analytics/mood-series";
import {
  resolveDashboardLayout,
  DASHBOARD_WIDGET_CATALOGUE_IDS,
  type DashboardLayout,
  type DashboardWidgetCatalogueId,
} from "@/lib/dashboard-layout";
import { dailyBriefingSchema, type DailyBriefing } from "@/lib/ai/schema";
import { getAssistantFlags } from "@/lib/feature-flags";
import { hasAnyConfiguredProvider } from "@/lib/ai/provider";
import { DEFAULT_TIMEZONE } from "@/lib/tz/resolver";
import {
  buildMedsTodayBlock,
  type MedsTodayBlock,
} from "@/lib/dashboard/meds-today";
import { computeUserHealthScoreFastPath } from "@/lib/analytics/health-score-fast-path";
import type {
  HealthScoreBand,
  RestModeAnnotation,
} from "@/lib/analytics/health-score";
import { resolveRestMode } from "@/lib/illness/rest-mode";
import { resolveModuleMap, type ModuleKey } from "@/lib/modules/gate";

/** Briefing freshness window — mirrors the 24 h TTL on the advisor cache. */
const BRIEFING_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * v1.18.0 — the two dashboard module maps live in a client-safe module
 * (`@/lib/dashboard/widget-modules`) so the settings client component can
 * import them without pulling the server snapshot builder (and its
 * `pg` / `dns` chain) into the browser bundle. Re-exported here for the
 * server call sites and the existing tests.
 */
export {
  WIDGET_MODULE_BY_ID,
  SUMMARY_TYPE_MODULE,
} from "@/lib/dashboard/widget-modules";
import {
  WIDGET_MODULE_BY_ID,
  SUMMARY_TYPE_MODULE,
} from "@/lib/dashboard/widget-modules";

const GLUCOSE_CONTEXTS = [
  "FASTING",
  "POSTPRANDIAL",
  "RANDOM",
  "BEDTIME",
] as const;

/**
 * v1.7.0 — HealthLog `MeasurementType` → iOS `MetricKind` raw value.
 *
 * The iOS client decodes `MetricKind` from these exact raw strings
 * (`MetricKind.swift:30-122`); the snapshot's `metricStates` block is
 * keyed by them so a cold-launch first-paint seeds every tile without
 * a per-metric round-trip. Most map to the lowercase / camel form of
 * the enum, but a handful are non-obvious and locked verbatim in
 * `.planning/ios-coord/v1.7.0-ios-convergence-locks.md` §4b:
 *
 *   - SpO₂ → `oxygenSaturation`
 *   - body water → `totalBodyWater`
 *   - HRV → `heartRateVariability`
 *   - BMI → `bodyMassIndex`
 *   - walking asymmetry → `walkingAsymmetryPercentage`
 *   - walking double support → `walkingDoubleSupportPercentage`
 *   - environmental audio → `environmentalAudioExposure`
 *   - headphone audio → `headphoneAudioExposure`
 *   - active energy → `activeEnergyBurned`
 *
 * Types without an iOS `MetricKind` counterpart are intentionally
 * absent (no key emitted) rather than mapped to a guessed raw. The
 * audio-exposure EVENT flag, walking steadiness, and the Withings-only
 * body-composition metrics (fat-free / muscle mass, PWV, vascular age,
 * visceral fat, skin temperature) have no iOS tile and are omitted.
 */
const METRIC_KIND_RAW_BY_TYPE: Partial<Record<MeasurementType, string>> = {
  WEIGHT: "weight",
  BLOOD_PRESSURE_SYS: "bloodPressureSystolic",
  BLOOD_PRESSURE_DIA: "bloodPressureDiastolic",
  PULSE: "pulse",
  BODY_FAT: "bodyFat",
  SLEEP_DURATION: "sleep",
  ACTIVITY_STEPS: "steps",
  BLOOD_GLUCOSE: "bloodGlucose",
  TOTAL_BODY_WATER: "totalBodyWater",
  BONE_MASS: "boneMass",
  OXYGEN_SATURATION: "oxygenSaturation",
  HEART_RATE_VARIABILITY: "heartRateVariability",
  RESTING_HEART_RATE: "restingHeartRate",
  ACTIVE_ENERGY_BURNED: "activeEnergyBurned",
  FLIGHTS_CLIMBED: "flightsClimbed",
  WALKING_RUNNING_DISTANCE: "walkingRunningDistance",
  VO2_MAX: "vo2Max",
  BODY_TEMPERATURE: "bodyTemperature",
  FAT_FREE_MASS: "fatFreeMass",
  FAT_MASS: "fatMass",
  MUSCLE_MASS: "muscleMass",
  RESPIRATORY_RATE: "respiratoryRate",
  BODY_MASS_INDEX: "bodyMassIndex",
  LEAN_BODY_MASS: "leanBodyMass",
  WALKING_HEART_RATE_AVERAGE: "walkingHeartRateAverage",
  WALKING_ASYMMETRY: "walkingAsymmetryPercentage",
  WALKING_DOUBLE_SUPPORT: "walkingDoubleSupportPercentage",
  WALKING_STEP_LENGTH: "walkingStepLength",
  WALKING_SPEED: "walkingSpeed",
  AUDIO_EXPOSURE_ENV: "environmentalAudioExposure",
  AUDIO_EXPOSURE_HEADPHONE: "headphoneAudioExposure",
  TIME_IN_DAYLIGHT: "timeInDaylight",
};

/**
 * v1.15.20 — `"no-provider"` joins the tri-state: the cache is stale or
 * missing AND no AI provider is configured anywhere (user chain, legacy
 * selection, Codex link, operator key), so no warm pass will ever fill
 * it. Clients render a "connect a provider" hint instead of an eternal
 * "preparing" spinner. Existing states keep their exact semantics.
 */
export type BriefingState = "ready" | "preparing" | "disabled" | "no-provider";

export interface DashboardSnapshotUser {
  username: string;
  timezone: string;
  heightCm: number | null;
  dateOfBirth: string | null;
  gender: "MALE" | "FEMALE" | null;
  glucoseUnit: string | null;
  onboardingTourCompleted: boolean;
  /**
   * Server-computed wall-clock hour in the user's timezone so the
   * client greeting never has to run its own `Intl.DateTimeFormat`
   * before first paint.
   */
  greetingHour: number;
}

/**
 * v1.18.6 — server-computed band / target math (audit finding #3).
 *
 * The dashboard used to derive every chart band + tile range CLIENT-side
 * in `page.tsx` from `user.dateOfBirth` / `gender` / `heightCm`. This
 * block resolves the same numbers server-side from the EXISTING band
 * helpers (`getBpTargets`, `getPersonalizedPulseTarget`,
 * `getBodyFatTargetRange`, `buildWeight*FromHeight`,
 * `buildTrafficLightBands`, `buildTrafficRange`) so the client reads them
 * instead of recomputing. Only the NUMERIC structures live here — the
 * `bpTargetZones` array carries `t()`-localised labels, so the client
 * assembles THAT from `bpTargets` (numbers) at render time. Every field
 * is `null` when the driving profile fact is missing (no DOB → BP/pulse
 * personalisation, no height → weight band), matching the client's
 * previous null-guards exactly.
 */
export interface DashboardTargetBands {
  /** Personalised BP target numbers (null when no DOB). */
  bpTargets: BpTargets | null;
  /** Systolic traffic range (null when no DOB). */
  bpSysRange: TrafficRange | null;
  /** Diastolic traffic range (null when no DOB). */
  bpDiaRange: TrafficRange | null;
  /** Resting-pulse display range (always present — AHA fallback). */
  pulseDisplayRange: {
    greenMin: number;
    greenMax: number;
    orangeMin: number;
    orangeMax: number;
  };
  /** Resting-pulse chart bands (always present — AHA fallback). */
  pulseBands: ValueBand[];
  /** Body-fat target range (gender-aware; always present). */
  bodyFatRange: { min: number; max: number };
  /** Body-fat chart bands (always present). */
  bodyFatBands: ValueBand[];
  /** Weight traffic range (null when no height). */
  weightRange: TrafficRange | null;
  /** Weight chart bands (null when no height). */
  weightBands: ValueBand[] | null;
}

export interface DashboardSnapshotMoodEntry {
  date: string;
  score: number;
  samples: number;
}

/**
 * Thick analytics slice — `null` when the rollup tier is not warm for
 * this tenant (coverage miss). The dashboard renders a per-tile shimmer
 * for the BD-Zielbereich + glucose tiles in that case and the next
 * snapshot (after the boot backfill converges) carries the values.
 */
export interface DashboardSnapshotExtras {
  bpInTargetPct: number | null;
  bpInTargetPct7d: number | null;
  bpInTargetPct30d: number | null;
  bpInTargetPctAllTime: number | null;
  bpInTargetPctPriorMonth: number | null;
  bpInTargetPctPriorYear: number | null;
  /**
   * v1.17 W1b — number of paired BP readings inside the trailing-90-day
   * window, and the EFFECTIVE label span (real calendar span capped at 90
   * days, or `null` when the window is empty). The BD-Zielbereich tile reads
   * the count against the confidence floor to decide between a percentage and
   * the "collecting data" placeholder, and renders the span in the label so a
   * thin-history user never sees a dishonest static "· 90 T".
   */
  bpInTargetCount90: number | null;
  bpInTargetSpanDays90: number | null;
  glucoseByContext: Record<string, DataSummary>;
  /**
   * v1.17.0 — server-authoritative glucose clinical panel over the trailing
   * 30-day window: the learning gate (+ reason), window/span/count, mean,
   * Battelino TIR distribution, GMI, estimated A1C, SD/CV%/instability, and the
   * advanced J-index + LBGI/HBGI tier. Computed ONCE by
   * `computeGlucoseClinicalMetrics` so the iOS client renders the same numbers
   * the web panel, the coach, and the doctor report do — iOS never re-derives.
   * Always present (even with zero readings) so the native client paints the
   * calm "still learning" state from a populated object.
   */
  glucoseClinical: GlucoseClinicalMetrics;
}

/**
 * v1.7.0 — latest reading per chartable metric, keyed by the iOS
 * `MetricKind` raw value. Additive cold-launch seed: the iOS client
 * paints every tile from this block on first launch without a
 * per-metric round-trip. Derived in-process from the slim summaries
 * slice already fetched for `tiles.summaries` — NO extra DB query.
 */
export interface DashboardMetricState {
  value: number;
  measuredAt: string;
  unit: string;
}

/**
 * v1.7.0 — one widget row in the full catalogue. Mirrors the
 * web-layout `DashboardWidgetConfig` shape (`visible` + `order`) but
 * over the full 27-id catalogue (server-known + iOS-only), so the
 * iOS layout round-trips in one key.
 */
export interface DashboardLayoutCatalogueEntry {
  id: DashboardWidgetCatalogueId;
  visible: boolean;
  order: number;
}

/**
 * Health-score summary for the hero — score + band + week-over-week
 * delta ONLY. The per-pillar component breakdown is deliberately NOT
 * serialised here; the analytics route remains the one surface that
 * exposes components.
 */
export interface DashboardSnapshotHealthScore {
  score: number;
  band: HealthScoreBand;
  delta: number | null;
  /**
   * v1.18.1 — Rest Mode annotation. When an illness/condition episode is
   * active the dashboard frames the score ("you were unwell during this
   * window") WITHOUT changing it — the same value-free context the
   * `/api/analytics` payload carries and iOS mirrors. Null when the account
   * is not in Rest Mode. Resolved server-side (fail-soft) so the surface
   * never recomputes it. Optional on the type (additive contract) so older
   * cached snapshots + test fixtures without the field stay valid; the live
   * builder always sets it (null when not in Rest Mode).
   */
  restMode?: RestModeAnnotation | null;
}

export interface DashboardSnapshot {
  user: DashboardSnapshotUser;
  layout: DashboardLayout;
  /**
   * v1.7.0 — full 27-id widget catalogue (visibility + order) for the
   * iOS cold-launch seed. Additive alongside the web `layout`; the web
   * page keeps reading `layout` byte-identically.
   */
  layoutCatalogue: DashboardLayoutCatalogueEntry[];
  /**
   * v1.7.0 — per-chartable-metric latest reading, keyed by iOS
   * `MetricKind` raw value. Additive; the web page does not read it.
   */
  metricStates: Record<string, DashboardMetricState>;
  /**
   * v1.18.6 — server-computed band / target math (audit finding #3). The
   * web dashboard reads these instead of recomputing from the profile;
   * additive for iOS.
   */
  targetBands: DashboardTargetBands;
  /** Fast phase — always present. */
  tiles: {
    summaries: Record<string, DataSummary>;
    lastSeenByType: Record<
      string,
      { lastSeenAt: string; daysAgo: number } | null
    >;
    mood: {
      summary: DataSummary | null;
      entries: DashboardSnapshotMoodEntry[];
    };
  };
  /** Thick phase — null on a rollup-coverage miss. */
  extras: DashboardSnapshotExtras | null;
  /**
   * Fast phase — today's medication block (projection-backed tally +
   * earliest next-due across active medications).
   *
   * Caching contract: the snapshot is served read-through a cache, so
   * `medsToday.nextDueAt` can sit in the past with
   * `medsToday.nextDueOverdue: false` when the slot's anchor passed
   * AFTER the snapshot was built. Consumers MUST render that state as
   * the plain day summary — never as overdue — until a fresh snapshot
   * carries `nextDueOverdue: true` from the band model itself.
   */
  medsToday: MedsTodayBlock;
  /**
   * Warm-phase health score (score + band + delta only — no
   * components). `null` on a rollup-coverage miss (the score rides the
   * thick phase alongside `extras`) and when no pillar is computable.
   */
  healthScore: DashboardSnapshotHealthScore | null;
  briefing: DailyBriefing | null;
  briefingState: BriefingState;
  briefingUpdatedAt: string | null;
  /**
   * v1.15.20 — additive honesty flag. `true` when `briefing` carries the
   * LAST GOOD (expired-TTL) briefing while a refresh is pending
   * (`briefingState: "preparing"`) or will never come
   * (`"no-provider"`). Clients show the stale content with its
   * `briefingUpdatedAt` timestamp instead of a blank tile — the same
   * stale-while-revalidate honesty the insights page uses.
   */
  briefingStale: boolean;
  generatedAt: string;
}

/** Minimal user shape the builder needs — a subset of the Prisma `User`. */
export interface SnapshotUserInput {
  id: string;
  username: string;
  displayName?: string | null;
  timezone: string | null;
  heightCm: number | null;
  dateOfBirth: Date | null;
  gender: string | null;
  glucoseUnit: string | null;
  onboardingTourCompleted: boolean;
  disableCoach: boolean;
  insightsCachedText: string | null;
  insightsCachedAt: Date | null;
  dashboardWidgetsJson: unknown;
}

/** Wall-clock hour in `tz`, used for the server-side greeting. */
function hourInTimezone(now: Date, tz: string): number {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone: tz,
    });
    const parsed = parseInt(fmt.format(now), 10);
    // Intl emits "24" for midnight under hour12:false on some ICU builds.
    return Number.isFinite(parsed) ? parsed % 24 : now.getUTCHours();
  } catch {
    return now.getUTCHours();
  }
}

function enrichLastSeen(
  raw: Record<string, { lastSeenAt: string } | null>,
  nowMs: number,
): Record<string, { lastSeenAt: string; daysAgo: number } | null> {
  const out: Record<
    string,
    { lastSeenAt: string; daysAgo: number } | null
  > = {};
  for (const [type, slot] of Object.entries(raw)) {
    if (slot === null) {
      out[type] = null;
      continue;
    }
    const lastMs = new Date(slot.lastSeenAt).getTime();
    const daysAgo = Math.floor((nowMs - lastMs) / (24 * 60 * 60 * 1000));
    out[type] = { lastSeenAt: slot.lastSeenAt, daysAgo };
  }
  return out;
}

/**
 * Read-only mood block. v1.17.1 — delegates to the single mood engine
 * `buildMoodDailySeries` so the dashboard tile reads the exact numbers
 * `/api/mood/analytics` (the insights mood sparkline source) returns.
 */
async function buildMoodBlock(
  client: PrismaClient,
  userId: string,
): Promise<{
  summary: DataSummary | null;
  entries: DashboardSnapshotMoodEntry[];
}> {
  const series = await buildMoodDailySeries(userId, client);
  return { summary: series.summary, entries: series.entries };
}

/**
 * Thick slice — BD-Zielbereich + per-context glucose + health score.
 * Only called by the builder when the rollup tier is warm for the
 * types this slice actually reads (`isThickPhaseWarm`); the BP
 * fast-path then stays on the sub-second rollup branch and never drops
 * into the multi-second live fallback that would make the whole strip
 * wait. On a coverage miss for one of those types the builder skips
 * this entirely and emits `extras: null` + `healthScore: null`
 * (per-tile shimmer until the boot backfill converges).
 *
 * The health score rides this warm phase because it reuses the BP
 * windows already computed here (`gradedScore` + `last30Days.pct`) and
 * the same coverage map, so the score's weight pillar also stays on
 * the rollup branch.
 */
async function buildExtras(
  prisma: PrismaClient,
  user: SnapshotUserInput,
  userTz: string,
  coverage: RollupCoverageMap,
  now: Date,
  time: <T>(label: string, fn: () => Promise<T>) => Promise<T>,
): Promise<{
  extras: DashboardSnapshotExtras;
  healthScore: DashboardSnapshotHealthScore | null;
}> {
  let bpInTargetPct: number | null = null;
  let bpInTargetPct7d: number | null = null;
  let bpInTargetPct30d: number | null = null;
  let bpInTargetPctAllTime: number | null = null;
  let bpInTargetPctPriorMonth: number | null = null;
  let bpInTargetPctPriorYear: number | null = null;
  let bpInTargetCount90: number | null = null;
  let bpInTargetSpanDays90: number | null = null;
  // v1.17 W1b — hold the current + prior-week BP envelopes so the shared
  // Health-Score input builder grades the pillar off the identical shape the
  // analytics route uses.
  let bpEnvelope: BpInTargetEnvelope | null = null;
  let bpEnvelopePriorWeek: BpInTargetEnvelope | null = null;

  const bpTargets = getBpTargets(user.dateOfBirth);
  if (bpTargets) {
    // v1.17 W1b — two runs (current + prior-week), identical to the
    // analytics route, so the dashboard ring's week-over-week delta reflects
    // BP movement instead of zeroing it out. Both reuse the already-probed
    // coverage map and share the rollup/live branch decision.
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const [windows, windowsPriorWeek] = await Promise.all([
      computeBpInTargetFastPath({
        userId: user.id,
        targets: bpTargets,
        now,
        coverage,
        userTz,
      }),
      computeBpInTargetFastPath({
        userId: user.id,
        targets: bpTargets,
        now: sevenDaysAgo,
        coverage,
        userTz,
      }),
    ]);
    bpEnvelope = windows;
    bpEnvelopePriorWeek = windowsPriorWeek;
    // v1.17 W1d — the headline standardises on the trailing-90-day
    // window (labelled "· 90 T" in the tile), identical to the analytics
    // route, so the dashboard tile and the insights surface never narrate
    // two windows for the same metric. All-time stays carried for the
    // detail page's long view only.
    bpInTargetPct = windows.last90Days?.pct ?? null;
    bpInTargetPct7d = windows.last7Days?.pct ?? null;
    bpInTargetPct30d = windows.last30Days?.pct ?? null;
    bpInTargetPctAllTime = windows.allTime?.pct ?? null;
    bpInTargetPctPriorMonth = windows.priorMonth?.pct ?? null;
    bpInTargetPctPriorYear = windows.priorYear?.pct ?? null;
    // v1.17 W1b — count + effective span for the tile's confidence gate,
    // derived through the shared helper so this surface and `/api/analytics`
    // can never disagree on the gate or the label span.
    const bpWindow = deriveBpWindow90(
      windows.last90Days,
      windows.last90EarliestAt,
      now,
    );
    bpInTargetCount90 = bpWindow.count;
    bpInTargetSpanDays90 = bpWindow.spanDays;
  }

  // Health score — reuses the BP windows captured above plus the
  // already-probed coverage map (no second probe). Score + band +
  // delta only; the component breakdown stays off this wire.
  //
  // v1.17 W1b — the BP-pillar inputs come from the ONE shared
  // `buildHealthScoreBpInputs` builder the analytics route also uses, so the
  // ring and the insights card grade the pillar off identical inputs (same
  // 90-day window via W1d, same all-time fallback, same graded score, same
  // prior-week delta values). Closes the dashboard-vs-insights divergence.
  const bpInputs = buildHealthScoreBpInputs(bpEnvelope, bpEnvelopePriorWeek);
  const scoreResult = await time("healthScore", () =>
    computeUserHealthScoreFastPath({
      userId: user.id,
      ...bpInputs,
      heightCm: user.heightCm,
      now,
      coverage,
    }),
  );
  // v1.18.1 — resolve the value-free Rest Mode annotation alongside the score
  // so the dashboard hero can frame (never penalise) the number, matching the
  // `/api/analytics` payload + iOS. Fail-soft inside `resolveRestMode`, and
  // only resolved when a score actually rendered.
  const restMode: RestModeAnnotation | null = scoreResult
    ? await (async () => {
        const ctx = await resolveRestMode(user.id, now);
        return ctx.active
          ? {
              active: true,
              since: ctx.since,
              episodeCount: ctx.episodeCount,
            }
          : null;
      })()
    : null;
  const healthScore: DashboardSnapshotHealthScore | null = scoreResult
    ? {
        score: scoreResult.score,
        band: scoreResult.band,
        delta: scoreResult.delta,
        restMode,
      }
    : null;

  const glucoseSince = new Date(
    Date.now() - GLUCOSE_PANEL_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
  const glucoseRows = await prisma.measurement.findMany({
    where: {
      userId: user.id,
      type: "BLOOD_GLUCOSE",
      measuredAt: { gte: glucoseSince },
      deletedAt: null,
    },
    orderBy: { measuredAt: "asc" },
    select: { value: true, measuredAt: true, glucoseContext: true },
  });
  const glucoseByContext: Record<string, DataSummary> = {};
  if (glucoseRows.length > 0) {
    for (const ctx of GLUCOSE_CONTEXTS) {
      const ctxRows = glucoseRows.filter((r) => r.glucoseContext === ctx);
      if (ctxRows.length === 0) continue;
      glucoseByContext[ctx] = summarize(
        ctxRows.map(
          (r): DataPoint => ({ date: r.measuredAt, value: r.value }),
        ),
      );
    }
  }

  // v1.17.0 — clinical panel from the SAME 30-day glucose rows already read
  // above (no extra DB hop), computed by the one literature-locked engine so
  // the iOS cold-launch seed matches the web panel / coach / doctor report.
  const glucoseClinical = computeGlucoseClinicalMetrics(
    glucoseRows.map((r) => ({ measuredAt: r.measuredAt, mgdl: r.value })),
    { windowDays: GLUCOSE_PANEL_WINDOW_DAYS, now },
  );

  return {
    extras: {
      bpInTargetPct,
      bpInTargetPct7d,
      bpInTargetPct30d,
      bpInTargetPctAllTime,
      bpInTargetPctPriorMonth,
      bpInTargetPctPriorYear,
      bpInTargetCount90,
      bpInTargetSpanDays90,
      glucoseByContext,
      glucoseClinical,
    },
    healthScore,
  };
}

/**
 * v1.18.6 — resolve the band / target math server-side from the same
 * helpers the client used. Pure projection over the profile facts; no DB
 * read. Mirrors the exact construction `page.tsx` ran (same helper calls,
 * same literal pulse-band colours/opacities, same null-guards) so the
 * snapshot path and the legacy client-compute path produce byte-identical
 * numbers.
 */
export function buildTargetBands(profile: {
  dateOfBirth: Date | null;
  gender: "MALE" | "FEMALE" | null;
  heightCm: number | null;
}): DashboardTargetBands {
  const bpTargets = profile.dateOfBirth
    ? getBpTargets(profile.dateOfBirth)
    : null;
  const pulseAge = getAgeFromDateOfBirth(profile.dateOfBirth);
  const pulseTarget = getPersonalizedPulseTarget(pulseAge, profile.gender);
  const bodyFatRange = getBodyFatTargetRange(profile.gender);
  const weightRange = profile.heightCm
    ? buildWeightRangeFromHeight(profile.heightCm)
    : null;
  const weightBands = profile.heightCm
    ? buildWeightBandsFromHeight(profile.heightCm, {
        lowerBound: 30,
        upperBound: 250,
      })
    : null;
  const bpSysRange = bpTargets
    ? buildTrafficRange(bpTargets.sysLow, bpTargets.sysHigh)
    : null;
  const bpDiaRange = bpTargets
    ? buildTrafficRange(bpTargets.diaLow, bpTargets.diaHigh)
    : null;
  const pulseBands = [
    { min: 30, max: pulseTarget.orangeMin, color: "#ff5555", opacity: 0.16 },
    {
      min: pulseTarget.orangeMin,
      max: pulseTarget.greenMin,
      color: "#ffb86c",
      opacity: 0.18,
    },
    {
      min: pulseTarget.greenMin,
      max: pulseTarget.greenMax,
      color: "#50fa7b",
      opacity: 0.2,
    },
    {
      min: pulseTarget.greenMax,
      max: pulseTarget.orangeMax,
      color: "#ffb86c",
      opacity: 0.18,
    },
    { min: pulseTarget.orangeMax, max: 220, color: "#ff5555", opacity: 0.16 },
  ].filter((band) => band.max > band.min);
  const bodyFatBands = buildTrafficLightBands(bodyFatRange.min, bodyFatRange.max, {
    lowerBound: 2,
    upperBound: 55,
  });
  return {
    bpTargets,
    bpSysRange,
    bpDiaRange,
    pulseDisplayRange: {
      greenMin: pulseTarget.greenMin,
      greenMax: pulseTarget.greenMax,
      orangeMin: pulseTarget.orangeMin,
      orangeMax: pulseTarget.orangeMax,
    },
    pulseBands,
    bodyFatRange,
    bodyFatBands,
    weightRange,
    weightBands,
  };
}

/** Parse + validate the cached `dailyBriefing` block; null when unusable. */
function parseCachedBriefing(
  cachedText: string | null,
): DailyBriefing | null {
  if (!cachedText) return null;
  try {
    const parsed = JSON.parse(cachedText) as Record<string, unknown>;
    const candidate = parsed?.dailyBriefing;
    if (candidate == null) return null;
    const validated = dailyBriefingSchema.safeParse(candidate);
    return validated.success ? validated.data : null;
  } catch {
    return null;
  }
}

/**
 * Read-only briefing lift. Parses `User.insightsCachedText`, validates
 * the `dailyBriefing` block, and reports a four-state. NEVER calls the
 * provider chain — `hasProvider` is a credential-PRESENCE thunk (two
 * narrow reads, no decrypt, no network) evaluated only on the
 * stale/missing path, so the common warm-cache snapshot pays nothing.
 *
 * v1.15.20 — two honesty upgrades over the old tri-state:
 *   - a stale-but-parseable briefing is DELIVERED with
 *     `briefingStale: true` (plus its timestamp) instead of `null`, so
 *     the tile can show yesterday's content while the warm pass runs;
 *   - when no provider is configured anywhere the state is
 *     `"no-provider"` instead of an eternal `"preparing"`, so clients
 *     can point at Settings → AI rather than spin forever.
 */
async function liftBriefing(
  user: SnapshotUserInput,
  coachEnabled: boolean,
  hasProvider: () => Promise<boolean>,
): Promise<{
  briefing: DailyBriefing | null;
  briefingState: BriefingState;
  briefingUpdatedAt: string | null;
  briefingStale: boolean;
}> {
  if (!coachEnabled || user.disableCoach) {
    return {
      briefing: null,
      briefingState: "disabled",
      briefingUpdatedAt: null,
      briefingStale: false,
    };
  }

  const cachedAt = user.insightsCachedAt;
  const updatedAt = cachedAt?.toISOString() ?? null;
  const stale =
    !cachedAt || Date.now() - cachedAt.getTime() >= BRIEFING_TTL_MS;
  const cachedBriefing = parseCachedBriefing(user.insightsCachedText);

  if (!stale && cachedBriefing) {
    return {
      briefing: cachedBriefing,
      briefingState: "ready",
      briefingUpdatedAt: updatedAt,
      briefingStale: false,
    };
  }

  // Stale or unusable cache — distinguish "a warm pass will fill this"
  // from "nothing ever will" so the client can stop waiting honestly.
  const briefingState: BriefingState = (await hasProvider())
    ? "preparing"
    : "no-provider";
  return {
    // Serve the last good briefing (when one parses) instead of a blank
    // tile; `briefingStale: true` + the timestamp carry the honesty.
    briefing: cachedBriefing,
    briefingState,
    briefingUpdatedAt: updatedAt,
    briefingStale: cachedBriefing !== null,
  };
}

/**
 * v1.7.0 — derive the per-metric latest-reading block from the slim
 * summaries slice already fetched for `tiles.summaries`. ZERO extra DB
 * round-trips: the slim slice's `DISTINCT ON (type)` read already
 * carries the latest `value` (`summaries[type].latest`) and the
 * matching timestamp (`lastSeenByType[type].lastSeenAt`); the unit is
 * the static canonical-unit lookup. This keeps the snapshot pool-safe
 * — no new query is issued against the shared Prisma pool.
 *
 * Keyed by the iOS `MetricKind` raw value so the iOS cold-launch seed
 * can decode each entry directly. Types with no iOS counterpart, no
 * latest value, or no timestamp are omitted (no key emitted).
 */
function buildMetricStates(
  summaries: Record<string, DataSummary>,
  lastSeenByType: Record<string, { lastSeenAt: string } | null>,
): Record<string, DashboardMetricState> {
  const out: Record<string, DashboardMetricState> = {};
  for (const [type, metricKindRaw] of Object.entries(
    METRIC_KIND_RAW_BY_TYPE,
  )) {
    if (!metricKindRaw) continue;
    const summary = summaries[type];
    const lastSeen = lastSeenByType[type];
    if (!summary || summary.latest === null || !lastSeen) continue;
    // v1.11.4 — `summaries.SLEEP_DURATION.latest` now carries last night's
    // TIME-ASLEEP total in MINUTES (the slim slice collapses the per-stage
    // rows). Emit the cold-launch seed in HOURS with an explicit `unit:
    // "h"` so it matches the `/api/dashboard/summary` sleep tile, which
    // already emits hours. Every other metric passes through with its
    // canonical stored unit.
    if (type === "SLEEP_DURATION") {
      out[metricKindRaw] = {
        value: Math.round((summary.latest / 60) * 100) / 100,
        measuredAt: lastSeen.lastSeenAt,
        unit: "h",
      };
      continue;
    }
    out[metricKindRaw] = {
      value: summary.latest,
      measuredAt: lastSeen.lastSeenAt,
      unit: getUnitForType(type),
    };
  }
  return out;
}

/**
 * v1.7.0 — full 27-id widget catalogue (visibility + order). The
 * server-known ids inherit the user's resolved layout (the same
 * `visible` / `order` the web `layout` block carries); the 11 iOS-only
 * ids are appended default-invisible after the highest known order so
 * the catalogue round-trips in one key. Pure projection over the
 * already-resolved layout — no DB read.
 */
function buildLayoutCatalogue(
  layout: DashboardLayout,
): DashboardLayoutCatalogueEntry[] {
  const knownById = new Map<string, { visible: boolean; order: number }>();
  for (const w of layout.widgets) {
    knownById.set(w.id, { visible: w.visible, order: w.order });
  }
  let nextOrder =
    layout.widgets.length > 0
      ? Math.max(...layout.widgets.map((w) => w.order)) + 1
      : 0;
  const out: DashboardLayoutCatalogueEntry[] = [];
  for (const id of DASHBOARD_WIDGET_CATALOGUE_IDS) {
    const known = knownById.get(id);
    if (known) {
      out.push({ id, visible: known.visible, order: known.order });
    } else {
      // iOS-only id — not in the user's saved layout. Append
      // default-invisible after the known ids, mirroring the on-read
      // auto-upgrade convention for newly-introduced widgets.
      out.push({ id, visible: false, order: nextOrder });
      nextOrder += 1;
    }
  }
  return out.sort((a, b) => a.order - b.order);
}

/**
 * Per-type warm gate for the thick phase (extras + healthScore),
 * replacing the all-types `isFullyCovered` AND. The all-types gate
 * nulled the whole thick phase whenever ANY unrelated type lacked a
 * DAY bucket — one fresh wearable reading whose async fold hadn't
 * landed yet zeroed the hero score, while the insights analytics
 * route (which calls the self-gating helpers unconditionally) kept
 * showing a score for the same account. Mirrors the v1.4.38.8
 * per-type pattern already inside `computeBpInTargetFastPath` and
 * `computeUserHealthScoreFastPath`: gate only on the types the thick
 * phase actually reads through the rollup tier — WEIGHT (score weight
 * pillar) + BLOOD_PRESSURE_SYS / _DIA (BP windows + BP pillar).
 *
 * `!== false` rather than `=== true`: a type ABSENT from the map has
 * zero measurements, so the helpers' own live fallbacks are trivially
 * cheap (empty reads) and absence must not cold the phase. A type
 * present-but-`false` has live rows without buckets — for the three
 * gated types that is exactly the multi-second live fallback the
 * snapshot must never wait on, so the phase stays `null` until the
 * backfill converges. An empty map is a fresh account with no
 * measurements at all — nothing to compute, stay `null`.
 */
function isThickPhaseWarm(coverage: RollupCoverageMap): boolean {
  if (coverage.size === 0) return false;
  return (
    coverage.get("WEIGHT") !== false &&
    coverage.get("BLOOD_PRESSURE_SYS") !== false &&
    coverage.get("BLOOD_PRESSURE_DIA") !== false
  );
}

/**
 * v1.18.0 — force every widget whose module is disabled to invisible on
 * the resolved layout (both `visible` and `tileVisible`). Order is
 * preserved so a re-enable restores the user's saved position. Pure
 * projection — the persisted `dashboardWidgetsJson` is untouched; only
 * what the snapshot publishes is gated.
 */
function gateLayoutByModules(
  layout: DashboardLayout,
  modules: Record<ModuleKey, boolean>,
): DashboardLayout {
  return {
    ...layout,
    widgets: layout.widgets.map((w) => {
      const moduleKey = WIDGET_MODULE_BY_ID[w.id];
      if (moduleKey && modules[moduleKey] === false) {
        return { ...w, visible: false, tileVisible: false };
      }
      return w;
    }),
  };
}

/**
 * v1.18.0 — strip disabled-module measurement types from the slim slice
 * so neither `tiles.summaries` / `tiles.lastSeenByType` nor the derived
 * `metricStates` carry data for a module the user turned off. Returns a
 * shallow copy; the inputs are not mutated.
 */
function gateSummariesByModules(
  summaries: Record<string, DataSummary>,
  lastSeenByType: Record<string, { lastSeenAt: string } | null>,
  modules: Record<ModuleKey, boolean>,
): {
  summaries: Record<string, DataSummary>;
  lastSeenByType: Record<string, { lastSeenAt: string } | null>;
} {
  const dropped = new Set<string>();
  for (const [type, moduleKey] of Object.entries(SUMMARY_TYPE_MODULE)) {
    if (moduleKey && modules[moduleKey] === false) dropped.add(type);
  }
  if (dropped.size === 0) return { summaries, lastSeenByType };
  const outSummaries: Record<string, DataSummary> = {};
  for (const [type, summary] of Object.entries(summaries)) {
    if (!dropped.has(type)) outSummaries[type] = summary;
  }
  const outLastSeen: Record<string, { lastSeenAt: string } | null> = {};
  for (const [type, slot] of Object.entries(lastSeenByType)) {
    if (!dropped.has(type)) outLastSeen[type] = slot;
  }
  return { summaries: outSummaries, lastSeenByType: outLastSeen };
}

/**
 * Assemble the full snapshot in ONE `Promise.all`. Every sub-read is
 * timed via the optional `time` wrapper so a regression is attributable
 * through `meta.snapshot.sub_*_ms` without re-instrumenting the route.
 */
export async function buildDashboardSnapshot(
  prisma: PrismaClient,
  user: SnapshotUserInput,
  options: {
    /** Optional per-sub-query timing sink (route surfaces it under `meta`). */
    time?: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
    /**
     * Provider credential-presence probe for the briefing lift —
     * injectable for tests. Defaults to the cheap presence check in
     * `@/lib/ai/provider` (no decrypt, no network).
     */
    hasProvider?: () => Promise<boolean>;
    /**
     * v1.18.0 — resolved per-user module map. Injectable for tests;
     * defaults to `resolveModuleMap(user.id)` (memoised per request).
     * Disabled toggleable modules have their dashboard tiles / data
     * stripped from the snapshot at the build layer so nothing leaks to
     * the client.
     */
    modules?: () => Promise<Record<ModuleKey, boolean>>;
  } = {},
): Promise<DashboardSnapshot> {
  const userTz = user.timezone ?? DEFAULT_TIMEZONE;
  const now = new Date();
  const nowMs = now.getTime();
  const time =
    options.time ?? (<T>(_label: string, fn: () => Promise<T>) => fn());

  // Probe coverage once up front so the thick `extras` phase only runs
  // when the rollup tier is warm for the types it reads. A coverage
  // miss on one of those types returns `extras: null` immediately
  // rather than dropping into the live-SQL fallback that would make
  // the whole strip wait on the slowest read (R-firstpaint §6 —
  // paint-together vs slowest-wins). Unrelated uncovered types do NOT
  // cold the phase (see `isThickPhaseWarm`).
  const coverage = await time("coverage", () => probeRollupCoverage(user.id));
  const warm = isThickPhaseWarm(coverage);

  const [slimRaw, moodRaw, extrasResult, flags, medsToday, modules] =
    await Promise.all([
      // A5 — reuse the coverage map already probed above so the slice
      // doesn't re-run the identical `probeRollupCoverage` query.
      time("summaries", () => computeSummariesSlice(user.id, coverage)),
      time("mood", () => buildMoodBlock(prisma, user.id)),
      warm
        ? time("extras", () =>
            buildExtras(prisma, user, userTz, coverage, now, time),
          )
        : Promise.resolve(null),
      time("flags", () => getAssistantFlags()),
      // Fast phase — projection-backed today tally + earliest next-due.
      time("medsToday", () =>
        buildMedsTodayBlock(prisma, user.id, userTz, now),
      ),
      // v1.18.0 — resolved module map (memoised per request); gates the
      // toggleable tiles below at the build layer.
      time("modules", () =>
        (options.modules ?? (() => resolveModuleMap(user.id)))(),
      ),
    ]);

  // v1.18.0 — strip disabled-module data before it leaves the server.
  // Mood is blanked when the mood module is off; sleep / glucose summary
  // types are dropped from the slim slice; the glucose clinical panel +
  // per-context block are cleared when glucose is off; the layout +
  // catalogue hide every disabled-module widget.
  const slim = gateSummariesByModules(
    slimRaw.summaries,
    slimRaw.lastSeenByType,
    modules,
  );
  const mood =
    modules.mood === false
      ? { summary: null, entries: [] as DashboardSnapshotMoodEntry[] }
      : moodRaw;
  if (extrasResult && modules.glucose === false) {
    extrasResult.extras.glucoseByContext = {};
    extrasResult.extras.glucoseClinical = computeGlucoseClinicalMetrics([], {
      windowDays: GLUCOSE_PANEL_WINDOW_DAYS,
      now,
    });
  }

  const layout = gateLayoutByModules(
    resolveDashboardLayout(user.dashboardWidgetsJson),
    modules,
  );
  // v1.18.0 — the Daily Briefing is the dashboard's AI-narrative surface,
  // so the `insights` module gates it alongside the operator briefing
  // flag + per-user coach opt-out. Disabling `insights` yields the same
  // `briefingState: "disabled"` empty surface the existing flags produce
  // (the raw weight/BP/pulse data stays untouched — `insights` is the
  // narrative layer, not the data layer).
  const briefing = await liftBriefing(
    user,
    flags.briefing && modules.insights !== false,
    options.hasProvider ?? (() => hasAnyConfiguredProvider(user.id)),
  );

  const gender =
    user.gender === "MALE" || user.gender === "FEMALE" ? user.gender : null;

  return {
    user: {
      username: user.displayName?.trim() || user.username,
      timezone: userTz,
      heightCm: user.heightCm ?? null,
      dateOfBirth: user.dateOfBirth?.toISOString() ?? null,
      gender,
      glucoseUnit: user.glucoseUnit ?? null,
      onboardingTourCompleted: user.onboardingTourCompleted,
      greetingHour: hourInTimezone(now, userTz),
    },
    layout,
    layoutCatalogue: buildLayoutCatalogue(layout),
    metricStates: buildMetricStates(slim.summaries, slim.lastSeenByType),
    targetBands: buildTargetBands({
      dateOfBirth: user.dateOfBirth,
      gender,
      heightCm: user.heightCm ?? null,
    }),
    tiles: {
      summaries: slim.summaries,
      lastSeenByType: enrichLastSeen(slim.lastSeenByType, nowMs),
      mood: {
        summary: mood.entries.length > 0 ? mood.summary : null,
        entries: mood.entries,
      },
    },
    extras: extrasResult?.extras ?? null,
    medsToday,
    healthScore: extrasResult?.healthScore ?? null,
    briefing: briefing.briefing,
    briefingState: briefing.briefingState,
    briefingUpdatedAt: briefing.briefingUpdatedAt,
    briefingStale: briefing.briefingStale,
    generatedAt: now.toISOString(),
  };
}
