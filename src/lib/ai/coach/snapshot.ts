/**
 * Snapshot builder for the Coach prompt.
 *
 * Reuses the analytics features pipeline so the Coach narrates the
 * exact same numbers the dashboard tiles render — single source of
 * truth for every "your avg30 BP is …" claim. The output is a compact
 * JSON block the system + user prompt frame as the SNAPSHOT for the
 * model to ground its reply in.
 *
 * v1.4.20.1 — extended with a day-level `timeline` block. The earlier
 * shipping shape carried only aggregated statistics (mean, slope, SD,
 * range, count) per metric, so a Coach turn could not answer questions
 * keyed to a specific day or weekday ("why was BP higher last
 * Monday?"). The timeline now ships the last 14 days as raw daily
 * values with weekday labels and aggregates the older window into
 * weekly buckets so the prompt budget stays tight.
 */
import { prisma } from "@/lib/db";
import { extractFeatures } from "@/lib/insights/features";
import {
  parseCoachPrefs,
  type CoachExcludeMetric,
  type CoachDataCluster,
} from "@/lib/validations/coach-prefs";
import { DEFAULT_TIMEZONE } from "@/lib/tz/resolver";
import { userDayKey } from "@/lib/tz/format";
import { convertGlucose, resolveGlucoseUnit } from "@/lib/glucose";
import {
  computeGlucoseClinicalMetrics,
  GLUCOSE_PANEL_WINDOW_DAYS,
} from "@/lib/analytics/glucose-metrics";
import {
  reconstructSleepNights,
  type SleepStageRow,
} from "@/lib/analytics/sleep-night";
import {
  reconstructNights,
  sleepNeedMinutes,
} from "@/lib/insights/derived/sleep-score";
import {
  computeSleepRhythmFromNights,
  type SleepRhythmDto,
} from "@/lib/insights/derived/sleep-rhythm";
import { compactSections } from "@/lib/ai/prompts/compact-sections";
import { annotate } from "@/lib/logging/context";
import { memoizePerRequest } from "@/lib/request-cache";
import { buildGlp1SnapshotBlock } from "./glp1-snapshot";
import { buildDerivedSnapshotBlock } from "./derived-snapshot";
import { buildCoachMemoryBlock } from "./memory-snapshot";
import { buildTrajectorySnapshotBlock } from "./trajectory-snapshot";
import { buildCycleSnapshotBlock } from "./cycle-snapshot";
import { buildIllnessSnapshotBlock } from "./illness-snapshot";
import { buildLabsSnapshotBlock } from "./labs-snapshot";
import {
  buildReferenceGroundingBlock,
  type GroundingMetricInput,
} from "./reference-grounding";
import { buildTieredSeries } from "@/lib/rollups/tiered-context";
import type { MeasurementType } from "@/generated/prisma/client";
import type { ReferenceMetric } from "@/lib/reference-ranges";
import { isCycleAvailableForUser } from "@/lib/cycle/gate";
import { resolveModuleMap, type ModuleKey } from "@/lib/modules/gate";
import {
  buildComplianceLedgerRows,
  buildComplianceMedicationContext,
  calculateCompliance,
  lastNonSkippedTakenAt,
  SCHEDULE_COMPLIANCE_SELECT,
} from "@/lib/analytics/compliance";
import type { DoseHistoryRow } from "@/lib/medications/scheduling/dose-history";
import type { BaselineProfile } from "@/lib/insights/derived";
import {
  CLUSTER_PRIORITY,
  clusterSourcesFromPrefs,
  sourceCluster,
} from "./clusters";
import type {
  CoachProvenance,
  CoachProvenanceMetric,
  CoachScope,
  CoachScopeSource,
  CoachScopeWindow,
} from "./types";

export interface CoachSnapshotResult {
  snapshotJson: string;
  /**
   * v1.20.0 (F1) — the structured, post-degrade snapshot record `snapshotJson`
   * is serialised from. Keyed by domain block (`bloodPressure`, `weight`,
   * `pulse`, `mood`, `compliance`, `glucose`, `sleep`, `sleepRhythm`, `labs`,
   * `illness`, `derived`, `dayStrain`, `trajectory`, `weeklyContext`, …) plus a
   * `scope` block. The coach tool executor reads a single domain block out of
   * this so an on-demand retrieval tool returns exactly the numbers the legacy
   * snapshot-stuffing path would have shown — identical builder, gates, and I/O.
   */
  sections: Record<string, unknown>;
  /**
   * Provenance built from snapshot keys actually present. Stays in
   * sync with the SNAPSHOT block so the source-chip row mirrors what
   * the model could see.
   */
  provenance: CoachProvenance;
  /**
   * v1.18.6 (W7) — citation-aware reference-range grounding for the
   * metrics present in this snapshot, or null when none is covered by the
   * reference backbone. The Coach route appends it verbatim after the
   * SNAPSHOT so the model reads published population bands + the user's
   * placement (general guidance, never a diagnosis). Built deterministically
   * from `src/lib/reference-ranges.ts`; carries no commercial brand name.
   */
  referenceGrounding: string | null;
}

/**
 * Day-level cap for the raw timeline. Days within this window are kept
 * verbatim (one entry per day with weekday). Older days inside the
 * snapshot window are folded into weekly means so a 90-day window
 * lands at ~14 day-rows + ~11 week-rows ≈ 25 rows per metric — well
 * under the 3 000-token Coach turn budget on a 5-metric snapshot.
 */
const DAILY_TIMELINE_DAYS = 14;

/** Default window when the caller doesn't pass a scope. */
const DEFAULT_WINDOW: CoachScopeWindow = "last30days";

/**
 * v1.18.10 (P-2) — newest-first cap on the single multi-type measurement read
 * that feeds the Coach snapshot timelines. The window read can reach 365 days
 * (`lastYear` / `allTime`) across high-frequency types (PULSE / glucose are
 * 200k-row-class), but the prompt only renders ~21 daily + ~10 weekly buckets
 * per metric, so an uncapped read loaded a year of rows to discard almost all
 * of them. 6000 keeps the recent-daily + weekly window exact even with several
 * dense types active (≈ a year of multi-daily readings on one type, or a
 * handful of types at a few readings/day) while bounding the worst case; the
 * coarse MONTH/YEAR tail comes from the rollup tier, not this read.
 */
const SNAPSHOT_MEASUREMENT_ROW_CAP = 6000;

/**
 * v1.17.0 — the glucose clinical panel is a fixed trailing-30-day artifact,
 * identical across the insights panel, the dashboard snapshot, the doctor
 * report, and (here) the coach. Pinned independently of the coach's variable
 * narration window so the coach's TIR/GMI/CV% always equals what the panel
 * renders.
 */
const GLUCOSE_CLINICAL_WINDOW_DAYS = GLUCOSE_PANEL_WINDOW_DAYS;

/**
 * v1.17.0 — the sleep-rhythm read (sleep-debt + chronotype) is a fixed
 * trailing-window artifact, identical across the Sleep page, the dashboard
 * summary, and (here) the coach. Pinned independently of the coach's variable
 * narration window (7/30/90/365) so the coach's debt + chronotype band always
 * equal what the page renders. Mirrors `DEFAULT_WINDOW_DAYS` in
 * `sleep-rhythm.ts`: 42 days gives the 14-night debt window full coverage and
 * ~12 weekend nights for a stable MSF — the assembler self-caps each signal to
 * its own window, so feeding the same 42-day rows yields the page's DTO.
 */
const SLEEP_RHYTHM_WINDOW_DAYS = 42;

/**
 * v1.7.0 — assembled-snapshot soft char cap. After the snapshot is
 * built we measure `JSON.stringify(snapshot).length` as a ~4-chars-per-
 * token proxy and, if it exceeds this cap, progressively degrade the
 * lowest-priority clusters (drop `timeline.recent`, then collapse the
 * weekly buckets) until it fits. ~24 000 chars ≈ ~6 000 tokens, which
 * sits comfortably inside every provider's context alongside the system
 * prompt + history window. The daily token ledger (`budget.ts`) stays
 * the per-day cost backstop; this is the per-prompt shape backstop.
 */
const MAX_SNAPSHOT_CHARS = 24_000;

/**
 * v1.7.0 — when more than this many clusters are active, cap the
 * additive (non-core) clusters' timeline window so a 10-cluster,
 * allTime request can't fan the timeline out across every series at
 * once. The core clinical clusters keep the user-chosen window.
 */
const MULTI_CLUSTER_THRESHOLD = 6;
const MULTI_CLUSTER_WINDOW_CAP: CoachScopeWindow = "last90days";

/**
 * v1.7.0 — the workouts block never dumps every session. It carries
 * the most-recent N sessions verbatim plus a per-sport rollup for the
 * tail, so a heavy-training account at a long window stays bounded.
 */
const WORKOUT_RECENT_CAP = 15;
/**
 * Clusters that keep the user-chosen window even under the multi-cluster
 * cap — the high-signal clinical series.
 */
const CORE_CLUSTERS: ReadonlySet<CoachDataCluster> = new Set<CoachDataCluster>([
  "medication",
  "cardio",
  "glucose",
]);

/**
 * v1.18.0 — module enable/disable → coach-snapshot domain map.
 *
 * When a toggleable data-domain module is disabled for the account, the
 * domains it owns must never enter the coach context. We reuse the
 * existing `excludeMetrics` filtering path (the `excluded` set narrows
 * `sources` before any row is read) by folding the disabled modules into
 * a SYSTEM-side exclusion that unions with the user's `excludeMetrics`.
 *
 * Each toggleable data domain maps to the `CoachScopeSource` token(s)
 * its snapshot block(s) gate on:
 *   - `mood`      → the mood block (`mood` source).
 *   - `sleep`     → the per-night sleep block + the sleep-rhythm block
 *                   (both gate on the `sleep` source).
 *   - `glucose`   → the glucose per-context + clinical block.
 *   - `workouts`  → the workouts block.
 *   - `recovery`  → the recovery / strain composites. These are the
 *                   derived block (READINESS / RECOVERY_SCORE / STRAIN_SCORE
 *                   / …), the WHOOP-native dayStrain block, and the
 *                   trajectory block — all gated on `derivedActive`, which
 *                   reads HRV / resting-HR / VO₂max. Dropping those source
 *                   tokens drops the raw additive timelines too; the
 *                   composites are additionally gated below so they never
 *                   build off the sleep signal alone.
 *
 * `cycle` is intentionally absent: its block already resolves through the
 * fully two-layer cycle gate (`isCycleAvailableForUser` — the per-user
 * toggle AND the operator server-wide kill-switch) below, exactly as the
 * W1 foundation prescribes. `coach` is the surface being narrated, not
 * a data domain. `labs` / `achievements` / `insights` / `doctorReport`
 * own no coach-snapshot data domain.
 */
const MODULE_EXCLUDED_SOURCES: Partial<Record<ModuleKey, CoachScopeSource[]>> =
  {
    mood: ["mood"],
    sleep: ["sleep"],
    glucose: ["glucose"],
    workouts: ["workouts"],
    recovery: ["hrv", "resting_hr", "vo2_max"],
  };

const WEEKDAY_KEYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function windowToDays(window: CoachScopeWindow): number {
  switch (window) {
    case "last7days":
      return 7;
    case "last30days":
      return 30;
    case "last90days":
      return 90;
    case "lastYear":
      // v1.4.27 B7 / BL-P6-4 — year-in-review window. Same 365-day
      // ceiling as the historical `allTime` cap so the prompt budget
      // stays bounded, but with explicit semantics — the Coach knows
      // the user is asking about a long-horizon view rather than the
      // unbounded "all time" backfill.
      return 365;
    case "allTime":
      // Cap "allTime" at one year for the timeline. The aggregate
      // section already cites multi-year ranges via the features
      // pipeline; the timeline stays tight to keep token budget sane.
      return 365;
  }
}

/**
 * YYYY-MM-DD day key anchored to the user's display timezone. The
 * prompt asks the Coach "did you read at 23:50 last night?" — that
 * "last night" answer has to use the user's clock, not UTC. Up to
 * v1.4.24 the day-key was UTC, so a 23:50 Pacific/Auckland reading
 * landed in the next UTC day's bucket and the Coach couldn't pair it
 * with the user's mental model. Delegates to the canonical
 * `userDayKey` so every day-bucket surface stays byte-aligned.
 */
function tzDayKey(date: Date, tz: string): string {
  return userDayKey(date, tz);
}

/**
 * 0..6 → "Sun".."Sat" using the user's tz so "last Monday" in the
 * prompt agrees with the calendar the user is looking at.
 */
function tzWeekday(date: Date, tz: string): string {
  const wk = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
  }).format(date);
  // Normalise "Mon" / "Mon," — modern engines drop the comma but
  // older ones may include it.
  const canon = wk.slice(0, 3) as (typeof WEEKDAY_KEYS)[number];
  return WEEKDAY_KEYS.includes(canon) ? canon : WEEKDAY_KEYS[date.getUTCDay()];
}

/**
 * ISO week key like 2026-W19. We derive the week from the user-tz
 * day-key so a Sunday-evening reading in Auckland (which is already
 * Monday UTC) labels under the Auckland week.
 */
function isoWeekKey(date: Date, tz: string): string {
  // Resolve the wall-clock date in the user's tz, then compute the ISO
  // week from that calendar date. The Thursday-alignment math is the
  // standard ISO 8601 algorithm.
  const dayKey = tzDayKey(date, tz);
  const [y, m, d] = dayKey.split("-").map(Number);
  const localMidnight = new Date(Date.UTC(y, m - 1, d));
  const dayNum = localMidnight.getUTCDay() || 7;
  localMidnight.setUTCDate(localMidnight.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(localMidnight.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(
    ((localMidnight.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
  );
  return `${localMidnight.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

interface DailyValueRow {
  date: string;
  weekday: string;
  value: number;
}

interface DailyBpRow {
  date: string;
  weekday: string;
  sys: number;
  dia: number;
}

interface WeeklyBucket {
  weekISO: string;
  mean: number;
  count: number;
}

/**
 * Group raw measurements (one per row, possibly several per day) into
 * one entry per user-tz day. Multiple readings on the same day are
 * folded into the daily mean — clinically the morning reading is what
 * the Coach is usually asked about, but the snapshot stays pre-clinical
 * and takes the straight mean to avoid presenting a fabricated number.
 */
function dailyMeans<T extends { measuredAt: Date; value: number }>(
  rows: T[],
  tz: string,
): Map<string, { date: Date; values: number[] }> {
  const grouped = new Map<string, { date: Date; values: number[] }>();
  for (const r of rows) {
    const key = tzDayKey(r.measuredAt, tz);
    const existing = grouped.get(key);
    if (existing) {
      existing.values.push(r.value);
    } else {
      grouped.set(key, { date: r.measuredAt, values: [r.value] });
    }
  }
  return grouped;
}

function bucketWeekly(
  rows: Array<{ measuredAt: Date; value: number }>,
  tz: string,
): WeeklyBucket[] {
  const grouped = new Map<string, number[]>();
  for (const r of rows) {
    const key = isoWeekKey(r.measuredAt, tz);
    const list = grouped.get(key);
    if (list) {
      list.push(r.value);
    } else {
      grouped.set(key, [r.value]);
    }
  }
  return Array.from(grouped.entries())
    .map(([weekISO, values]) => ({
      weekISO,
      mean:
        Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 10) /
        10,
      count: values.length,
    }))
    .sort((a, b) => a.weekISO.localeCompare(b.weekISO));
}

function buildDailyValueRows(
  rows: Array<{ measuredAt: Date; value: number }>,
  recentCutoff: Date,
  tz: string,
): DailyValueRow[] {
  const recent = rows.filter((r) => r.measuredAt >= recentCutoff);
  const grouped = dailyMeans(recent, tz);
  return Array.from(grouped.entries())
    .map(([date, info]) => {
      const mean = info.values.reduce((s, v) => s + v, 0) / info.values.length;
      return {
        date,
        weekday: tzWeekday(info.date, tz),
        value: Math.round(mean * 10) / 10,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * v1.18.7 — coarse tail + anomaly envelope for one metric, from the shared
 * tiered-context builder. The Coach already ships the 0–14d raw + 30–90d
 * weekly band (above); this adds only the bands the weekly-fold CANNOT
 * produce — 90d–1y MONTH, >1y YEAR, and the preserved peak/trough envelope —
 * so a glucose spike or a BP outlier from months ago survives a coarse
 * bucket. Token-bounded by the helper's per-band row caps (~10 month + ≤5
 * year + ≤5 anomalies ≈ 240 tokens), and the degrader sheds it first (it is
 * the lowest-value, oldest detail). Returns `undefined` when the metric has
 * no coarse history at all, so the block is omitted rather than shipped empty.
 */
interface CoarseTimelineTail {
  /** 90d–1y monthly buckets: `[bucketStart, mean, min, max]`. */
  monthly: Array<[string, number, number, number]>;
  /** >1y yearly buckets: `[bucketStart, mean, min, max]`. */
  yearly: Array<[string, number, number, number]>;
  /** Preserved peaks/troughs, ≤5, ranked by |deltaSd|. */
  anomalies: Array<{
    band: string;
    date: string;
    kind: string;
    value: number;
    deltaSd: number;
  }>;
}

async function buildCoarseTimelineTail(
  userId: string,
  type: MeasurementType,
  now: Date,
  tz: string,
): Promise<CoarseTimelineTail | undefined> {
  // `buildTieredSeries` reads fall back on miss — a coverage miss yields empty
  // bands, which collapse to `undefined` here. The try/catch keeps the coarse
  // tail a strictly additive enrichment: any unexpected reader failure simply
  // drops the tail rather than failing the whole snapshot (matching the
  // "fall back on miss" contract the rest of the snapshot honours).
  let series: Awaited<ReturnType<typeof buildTieredSeries>>;
  try {
    // `coarseOnly` — the snapshot already holds the raw 0–14d rows from its
    // own window read and this tail consumes only the MONTH/YEAR bands +
    // anomaly envelope, so the builder skips the raw read AND the DAY/WEEK
    // band reads it would otherwise discard.
    series = await buildTieredSeries(userId, type, {
      now: now.getTime(),
      tz,
      coarseOnly: true,
    });
  } catch {
    return undefined;
  }
  const monthly = series.monthBand.map(
    (b) =>
      [b.bucketStart, b.mean, b.min, b.max] as [string, number, number, number],
  );
  const yearly = series.yearBand.map(
    (b) =>
      [b.bucketStart, b.mean, b.min, b.max] as [string, number, number, number],
  );
  if (
    monthly.length === 0 &&
    yearly.length === 0 &&
    series.anomalies.length === 0
  ) {
    return undefined;
  }
  return {
    monthly,
    yearly,
    anomalies: series.anomalies.map((a) => ({
      band: a.band,
      date: a.date,
      kind: a.kind,
      value: a.value,
      deltaSd: a.deltaSd,
    })),
  };
}

/**
 * Pair systolic + diastolic into one row per day. Days with only one
 * side measured are dropped — the Coach is asked about "BP" as a pair,
 * and a half-measured day would invite a fabricated complement.
 */
function buildDailyBpRows(
  sysRows: Array<{ measuredAt: Date; value: number }>,
  diaRows: Array<{ measuredAt: Date; value: number }>,
  recentCutoff: Date,
  tz: string,
): DailyBpRow[] {
  const sysRecent = sysRows.filter((r) => r.measuredAt >= recentCutoff);
  const diaRecent = diaRows.filter((r) => r.measuredAt >= recentCutoff);
  const sysByDay = dailyMeans(sysRecent, tz);
  const diaByDay = dailyMeans(diaRecent, tz);
  const out: DailyBpRow[] = [];
  for (const [day, info] of sysByDay) {
    const dia = diaByDay.get(day);
    if (!dia) continue;
    const sysMean = info.values.reduce((s, v) => s + v, 0) / info.values.length;
    const diaMean = dia.values.reduce((s, v) => s + v, 0) / dia.values.length;
    out.push({
      date: day,
      weekday: tzWeekday(info.date, tz),
      sys: Math.round(sysMean),
      dia: Math.round(diaMean),
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Resolve the working scope. The explicit request `scope.sources`
 * always wins as the maximum set (an iOS client can pin an exact
 * list). When it is absent the builder expands the user's saved
 * `dataClusters` instead — `clusterDefault` carries that expansion.
 * When neither is present (no prefs row at all, legacy native client)
 * the cluster resolver still returns `DEFAULT_COACH_CLUSTERS`, so the
 * legacy five domains stay the floor.
 *
 * v1.7.0 — replaces the constant `DEFAULT_SOURCES` fallback with the
 * cluster expansion threaded in by `buildCoachSnapshotImpl`.
 */
function resolveScope(
  scope: CoachScope | undefined,
  clusterDefault: ReadonlySet<CoachScopeSource>,
): {
  sources: ReadonlySet<CoachScopeSource>;
  window: CoachScopeWindow;
} {
  const sources =
    scope?.sources && scope.sources.length > 0
      ? new Set(scope.sources)
      : clusterDefault;
  return {
    sources,
    window: scope?.window ?? DEFAULT_WINDOW,
  };
}

/**
 * v1.4.33 — 60-second in-memory cache for `buildCoachSnapshot()`. The
 * snapshot reads only persisted data; a single chat conversation sends
 * 2-4 turns within a minute and the snapshot would otherwise rebuild
 * from the same rows each turn. Caching the result for 60s shaves the
 * ~10 measurement reads + the GLP-1 / mood / intake side-fetches off
 * every turn after the first, which `.planning/round-v1433-audit-perf.md`
 * §3.3 estimates at 200-800 ms of server-side tail.
 *
 * Scope is part of the cache key so a switch from `last30days` to
 * `last7days` (or a different `sources` set) computes fresh. The map
 * is bounded at 64 entries — a multi-tenant deployment with a few
 * active power users sits well inside that ceiling even if each cycles
 * through several scopes per minute.
 */
const SNAPSHOT_TTL_MS = 60_000;
const SNAPSHOT_LRU_MAX = 64;
const snapshotCache = new Map<
  string,
  { expiresAt: number; result: CoachSnapshotResult }
>();

function snapshotCacheKey(
  userId: string,
  scope: CoachScope | undefined,
): string {
  // v1.7.0 — when the request pins an explicit source list, key on it.
  // Otherwise the source set is derived from the user's saved
  // `dataClusters`, which we don't read here (the cache must stay
  // I/O-free on a hit) — key on a stable `clusters` marker instead.
  // A cluster change is reflected on the next cache miss (≤60 s), the
  // same staleness window every other pref change already tolerates.
  const window = scope?.window ?? DEFAULT_WINDOW;
  const sourceList =
    scope?.sources && scope.sources.length > 0
      ? Array.from(scope.sources).sort().join(",")
      : "clusters";
  return `${userId}|${window}|${sourceList}`;
}

function readSnapshotCache(key: string): CoachSnapshotResult | null {
  const entry = snapshotCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    snapshotCache.delete(key);
    return null;
  }
  // Touch for LRU — re-insert moves to the end of the Map's iteration order.
  snapshotCache.delete(key);
  snapshotCache.set(key, entry);
  return entry.result;
}

function writeSnapshotCache(key: string, result: CoachSnapshotResult): void {
  if (snapshotCache.size >= SNAPSHOT_LRU_MAX) {
    // Evict the oldest entry — JS Map iteration order is insertion order,
    // so the first key is the least-recently inserted/touched.
    const oldest = snapshotCache.keys().next().value;
    if (oldest !== undefined) {
      snapshotCache.delete(oldest);
    }
  }
  snapshotCache.set(key, {
    expiresAt: Date.now() + SNAPSHOT_TTL_MS,
    result,
  });
}

/** Clear the snapshot cache. Test-only escape hatch. */
export function __resetCoachSnapshotCacheForTests(): void {
  snapshotCache.clear();
}

/**
 * Build the Coach prompt snapshot for `userId`. Always uses
 * `includeRaw=false` because the Coach replies are conversational and
 * the user is asking the model — they should never depend on raw
 * measurement timestamps that the privacy mode controls.
 *
 * The snapshot now carries two sections per active metric:
 *   - aggregate: the v1.4.20 shape (mean, slope, SD, range, count)
 *   - timeline.recent: last `DAILY_TIMELINE_DAYS` days as raw daily
 *     values with weekday labels so the Coach can answer
 *     day/weekday-specific questions
 *   - timeline.weekly: ISO-week buckets covering the rest of the
 *     window so the Coach can still cite older weeks without ballooning
 *     the prompt
 *
 * v1.4.25 W7b — every day-key + weekday label is now anchored to the
 * user's display timezone (read from `User.timezone`). Falls back to
 * Europe/Berlin when the column is missing so the legacy snapshot
 * stays byte-identical for the only path the v1.4.24 suite tested.
 *
 * v1.4.33 — wraps the previous `buildCoachSnapshotImpl` with a 60s
 * in-memory LRU keyed on `(userId, window, sources)`. The Coach's
 * chat handler calls this once per turn; within the same conversation
 * the second+ turn lands a cache hit and skips the row-level reads.
 */
export async function buildCoachSnapshot(
  userId: string,
  scope?: CoachScope,
): Promise<CoachSnapshotResult> {
  const key = snapshotCacheKey(userId, scope);
  const cached = readSnapshotCache(key);
  if (cached) return cached;
  const result = await buildCoachSnapshotImpl(userId, scope);
  writeSnapshotCache(key, result);
  return result;
}

async function buildCoachSnapshotImpl(
  userId: string,
  scope?: CoachScope,
): Promise<CoachSnapshotResult> {
  // v1.4.23 H4 — apply per-user `excludeMetrics` BEFORE we read any
  // measurement rows so the model never sees data the user opted out
  // of. The filter intersects with the resolved scope (the explicit
  // `scope` argument from the request body still wins for the
  // _maximum_ set; prefs only narrow further).
  //
  // v1.4.25 W7b — the same prefs read also returns the user's
  // displayTimezone so the day-key and weekday labels below match the
  // calendar the user is looking at. Reading both columns in one
  // query keeps the snapshot's read budget the same as before.
  //
  // v1.7.0 — the prefs read now also drives the source default: when
  // the request omits an explicit `scope.sources`, the resolved scope
  // expands the user's saved `dataClusters` (legacy default when the
  // key is absent). So the prefs read must precede `resolveScope`.
  // v1.18.0 — resolve the per-user module map once at build start so a
  // disabled data-domain module's data never enters the coach context.
  // The map read is memoised per-request by the gate, and runs alongside
  // the prefs read (both only need `userId`), so the cold path pays a
  // single extra round-trip at most. Disabled modules fold into the same
  // SYSTEM-side exclusion the user's `excludeMetrics` flow already drives.
  const moduleMapPromise = resolveModuleMap(userId);
  // v1.20.0 (H-1) — the F1 coach tools each rebuild a single-source snapshot
  // with a distinct LRU key, so the 60s snapshot cache does not share this read
  // across the fan-out. Memoise it per-request (the select shape is constant, so
  // userId is the only key) so up to 6 concurrent tool builds collapse to one
  // prefs round-trip instead of starving the shared Prisma pool.
  const prefsRow = await memoizePerRequest(`coach-prefs:${userId}`, () =>
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        coachPrefsJson: true,
        timezone: true,
        locale: true,
        // v1.11.5 — needed to collapse a dual-source sleep night to one
        // canonical source before reconstructing per-night asleep totals.
        sourcePriorityJson: true,
        // v1.15 — the cycle snapshot block is gated on the resolved cycle
        // toggle (an explicit opt-in/out overrides the gender default). Read
        // both columns here so a non-cycle account pays no extra round-trip.
        gender: true,
        cycleProfile: { select: { cycleTrackingEnabled: true } },
        // v1.16.16 — the glucose block converts canonical mg/dL to the user's
        // display unit so the Coach reads the same number every other surface
        // shows. Read it on this existing prefs hop (no extra round-trip).
        glucoseUnit: true,
        // v1.18.6 (W7) — the explicit, user-declared diabetes opt-in. Selects
        // the tighter ADA glycemic GOAL band for the glucose reference-grounding
        // line only; never inferred from a reading, never a diagnosis. Read on
        // this existing prefs hop (no extra round-trip).
        hasDiabetes: true,
      },
    }),
  );
  const prefs = parseCoachPrefs(prefsRow?.coachPrefsJson);
  // Resolve the UI locale for the rolling-profile narrative recall. The
  // narrative rows are keyed by ("de" | "en"); default to "de" (the app
  // default locale) when the user never picked one.
  const coachLocale: "de" | "en" = prefsRow?.locale === "en" ? "en" : "de";
  const clusterDefault = clusterSourcesFromPrefs(prefs.dataClusters);
  const { sources: scopedSources, window } = resolveScope(
    scope,
    clusterDefault,
  );
  const userTz = prefsRow?.timezone ?? DEFAULT_TIMEZONE;
  const glucoseUnit = resolveGlucoseUnit(prefsRow?.glucoseUnit ?? null);
  // v1.18.0 — fold disabled data-domain modules into the system exclusion.
  // `moduleMap[key] === false` means the user turned that module off; the
  // gate has already resolved every delegation (cycle/coach) so this map
  // is authoritative. We union the disabled modules' owned sources into
  // `excluded` so the existing source-narrowing path below removes them
  // before any row is read — the model never sees a disabled domain.
  const moduleMap = await moduleMapPromise;
  const recoveryDisabled = moduleMap.recovery === false;
  const excluded = new Set<CoachExcludeMetric>(prefs.excludeMetrics);
  for (const [key, srcs] of Object.entries(MODULE_EXCLUDED_SOURCES)) {
    if (moduleMap[key as ModuleKey] === false) {
      for (const src of srcs ?? []) {
        // Every entry in MODULE_EXCLUDED_SOURCES is a CoachScopeSource that
        // also exists in the CoachExcludeMetric enum overlap the
        // source-narrowing loop checks against; the cast mirrors the one the
        // loop already uses below.
        excluded.add(src as unknown as CoachExcludeMetric);
      }
    }
  }
  // v1.4.36 W3 T2 — `medications` and `anthropometrics` are
  // exclude-only toggles (not in `CoachScopeSource`); they gate the
  // GLP-1 weeklyContext / compliance branch and the anthropometrics
  // block respectively. The mapping below treats them as additive to
  // the existing source-level exclusions.
  const excludesMedications = excluded.has("medications");
  const excludesAnthropometrics = excluded.has("anthropometrics");
  const sources = new Set<CoachScopeSource>();
  for (const src of scopedSources) {
    // The `excludeMetrics` enum is a superset of `CoachScopeSource` now
    // (medications + anthropometrics live on the exclude-only side);
    // the cast was safe before v1.4.36 because the enums matched 1:1,
    // and the runtime `excluded.has` check still only catches the
    // overlapping members.
    if (!excluded.has(src as unknown as CoachExcludeMetric)) {
      sources.add(src);
    }
  }
  // `medications` exclusion also drops the compliance source so the
  // intake-event branch below short-circuits — keeps the contract
  // consistent (excluding medications == no medication data at all).
  if (excludesMedications) {
    sources.delete("compliance");
  }

  const windowDays = windowToDays(window);
  // v1.11.3 — kick the feature extraction off as a promise now and await
  // it alongside the shared measurement read below. `extractFeatures`
  // and the measurement `findMany` are independent (each only needs
  // `userId` + the resolved window/sources), so running them
  // concurrently shaves a round-trip off the cold path. No block reads
  // `features` before the shared await, so the deferral is safe.
  // v1.20.0 (H-1) — `extractFeatures` is the heaviest read on the cold path
  // (user findUnique + a windowed measurement findMany + the all-time extremes).
  // The F1 tools rebuild distinct-scope snapshots whose LRU keys differ, so they
  // do not share this read; memoise it per-request keyed on the only varying
  // input (windowDays) so the fan-out runs it once instead of up to 6× against
  // the shared pool.
  const featuresPromise = memoizePerRequest(
    `coach-features:${userId}:${windowDays}`,
    () => extractFeatures(userId, false, { sinceDays: windowDays }),
  );

  // Trim down to the metrics the Coach narrates. extractFeatures
  // returns more (sleep, steps, etc.) — the Coach surface keeps the
  // snapshot tight so each turn fits inside the provider's context
  // budget for free-tier accounts.
  const snapshot: Record<string, unknown> = {};
  const windows = new Set<CoachProvenance["windows"][number]>();
  // v1.4.27 B7 / BL-P6-4 — seed the provenance window set with the
  // user's resolved scope so the year-in-review window surfaces in the
  // provenance envelope even when the per-metric branches below only
  // emit `last30days` / `last90days` chips. Older windows are added
  // by the metric branches as before.
  if (window === "lastYear" || window === "allTime") {
    windows.add(window);
  }
  const metrics = new Set<CoachProvenance["metrics"][number]>();
  const counts: NonNullable<CoachProvenance["counts"]> = {};

  // v1.18.6 (W7) — representative scalar per reference-covered metric, in the
  // metric's reference unit, collected as the blocks below build. Feeds the
  // citation-aware grounding block (population band + the user's placement).
  // Each entry reads the SAME number the snapshot already surfaces — no
  // independent recompute — so the grounding can never cite a value the
  // snapshot doesn't carry. A metric with a block but no clean scalar is left
  // unset (the grounding line still cites its band with an insufficient
  // placement only if it is added with a null value; we omit such metrics).
  const groundingValues = new Map<ReferenceMetric, number>();
  // Additive `MeasurementType` → reference metric, for the value-block loop.
  const TYPE_TO_REFERENCE_METRIC: Record<string, ReferenceMetric> = {
    RESTING_HEART_RATE: "RESTING_HEART_RATE",
    OXYGEN_SATURATION: "OXYGEN_SATURATION",
    RESPIRATORY_RATE: "RESPIRATORY_RATE",
    PULSE_WAVE_VELOCITY: "PULSE_WAVE_VELOCITY",
    BODY_TEMPERATURE: "BODY_TEMPERATURE",
    BODY_MASS_INDEX: "BMI",
    VISCERAL_FAT: "VISCERAL_FAT",
    ACTIVITY_STEPS: "STEPS",
  };
  /** Mean of the most recent N daily-value rows (already user-tz day means). */
  const recentRowsMean = (
    rows: DailyValueRow[],
    take = DAILY_TIMELINE_DAYS,
  ): number | null => {
    if (rows.length === 0) return null;
    const slice = rows.slice(-take);
    const sum = slice.reduce((s, r) => s + r.value, 0);
    return sum / slice.length;
  };

  // v1.7.0 — block registry. Maps each emitted snapshot top-level key
  // to the cluster it belongs to so the soft-cap degradation pass
  // (below) can walk blocks in reverse cluster-priority order and shed
  // the lowest-signal detail first. Core legacy blocks register too so
  // the degrader can reach them as a last resort.
  const blockClusters = new Map<string, CoachDataCluster>();
  // Snapshot top-level keys that carry an `aggregate` companion — the
  // degrader can drop `timeline.recent` from these and still leave the
  // aggregate for the Coach to reason from.
  const registerBlock = (key: string, source: CoachScopeSource) => {
    const cluster = sourceCluster(source);
    if (cluster) blockClusters.set(key, cluster);
  };

  // Pull raw measurement rows once for the configured window so day
  // and week buckets share a single I/O hop. Mood + compliance live in
  // separate tables and are loaded conditionally below.
  const now = new Date();
  const cutoff = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const recentCutoff = new Date(
    now.getTime() - DAILY_TIMELINE_DAYS * 24 * 60 * 60 * 1000,
  );

  // v1.7.0 — when many clusters are active, cap the timeline read
  // window for the ADDITIVE (non-core) clusters so a 10-cluster /
  // allTime request cannot fan a dense timeline across every series at
  // once. The core clinical clusters keep the user-chosen window.
  const activeClusters = new Set<CoachDataCluster>();
  for (const src of sources) {
    const c = sourceCluster(src);
    if (c) activeClusters.add(c);
  }
  const multiClusterCapActive = activeClusters.size > MULTI_CLUSTER_THRESHOLD;
  // v1.7.0 — record which clusters resolved active for this build so
  // the observability dashboards can track cluster adoption + the
  // multi-cluster cap firing rate.
  annotate({
    action: { name: "coach.clusters.resolved" },
    meta: {
      active: Array.from(activeClusters).sort(),
      window,
      multiClusterCap: multiClusterCapActive,
    },
  });
  const additiveCapDays = windowToDays(MULTI_CLUSTER_WINDOW_CAP);
  const additiveCapCutoff = new Date(
    now.getTime() - additiveCapDays * 24 * 60 * 60 * 1000,
  );
  // Effective `cutoff` for an additive block under the multi-cluster
  // cap — the later of the window cutoff and the cap cutoff. Core
  // clusters always use the full window cutoff.
  const additiveCutoff = (source: CoachScopeSource): Date => {
    const cluster = sourceCluster(source);
    if (
      multiClusterCapActive &&
      cluster !== null &&
      !CORE_CLUSTERS.has(cluster) &&
      additiveCapCutoff > cutoff
    ) {
      return additiveCapCutoff;
    }
    return cutoff;
  };

  const wantsBp = sources.has("bp");
  const wantsWeight = sources.has("weight");
  const wantsPulse = sources.has("pulse");
  const wantsMood = sources.has("mood");
  const wantsCompliance = sources.has("compliance");

  // v1.18.7 — coarse tail (90d–1y MONTH + >1y YEAR) + anomaly envelope for the
  // core clinical metrics, from the shared tiered-context builder. Only the
  // bands the in-window weekly-fold cannot produce are fetched here; the recent
  // + weekly bands stay as built below. Bounded per-band, so this holds or
  // reduces the per-metric token cost while letting the Coach see a spike from
  // months ago. Reads never throw — a coverage miss yields `undefined`, the
  // block is then omitted. Run in parallel; awaited at the block site.
  const coarseTailPromises: Partial<
    Record<"bp" | "weight" | "pulse", Promise<CoarseTimelineTail | undefined>>
  > = {};
  if (wantsBp) {
    coarseTailPromises.bp = buildCoarseTimelineTail(
      userId,
      "BLOOD_PRESSURE_SYS" as MeasurementType,
      now,
      userTz,
    );
  }
  if (wantsWeight) {
    coarseTailPromises.weight = buildCoarseTimelineTail(
      userId,
      "WEIGHT" as MeasurementType,
      now,
      userTz,
    );
  }
  if (wantsPulse) {
    coarseTailPromises.pulse = buildCoarseTimelineTail(
      userId,
      "PULSE" as MeasurementType,
      now,
      userTz,
    );
  }
  const [bpCoarseTail, weightCoarseTail, pulseCoarseTail] = await Promise.all([
    coarseTailPromises.bp ?? Promise.resolve(undefined),
    coarseTailPromises.weight ?? Promise.resolve(undefined),
    coarseTailPromises.pulse ?? Promise.resolve(undefined),
  ]);

  // v1.4.23 W6 (S-04) — single source of truth for the
  // CoachScopeSource → MeasurementType[] mapping. Drives both the
  // SQL `WHERE type IN (…)` build below and the Apple-Health timeline
  // block table downstream, so adding a new metric is one entry
  // instead of three (boolean + push + appleHealthBlocks row).
  // Default Coach scope leaves the Apple Health rows off; non-iOS
  // accounts never pay the type-IN overhead because their `sources`
  // set never enables them.
  // v1.7.0 — extended with the full clustered taxonomy. `mood`,
  // `compliance`, and `workouts` map to no `MeasurementType` because
  // they read separate models (MoodEntry / MedicationIntakeEvent /
  // Workout) and are handled by their own branches below. `glucose`
  // also reads `Measurement` but needs the `glucoseContext` column, so
  // its block is built separately rather than from the shared
  // `byType()` rows.
  const METRIC_TYPES: Record<CoachScopeSource, string[]> = {
    bp: ["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"],
    weight: ["WEIGHT"],
    pulse: ["PULSE"],
    mood: [],
    compliance: [],
    hrv: ["HEART_RATE_VARIABILITY"],
    sleep: ["SLEEP_DURATION"],
    resting_hr: ["RESTING_HEART_RATE"],
    steps: ["ACTIVITY_STEPS"],
    active_energy: ["ACTIVE_ENERGY_BURNED"],
    flights: ["FLIGHTS_CLIMBED"],
    distance: ["WALKING_RUNNING_DISTANCE"],
    vo2_max: ["VO2_MAX"],
    body_temp: ["BODY_TEMPERATURE"],
    // ── cardio composition / vascular ──
    walking_hr: ["WALKING_HEART_RATE_AVERAGE"],
    respiratory_rate: ["RESPIRATORY_RATE"],
    spo2: ["OXYGEN_SATURATION"],
    pulse_wave_velocity: ["PULSE_WAVE_VELOCITY"],
    vascular_age: ["VASCULAR_AGE"],
    // ── body composition ──
    body_fat: ["BODY_FAT"],
    fat_mass: ["FAT_MASS"],
    fat_free_mass: ["FAT_FREE_MASS"],
    muscle_mass: ["MUSCLE_MASS"],
    lean_body_mass: ["LEAN_BODY_MASS"],
    bone_mass: ["BONE_MASS"],
    total_body_water: ["TOTAL_BODY_WATER"],
    bmi: ["BODY_MASS_INDEX"],
    visceral_fat: ["VISCERAL_FAT"],
    // ── metabolic — built via the dedicated glucose branch ──
    glucose: ["BLOOD_GLUCOSE"],
    // ── mobility & gait ──
    walking_steadiness: ["WALKING_STEADINESS"],
    walking_asymmetry: ["WALKING_ASYMMETRY"],
    walking_double_support: ["WALKING_DOUBLE_SUPPORT"],
    walking_step_length: ["WALKING_STEP_LENGTH"],
    walking_speed: ["WALKING_SPEED"],
    // ── environment / exposure ──
    audio_env: ["AUDIO_EXPOSURE_ENV"],
    audio_headphone: ["AUDIO_EXPOSURE_HEADPHONE"],
    audio_event: ["AUDIO_EXPOSURE_EVENT"],
    daylight: ["TIME_IN_DAYLIGHT"],
    skin_temp: ["SKIN_TEMPERATURE"],
    // ── workouts — read from the Workout model, not Measurement ──
    workouts: [],
  };

  // Single fetch for all measurement types — Prisma's filter pushes
  // the type list into one SQL `WHERE type IN (…)` so we don't pay
  // per-metric round-trips.
  const wantedTypes = Array.from(sources).flatMap(
    (source) => METRIC_TYPES[source] ?? [],
  );

  const measurementRowsPromise =
    wantedTypes.length > 0
      ? prisma.measurement
          .findMany({
            where: {
              userId,
              type: { in: wantedTypes as never[] },
              measuredAt: { gte: cutoff },
              deletedAt: null,
            },
            // v1.18.10 (P-2) — read NEWEST-first + cap. PULSE / glucose are
            // 200k-row-class types and the window can reach 365 days
            // (lastYear / allTime), so an uncapped read pulled the entire
            // year of high-frequency rows into memory just to fold them into
            // ~21 daily + ~10 weekly buckets the prompt actually shows. The
            // newest-first cap keeps the recent-daily timeline exact and only
            // sheds the deepest weekly buckets on an extreme-volume account;
            // the coarse MONTH/YEAR tail is read separately from the rollup
            // tier (`buildCoarseTimelineTail`), so deep history survives.
            orderBy: { measuredAt: "desc" },
            take: SNAPSHOT_MEASUREMENT_ROW_CAP,
            // v1.7.0 — `glucoseContext` rides along so the glucose block
            // can split fasting / postprandial / random / bedtime without
            // a second query. NULL on every non-glucose row.
            select: {
              type: true,
              value: true,
              measuredAt: true,
              glucoseContext: true,
            },
          })
          // Downstream bucketers re-sort/group internally, but restore
          // ascending order so any order-sensitive consumer sees the same
          // shape as before the cap.
          .then((rows) => rows.reverse())
      : Promise.resolve([]);

  // v1.11.3 — `extractFeatures` and the shared measurement read are
  // mutually independent and both gate the blocks below (every aggregate
  // reads `features`; bp/weight/pulse/glucose read `measurementRows`), so
  // run the two concurrently and resolve them in a single hop.
  const [features, measurementRows] = await Promise.all([
    featuresPromise,
    measurementRowsPromise,
  ]);

  // v1.11.3 — the remaining cold-path reads are mutually independent:
  // the four conditional table reads (mood / compliance / sleep /
  // workouts) and the four helper-block reads (GLP-1 / derived /
  // trajectory / memory) each consume only `userId`, the window cutoff,
  // or the synchronously-derived `derivedProfile` — none reads another's
  // result. Fire them all off concurrently now, KEEPING the original
  // `wants…` / `sources.has(…)` guards so a disabled source still issues
  // no query (the guard yields `null`/`undefined`, never a wasted
  // round-trip), then await the batch in one hop. The synchronous block
  // assembly further below consumes the resolved values in the original
  // order, so provenance and block-registration order are unchanged.
  //
  // `derivedProfile` is derived from `features.context` (now resolved)
  // and feeds the GLP-1 / derived / trajectory / memory readers; it is
  // hoisted here so those reads can start immediately.
  const derivedSources: CoachScopeSource[] = [
    "hrv",
    "resting_hr",
    "sleep",
    "vo2_max",
  ];
  const derivedCtx = features.context;
  const derivedProfile: BaselineProfile = {
    ageYears: derivedCtx?.ageYears ?? null,
    sex:
      derivedCtx?.gender === "MALE" || derivedCtx?.gender === "FEMALE"
        ? (derivedCtx.gender as "MALE" | "FEMALE")
        : null,
    heightCm: derivedCtx?.heightCm ?? null,
  };
  // v1.18.0 — the derived block + WHOOP-native dayStrain + trajectory are
  // the `recovery` module's domain (READINESS / RECOVERY_SCORE / STRAIN /
  // …). They are gated on `derivedActive`, which still reads the `sleep`
  // signal — so when `recovery` is disabled but `sleep` stays on, gate them
  // off explicitly here, not just by dropping the recovery source tokens.
  const derivedActive =
    !recoveryDisabled && derivedSources.some((s) => sources.has(s));

  const moodRowsPromise =
    wantsMood && features.mood
      ? prisma.moodEntry.findMany({
          // v1.7.0 sync — exclude tombstoned rows from the Coach snapshot.
          where: { userId, deletedAt: null, moodLoggedAt: { gte: cutoff } },
          orderBy: { moodLoggedAt: "asc" },
          select: { moodLoggedAt: true, score: true },
        })
      : null;
  // v1.16.9 — the adherence timeline derives from the LEDGER tally (the
  // same band engine the compliance % + dose history consume), not from a
  // raw intake-row count. The raw count read a worker-minted pending row
  // as "not taken" (today's later doses dragged the day's rate down all
  // morning) and double-counted cross-source duplicate rows on one slot.
  // Load each medication's schedules + eras + window events so the ledger
  // can be reconstructed per medication.
  const complianceMedsPromise = wantsCompliance
    ? prisma.medication.findMany({
        // v1.16.11 — as-needed (PRN) medications never reach the Coach
        // compliance context (no expected doses, no rate).
        where: { userId, asNeeded: false },
        select: {
          id: true,
          startsOn: true,
          endsOn: true,
          oneShot: true,
          createdAt: true,
          schedules: { select: SCHEDULE_COMPLIANCE_SELECT },
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
          intakeEvents: {
            // Tombstoned intake rows must never reach the Coach snapshot.
            where: { deletedAt: null, scheduledFor: { gte: cutoff } },
            orderBy: { scheduledFor: "asc" },
            select: {
              scheduledFor: true,
              takenAt: true,
              skipped: true,
              autoMissed: true,
              attributionSource: true,
            },
          },
        },
      })
    : null;
  const sleepRowsPromise = sources.has("sleep")
    ? prisma.measurement.findMany({
        where: {
          userId,
          type: "SLEEP_DURATION" as never,
          measuredAt: { gte: additiveCutoff("sleep") },
          deletedAt: null,
        },
        orderBy: { measuredAt: "asc" },
        // Writer-level collapse: two HealthKit apps behind one source
        // (watch stages vs phone in-bed) must not blend into one night.
        select: {
          value: true,
          measuredAt: true,
          sleepStage: true,
          source: true,
          deviceType: true,
        },
      })
    : null;
  // v1.17.0 — sleep-rhythm rows. The sleep-debt + chronotype DTO is a fixed
  // trailing-42-day artifact (the Sleep page + dashboard read the same window),
  // so it must NOT ride the coach's variable narration window or the
  // multi-cluster timeline cap, or the coach would quote a debt / chronotype
  // band the page never shows. Read the rhythm's own trailing-42-day rows
  // directly (one indexed query, only when the sleep cluster is active) and
  // hand them to the SAME assembler the dashboard route uses. The per-stage
  // narration timeline above keeps using the coach-window `sleepRows`.
  const sleepRhythmCutoff = new Date(
    now.getTime() - SLEEP_RHYTHM_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
  const sleepRhythmRowsPromise = sources.has("sleep")
    ? prisma.measurement.findMany({
        where: {
          userId,
          type: "SLEEP_DURATION" as never,
          measuredAt: { gte: sleepRhythmCutoff },
          deletedAt: null,
        },
        orderBy: { measuredAt: "asc" },
        // source + deviceType feed the canonical writer-dedup so a multi-source
        // night is counted ONCE, matching every other sleep surface.
        select: {
          value: true,
          measuredAt: true,
          sleepStage: true,
          source: true,
          deviceType: true,
        },
      })
    : null;
  const workoutRowsPromise = sources.has("workouts")
    ? prisma.workout.findMany({
        where: { userId, startedAt: { gte: additiveCutoff("workouts") } },
        orderBy: { startedAt: "desc" },
        select: {
          sportType: true,
          startedAt: true,
          durationSec: true,
          totalEnergyKcal: true,
          totalDistanceM: true,
          avgHeartRate: true,
          maxHeartRate: true,
        },
      })
    : null;
  // v1.17.0 — the glucose CLINICAL panel is a fixed 30-day clinical artifact,
  // identical to the one the insights panel + doctor report render. It must NOT
  // ride the coach's variable narration window (7/30/90/365) or the
  // multi-cluster timeline cap, or the coach would quote a TIR/GMI/CV% the panel
  // never shows. So read the panel's own trailing-30-day glucose rows directly
  // (one indexed query, only when glucose is active) and compute the clinical
  // block off THOSE rows. The per-context narration timelines below keep using
  // the coach-window rows — only the clinical summary is pinned to 30 days.
  const glucoseClinicalCutoff = new Date(
    now.getTime() - GLUCOSE_CLINICAL_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
  const glucoseClinicalRowsPromise = sources.has("glucose")
    ? prisma.measurement.findMany({
        where: {
          userId,
          type: "BLOOD_GLUCOSE" as never,
          measuredAt: { gte: glucoseClinicalCutoff },
          deletedAt: null,
        },
        orderBy: { measuredAt: "asc" },
        select: { value: true, measuredAt: true },
      })
    : null;
  const glp1BlockPromise = excludesMedications
    ? null
    : buildGlp1SnapshotBlock(userId, now);
  const derivedBlockPromise = derivedActive
    ? buildDerivedSnapshotBlock(userId, derivedProfile, now)
    : null;
  // v1.17.0 — WHOOP-native day strain (0–21), distinct from the COMPUTED
  // STRAIN_SCORE (0–100) the derived block carries. Gated on the same
  // wellness/activity signals so it rides the existing parallel batch; the
  // block is omitted when the account has no DAY_STRAIN rows (every
  // non-WHOOP account). Native-over-computed mirrors how recovery resolves.
  const dayStrainRowsPromise = derivedActive
    ? prisma.measurement.findMany({
        where: {
          userId,
          type: "DAY_STRAIN",
          measuredAt: { gte: cutoff },
          deletedAt: null,
        },
        orderBy: { measuredAt: "asc" },
        select: { value: true, measuredAt: true },
      })
    : null;
  const trajectoryBlockPromise = derivedActive
    ? buildTrajectorySnapshotBlock(userId, derivedProfile, now)
    : null;
  const memoryBlockPromise = buildCoachMemoryBlock(
    userId,
    derivedProfile,
    now,
    coachLocale,
  );
  // v1.15 — cycle/phase block, gated on the resolved cycle module so a
  // non-cycle account issues no query (the helper short-circuits to null
  // before any read for a disabled account). The block is descriptive only —
  // current phase + day-of-cycle, the next predicted event (period range,
  // fertile window goal-gated), and the headline phase-correlation finding.
  // v1.18.0 — the gate is the FULLY-resolved cycle module
  // (`isCycleAvailableForUser` → the per-user toggle AND the operator
  // server-wide kill-switch), so an operator-off instance never injects the
  // cycle block into the coach prompt.
  const cycleEnabled = await isCycleAvailableForUser(userId);
  const cycleBlockPromise = cycleEnabled
    ? buildCycleSnapshotBlock(userId, prefsRow?.gender, now, userTz)
    : null;

  // v1.18.1 P4 — illness/condition context. Always attempted (the helper is
  // module-gated internally and short-circuits to null for a non-illness
  // account). It is CONTEXT, not a scope-gated metric: appended like
  // anthropometrics/scope below without a `registerBlock` so the budget
  // degrader never sheds it — the Coach needs to know about Rest Mode.
  const illnessBlockPromise = buildIllnessSnapshotBlock(userId, now);

  // v1.18.11 (#65) — lab-result context. Like illness it is CONTEXT, not a
  // scope-gated metric: attached without a `registerBlock` so the budget
  // degrader never sheds it, and Labs is intentionally not module-gated (the
  // helper reads owner-scoped rows directly, mirroring `/api/labs`). The block
  // carries the most-recent resolved reading per biomarker (last 12 months,
  // capped) so the Coach can answer "what was my LDL" without re-deriving.
  const labsBlockPromise = buildLabsSnapshotBlock(userId, now);

  const [
    moodRows,
    complianceMeds,
    sleepRows,
    sleepRhythmRows,
    workoutRows,
    glucoseClinicalRows,
    glp1Block,
    derivedBlock,
    dayStrainRows,
    trajectoryBlock,
    memoryBlock,
    cycleBlock,
    illnessBlock,
    labsBlock,
  ] = await Promise.all([
    moodRowsPromise,
    complianceMedsPromise,
    sleepRowsPromise,
    sleepRhythmRowsPromise,
    workoutRowsPromise,
    glucoseClinicalRowsPromise,
    glp1BlockPromise,
    derivedBlockPromise,
    dayStrainRowsPromise,
    trajectoryBlockPromise,
    memoryBlockPromise,
    cycleBlockPromise,
    illnessBlockPromise,
    labsBlockPromise,
  ]);

  const byType = (t: string) =>
    measurementRows
      .filter((r) => r.type === t)
      .map((r) => ({
        measuredAt: r.measuredAt,
        value: r.value,
      }));

  if (wantsBp && features.bloodPressure) {
    const sysRows = byType("BLOOD_PRESSURE_SYS");
    const diaRows = byType("BLOOD_PRESSURE_DIA");
    const recentDaily = buildDailyBpRows(
      sysRows,
      diaRows,
      recentCutoff,
      userTz,
    );
    const olderSys = sysRows.filter((r) => r.measuredAt < recentCutoff);
    const olderDia = diaRows.filter((r) => r.measuredAt < recentCutoff);
    snapshot.bloodPressure = {
      aggregate: features.bloodPressure,
      timeline: {
        recent: recentDaily,
        weeklySys: bucketWeekly(olderSys, userTz),
        weeklyDia: bucketWeekly(olderDia, userTz),
        ...(bpCoarseTail ? { coarse: bpCoarseTail } : {}),
      },
    };
    metrics.add("bp");
    windows.add("last30days");
    windows.add("last90days");
    counts.bp = features.bloodPressure.coverage?.count ?? undefined;
    registerBlock("bloodPressure", "bp");
    // W7 grounding: systolic 30-day mean against the ESH 2023 office bands.
    const sys30 =
      features.bloodPressure.avgSys30 ?? features.bloodPressure.allTimeAvgSys;
    if (sys30 != null) groundingValues.set("BLOOD_PRESSURE", sys30);
  }
  if (wantsWeight && features.weight) {
    const rows = byType("WEIGHT");
    snapshot.weight = {
      aggregate: features.weight,
      timeline: {
        recent: buildDailyValueRows(rows, recentCutoff, userTz),
        weekly: bucketWeekly(
          rows.filter((r) => r.measuredAt < recentCutoff),
          userTz,
        ),
        ...(weightCoarseTail ? { coarse: weightCoarseTail } : {}),
      },
    };
    metrics.add("weight");
    windows.add("last7days");
    windows.add("last30days");
    counts.weight = features.weight.coverage?.count ?? undefined;
    registerBlock("weight", "weight");
    // W7 grounding: weight has no population band, but the derived BMI does.
    // Use the features-computed BMI (same value the weight tile shows) so the
    // grounding reads the WHO band. A dedicated BODY_MASS_INDEX block (below)
    // wins if the user also syncs a measured BMI series.
    if (features.weight.bmi != null) {
      groundingValues.set("BMI", features.weight.bmi);
    }
  }
  if (wantsPulse && features.pulse) {
    const rows = byType("PULSE");
    snapshot.pulse = {
      aggregate: features.pulse,
      timeline: {
        recent: buildDailyValueRows(rows, recentCutoff, userTz),
        weekly: bucketWeekly(
          rows.filter((r) => r.measuredAt < recentCutoff),
          userTz,
        ),
        ...(pulseCoarseTail ? { coarse: pulseCoarseTail } : {}),
      },
    };
    metrics.add("pulse");
    windows.add("last7days");
    windows.add("last30days");
    windows.add("last90days");
    counts.pulse = features.pulse.coverage?.count ?? undefined;
    registerBlock("pulse", "pulse");
  }
  if (wantsMood && features.mood && moodRows) {
    // Mood entries live on a separate model — read in parallel above.
    const normalised = moodRows.map((m) => ({
      measuredAt: m.moodLoggedAt,
      value: m.score,
    }));
    snapshot.mood = {
      aggregate: features.mood,
      timeline: {
        recent: buildDailyValueRows(normalised, recentCutoff, userTz),
        weekly: bucketWeekly(
          normalised.filter((r) => r.measuredAt < recentCutoff),
          userTz,
        ),
      },
    };
    metrics.add("mood");
    windows.add("last7days");
    windows.add("last30days");
    counts.mood = features.mood.coverage?.count ?? undefined;
    registerBlock("mood", "mood");
  }

  if (wantsCompliance && complianceMeds) {
    // Medication compliance lives outside the structured features today —
    // the legacy Coach surface labelled it as "general" provenance only.
    // v1.4.20.1 shipped a per-day adherence row; v1.16.9 derives it from
    // the band-engine LEDGER (the same expansion the compliance % and the
    // dose-history view consume): a slot counts against the rate only once
    // it is genuinely missed, a pending/upcoming slot never reads as "not
    // taken", deliberate skips and ad-hoc takes stay out of the
    // denominator, and cross-source duplicate rows collapse onto one slot.
    const ledgerRows: DoseHistoryRow[] = [];
    // v1.17 W1c — the coach's headline adherence figure routes through the
    // SAME `calculateCompliance(...).rate` ledger authority the medication
    // card shows (the ledger path, `medicationContext` supplied), so the
    // coach can never quote a denominator the card doesn't use. Per
    // medication we take the ledger numerator (on-time + late takes) and
    // denominator (taken + missed) and pool them across the user's
    // scheduled medications: for a single medication the headline equals
    // that med's card rate exactly; for several it is the dose-weighted
    // overall adherence (the same pooling the cross-med timeline below
    // already uses), never a per-day / per-week denominator of its own.
    let complianceTaken = 0;
    let complianceDenominator = 0;
    const windowDaysForRate = Math.max(
      1,
      Math.round((now.getTime() - cutoff.getTime()) / (24 * 60 * 60 * 1000)),
    );
    for (const med of complianceMeds) {
      if (med.schedules.length === 0) continue;
      const ctx = buildComplianceMedicationContext(
        med,
        lastNonSkippedTakenAt(med.intakeEvents),
        userTz,
      );
      ledgerRows.push(
        ...buildComplianceLedgerRows(
          med.intakeEvents,
          med.schedules,
          ctx,
          cutoff,
          now,
          now,
        ),
      );
      // The card's rate IS `calculateCompliance(...).rate` over the ledger;
      // aggregate the same taken / (taken + missed) counts here so the
      // coach's single headline % equals what the card renders.
      const result = calculateCompliance(
        med.intakeEvents,
        med.schedules,
        windowDaysForRate,
        med.createdAt,
        { now, medicationContext: ctx },
      );
      complianceTaken += result.taken;
      complianceDenominator += result.taken + result.missed;
    }
    // Countable rows: taken (on-time or late) or genuinely missed. The
    // pending / upcoming / skipped / ad-hoc rows carry no adherence signal.
    const countable = ledgerRows.filter(
      (r) =>
        r.status === "taken_on_time" ||
        r.status === "taken_late" ||
        r.status === "missed",
    );
    if (countable.length > 0) {
      const recent = countable.filter((r) => r.at >= recentCutoff);
      const olderRows = countable.filter((r) => r.at < recentCutoff);
      const isTaken = (r: DoseHistoryRow) =>
        r.status === "taken_on_time" || r.status === "taken_late";
      const recentByDay = new Map<
        string,
        { date: Date; total: number; taken: number }
      >();
      for (const r of recent) {
        const key = tzDayKey(r.at, userTz);
        const e = recentByDay.get(key) ?? {
          date: r.at,
          total: 0,
          taken: 0,
        };
        e.total += 1;
        if (isTaken(r)) e.taken += 1;
        recentByDay.set(key, e);
      }
      const recentRows = Array.from(recentByDay.entries())
        .map(([date, info]) => ({
          date,
          weekday: tzWeekday(info.date, userTz),
          rate: Math.round((info.taken / info.total) * 100) / 100,
          taken: info.taken,
          total: info.total,
        }))
        .sort((a, b) => a.date.localeCompare(b.date));
      const olderByWeek = new Map<string, { taken: number; total: number }>();
      for (const r of olderRows) {
        const key = isoWeekKey(r.at, userTz);
        const e = olderByWeek.get(key) ?? { taken: 0, total: 0 };
        e.total += 1;
        if (isTaken(r)) e.taken += 1;
        olderByWeek.set(key, e);
      }
      const weeklyRows = Array.from(olderByWeek.entries())
        .map(([weekISO, v]) => ({
          weekISO,
          rate: v.total > 0 ? Math.round((v.taken / v.total) * 100) / 100 : 0,
          taken: v.taken,
          total: v.total,
        }))
        .sort((a, b) => a.weekISO.localeCompare(b.weekISO));
      snapshot.compliance = {
        // v1.17 W1c — headline adherence % from the SAME ledger authority
        // (`calculateCompliance(...).rate`) the medication card shows: the
        // dose-weighted pool of taken / (taken + missed) across the user's
        // scheduled medications, so the coach quotes the card's figure
        // (single med) or its honest overall adherence (several meds) rather
        // than a per-day / per-week rate built off a different denominator.
        // Integer 0-100 to match the card's rounding; null when no scheduled
        // medication has any countable dose in the window.
        rate:
          complianceDenominator > 0
            ? Math.round((complianceTaken / complianceDenominator) * 100)
            : null,
        timeline: { recent: recentRows, weekly: weeklyRows },
      };
      metrics.add("compliance");
      counts.compliance = countable.length;
      registerBlock("compliance", "compliance");
    } else {
      // v1.7.0 — toggled-on cluster with no rows. Annotate so the
      // dashboards can distinguish "user has no medication data" from
      // "medication cluster was off".
      annotate({
        action: { name: "coach.cluster.empty_skipped" },
        meta: { cluster: "medication" },
      });
    }
  }

  // ── v1.4.23 Apple Health additive blocks ─────────────────────────
  //
  // Each new HealthKit-derived metric ships as a timeline-only block
  // (recent day rows + older weekly buckets). The aggregate features
  // pipeline doesn't carry them yet — that's a v1.5 follow-up — but
  // the timeline alone is enough for the Coach to ground "your HRV
  // last Tuesday was X" replies in real numbers without inventing a
  // baseline. The block is omitted entirely when the user has no rows
  // for that metric, so accounts without iOS data never see a void
  // section in the prompt.
  type ValueMetric = Exclude<
    CoachProvenanceMetric,
    "general" | "bp" | "weight" | "pulse" | "mood" | "compliance" | "glucose"
  >;
  type ValueBlock = {
    metric: ValueMetric;
    source: CoachScopeSource;
    snapshotKey: string;
    type: string;
  };
  // v1.4.23 W6 (S-04) / v1.7.0 — every single-`MeasurementType`
  // additive series ships as a timeline-only block (recent day rows +
  // older weekly buckets). One entry per source; `source` drives both
  // the `sources.has` gate and the cluster lookup (for the
  // multi-cluster window cap + degradation priority). `glucose` and
  // `workouts` are NOT in this table — they have dedicated branches
  // (glucose carries `glucoseContext`, workouts reads the Workout
  // model). The block is omitted entirely when the user has no rows,
  // so accounts without that data never see a void section.
  const valueBlocks: ValueBlock[] = [
    // ── cardio ──
    {
      metric: "hrv",
      source: "hrv",
      snapshotKey: "heartRateVariability",
      type: "HEART_RATE_VARIABILITY",
    },
    {
      metric: "resting_hr",
      source: "resting_hr",
      snapshotKey: "restingHeartRate",
      type: "RESTING_HEART_RATE",
    },
    {
      metric: "walking_hr",
      source: "walking_hr",
      snapshotKey: "walkingHeartRateAverage",
      type: "WALKING_HEART_RATE_AVERAGE",
    },
    {
      metric: "respiratory_rate",
      source: "respiratory_rate",
      snapshotKey: "respiratoryRate",
      type: "RESPIRATORY_RATE",
    },
    {
      metric: "spo2",
      source: "spo2",
      snapshotKey: "oxygenSaturation",
      type: "OXYGEN_SATURATION",
    },
    {
      metric: "pulse_wave_velocity",
      source: "pulse_wave_velocity",
      snapshotKey: "pulseWaveVelocity",
      type: "PULSE_WAVE_VELOCITY",
    },
    {
      metric: "vascular_age",
      source: "vascular_age",
      snapshotKey: "vascularAge",
      type: "VASCULAR_AGE",
    },
    // ── body composition ──
    {
      metric: "body_fat",
      source: "body_fat",
      snapshotKey: "bodyFat",
      type: "BODY_FAT",
    },
    {
      metric: "fat_mass",
      source: "fat_mass",
      snapshotKey: "fatMass",
      type: "FAT_MASS",
    },
    {
      metric: "fat_free_mass",
      source: "fat_free_mass",
      snapshotKey: "fatFreeMass",
      type: "FAT_FREE_MASS",
    },
    {
      metric: "muscle_mass",
      source: "muscle_mass",
      snapshotKey: "muscleMass",
      type: "MUSCLE_MASS",
    },
    {
      metric: "lean_body_mass",
      source: "lean_body_mass",
      snapshotKey: "leanBodyMass",
      type: "LEAN_BODY_MASS",
    },
    {
      metric: "bone_mass",
      source: "bone_mass",
      snapshotKey: "boneMass",
      type: "BONE_MASS",
    },
    {
      metric: "total_body_water",
      source: "total_body_water",
      snapshotKey: "totalBodyWater",
      type: "TOTAL_BODY_WATER",
    },
    {
      metric: "bmi",
      source: "bmi",
      snapshotKey: "bodyMassIndex",
      type: "BODY_MASS_INDEX",
    },
    {
      metric: "visceral_fat",
      source: "visceral_fat",
      snapshotKey: "visceralFat",
      type: "VISCERAL_FAT",
    },
    // ── activity ──
    {
      metric: "steps",
      source: "steps",
      snapshotKey: "steps",
      type: "ACTIVITY_STEPS",
    },
    {
      metric: "active_energy",
      source: "active_energy",
      snapshotKey: "activeEnergy",
      type: "ACTIVE_ENERGY_BURNED",
    },
    {
      metric: "flights",
      source: "flights",
      snapshotKey: "flightsClimbed",
      type: "FLIGHTS_CLIMBED",
    },
    {
      metric: "distance",
      source: "distance",
      snapshotKey: "walkingRunningDistance",
      type: "WALKING_RUNNING_DISTANCE",
    },
    {
      metric: "vo2_max",
      source: "vo2_max",
      snapshotKey: "vo2Max",
      type: "VO2_MAX",
    },
    // ── mobility & gait ──
    {
      metric: "walking_steadiness",
      source: "walking_steadiness",
      snapshotKey: "walkingSteadiness",
      type: "WALKING_STEADINESS",
    },
    {
      metric: "walking_asymmetry",
      source: "walking_asymmetry",
      snapshotKey: "walkingAsymmetry",
      type: "WALKING_ASYMMETRY",
    },
    {
      metric: "walking_double_support",
      source: "walking_double_support",
      snapshotKey: "walkingDoubleSupport",
      type: "WALKING_DOUBLE_SUPPORT",
    },
    {
      metric: "walking_step_length",
      source: "walking_step_length",
      snapshotKey: "walkingStepLength",
      type: "WALKING_STEP_LENGTH",
    },
    {
      metric: "walking_speed",
      source: "walking_speed",
      snapshotKey: "walkingSpeed",
      type: "WALKING_SPEED",
    },
    // ── environment / exposure ──
    {
      metric: "audio_env",
      source: "audio_env",
      snapshotKey: "audioExposureEnvironment",
      type: "AUDIO_EXPOSURE_ENV",
    },
    {
      metric: "audio_headphone",
      source: "audio_headphone",
      snapshotKey: "audioExposureHeadphone",
      type: "AUDIO_EXPOSURE_HEADPHONE",
    },
    {
      metric: "audio_event",
      source: "audio_event",
      snapshotKey: "audioExposureEvent",
      type: "AUDIO_EXPOSURE_EVENT",
    },
    {
      metric: "daylight",
      source: "daylight",
      snapshotKey: "timeInDaylight",
      type: "TIME_IN_DAYLIGHT",
    },
    {
      metric: "skin_temp",
      source: "skin_temp",
      snapshotKey: "skinTemperature",
      type: "SKIN_TEMPERATURE",
    },
    {
      metric: "body_temp",
      source: "body_temp",
      snapshotKey: "bodyTemperature",
      type: "BODY_TEMPERATURE",
    },
  ];
  for (const block of valueBlocks) {
    if (!sources.has(block.source)) continue;
    const blockCutoff = additiveCutoff(block.source);
    const rows = byType(block.type).filter((r) => r.measuredAt >= blockCutoff);
    if (rows.length === 0) {
      const cluster = sourceCluster(block.source);
      if (cluster) {
        annotate({
          action: { name: "coach.cluster.empty_skipped" },
          meta: { cluster, source: block.source },
        });
      }
      continue;
    }
    snapshot[block.snapshotKey] = {
      timeline: {
        recent: buildDailyValueRows(rows, recentCutoff, userTz),
        weekly: bucketWeekly(
          rows.filter((r) => r.measuredAt < recentCutoff),
          userTz,
        ),
      },
    };
    metrics.add(block.metric);
    counts[block.metric] = rows.length;
    registerBlock(block.snapshotKey, block.source);
    // W7 grounding: when this additive series maps to a reference metric,
    // record the recent daily mean (same per-day means the timeline shows).
    const refMetric = TYPE_TO_REFERENCE_METRIC[block.type];
    if (refMetric) {
      const recentRows = buildDailyValueRows(rows, recentCutoff, userTz);
      const mean = recentRowsMean(recentRows);
      if (mean != null) groundingValues.set(refMetric, mean);
    }
  }

  // ── v1.7.0 sleep block (with optional per-stage enrichment) ───────
  //
  // Sleep needs the `sleepStage` column so the Coach can narrate REM /
  // core / deep / awake minutes per night instead of a flat duration.
  // The shared `byType("SLEEP_DURATION")` rows above already cover the
  // duration timeline, but they drop the stage label — so the sleep
  // branch builds its own block. Per-night stage minutes come from a
  // dedicated read of the SLEEP_DURATION rows that carry a non-null
  // stage; the duration timeline is built from the same rows summed per
  // night (one night = the sum of its per-stage rows).
  if (sources.has("sleep") && sleepRows) {
    // The SLEEP_DURATION rows (with the `sleepStage` column) are read in
    // parallel above.
    if (sleepRows.length === 0) {
      annotate({
        action: { name: "coach.cluster.empty_skipped" },
        meta: { cluster: "sleep", source: "sleep" },
      });
    } else {
      // v1.11.5 — reconstruct per-night TIME-ASLEEP totals through the shared
      // helper so the Coach narrates the same nightly numbers every other
      // sleep surface shows: stages clustered into sessions, a dual-source
      // night collapsed to one canonical source, and the granular
      // CORE/DEEP/REM partition counted WITHOUT double-counting the bare
      // ASLEEP aggregate Apple Health writes alongside it. IN_BED + AWAKE are
      // excluded from the asleep total.
      const nights = reconstructSleepNights(
        sleepRows as SleepStageRow[],
        userTz,
        prefsRow?.sourcePriorityJson ?? null,
      ).filter((n) => n.asleepMinutes > 0);
      // Recent nights: asleep duration + stage breakdown when present.
      const recentNights = nights
        .filter((n) => n.measuredAt >= recentCutoff)
        .map((n) => {
          const row: Record<string, unknown> = {
            date: n.measuredAt,
            weekday: tzWeekday(n.measuredAt, userTz),
            minutes: Math.round(n.asleepMinutes),
          };
          const stageEntries = Object.entries(n.stages).filter(
            ([stage]) => stage !== "IN_BED" && stage !== "AWAKE",
          );
          if (stageEntries.length > 0) {
            row.stages = Object.fromEntries(
              stageEntries.map(([k, v]) => [
                k.toLowerCase(),
                Math.round(v as number),
              ]),
            );
          }
          return row;
        })
        .sort((a, b) => String(a.date).localeCompare(String(b.date)));
      const olderNights = nights
        .filter((n) => n.measuredAt < recentCutoff)
        .map((n) => ({ measuredAt: n.measuredAt, value: n.asleepMinutes }));
      snapshot.sleep = {
        timeline: {
          recent: recentNights,
          weekly: bucketWeekly(olderNights, userTz),
        },
      };
      metrics.add("sleep");
      counts.sleep = sleepRows.length;
      registerBlock("sleep", "sleep");
      // W7 grounding: recent nightly asleep duration in HOURS against the
      // AASM 7–9 h band (the reference unit is hours; the snapshot stores
      // minutes). Mean over the recent nights the block already reconstructed.
      if (recentNights.length > 0) {
        const meanMin =
          recentNights.reduce(
            (s, n) => s + (typeof n.minutes === "number" ? n.minutes : 0),
            0,
          ) / recentNights.length;
        if (meanMin > 0) {
          groundingValues.set("SLEEP_DURATION", meanMin / 60);
        }
      }
    }
  }

  // ── v1.17.0 sleep-rhythm block (sleep-debt + chronotype) ──────────
  //
  // The two server-authoritative timing signals the Sleep page + the
  // dashboard summary render — cumulative sleep debt and the MCTQ
  // chronotype band + social jetlag. Built from the SAME assembler the
  // dashboard route uses (`reconstructNights` → `computeSleepRhythmFromNights`),
  // over the rhythm's OWN fixed trailing-42-day rows, so the coach quotes the
  // exact debt + band the page shows regardless of the coach's narration
  // window. ONE ENGINE: this never recomputes sleep-debt or chronotype inline —
  // the math lives in `sleep-debt.ts` / `chronotype.ts`, reached through the
  // assembler. The `needMinutes` is the SAME age-resolved need the derived
  // block + Sleep Score read (`sleepNeedMinutes(ageYears)`), and the
  // `sourcePriorityJson` is the one already loaded for the per-stage sleep
  // block above — no extra read beyond the rhythm rows.
  //
  // LEARNING-GATE HONESTY: both signals carry a calm `partial` / `learning`
  // state below their night thresholds. The chronotype `band` is emitted ONLY
  // when the state is `ready` — a learning chronotype is surfaced as
  // "still calibrating", never asserted as a band the data can't support.
  if (sources.has("sleep") && sleepRhythmRows && sleepRhythmRows.length > 0) {
    const rhythm: SleepRhythmDto = computeSleepRhythmFromNights(
      reconstructNights(
        sleepRhythmRows as SleepStageRow[],
        userTz,
        prefsRow?.sourcePriorityJson ?? null,
      ),
      sleepNeedMinutes(derivedProfile.ageYears),
    );
    const chronotypeReady = rhythm.chronotype.state === "ready";
    snapshot.sleepRhythm = {
      sleepDebt: {
        state: rhythm.sleepDebt.state,
        debtMinutes: rhythm.sleepDebt.debtMinutes,
        needMinutes: rhythm.sleepDebt.needMinutes,
      },
      chronotype: {
        state: rhythm.chronotype.state,
        // Only assert a band + social jetlag once the chronotype is `ready`.
        // A `learning` chronotype carries no band the data supports — the
        // model treats it as "still calibrating", never a typed assertion.
        band: chronotypeReady ? rhythm.chronotype.band : null,
        socialJetlagMinutes: chronotypeReady
          ? rhythm.chronotype.socialJetlagMinutes
          : null,
      },
    };
    metrics.add("sleep");
    registerBlock("sleepRhythm", "sleep");
  }

  // ── v1.7.0 glucose block (per-context daily means) ────────────────
  //
  // Glucose is summarised per `GlucoseContext` so the Coach can tell
  // fasting from postprandial without seeing raw samples. Each context
  // gets its own per-day mean timeline; the block omits when no rows.
  if (sources.has("glucose")) {
    const glucoseCutoff = additiveCutoff("glucose");
    const glucoseRows = measurementRows.filter(
      (r) => r.type === "BLOOD_GLUCOSE" && r.measuredAt >= glucoseCutoff,
    );
    if (glucoseRows.length === 0) {
      annotate({
        action: { name: "coach.cluster.empty_skipped" },
        meta: { cluster: "glucose", source: "glucose" },
      });
    } else {
      // Group by context (NULL → "unspecified"), then per-day mean.
      const byContext = new Map<
        string,
        Array<{ measuredAt: Date; value: number }>
      >();
      for (const r of glucoseRows) {
        const ctx = r.glucoseContext
          ? String(r.glucoseContext).toLowerCase()
          : "unspecified";
        const list = byContext.get(ctx) ?? [];
        list.push({ measuredAt: r.measuredAt, value: r.value });
        byContext.set(ctx, list);
      }
      const contexts: Record<string, unknown> = {};
      for (const [ctx, rows] of byContext) {
        // v1.16.16 — glucose is stored canonical mg/dL. A mmol/L-preference
        // user's Coach must read the same number every other surface shows
        // (5.5, not 100). Aggregate the per-day / weekly means in raw mg/dL,
        // then convert each resulting figure ONCE (parity with the series
        // DTO + detail page + FHIR). mg/dL users stay byte-identical because
        // the conversion is skipped entirely.
        const recent = buildDailyValueRows(rows, recentCutoff, userTz).map(
          (d) =>
            glucoseUnit === "mmol/L"
              ? { ...d, value: convertGlucose(d.value, glucoseUnit) }
              : d,
        );
        const weekly = bucketWeekly(
          rows.filter((r) => r.measuredAt < recentCutoff),
          userTz,
        ).map((w) =>
          glucoseUnit === "mmol/L"
            ? { ...w, mean: convertGlucose(w.mean, glucoseUnit) }
            : w,
        );
        contexts[ctx] = { recent, weekly };
      }
      // v1.17.0 — clinical panel summary from the ONE literature-locked engine
      // the insights panel + doctor report also consume, computed over the SAME
      // fixed trailing-30-day window + rows the panel uses (`glucoseClinicalRows`,
      // not the coach-window / cap-trimmed `glucoseRows`), so the coach can never
      // quote a TIR / GMI / CV% figure the panel doesn't show — true numeric
      // parity, independent of the user's coach scope. Gated by `stillLearning`
      // so a thin spot-data window is offered as a calm "still learning" note
      // rather than asserted as a clinical AGP. The headline mean is converted
      // ONCE to the user's display unit; the unit-agnostic fractions / indices
      // travel as-is.
      const clinicalRaw = computeGlucoseClinicalMetrics(
        (glucoseClinicalRows ?? []).map((r) => ({
          measuredAt: r.measuredAt,
          mgdl: r.value,
        })),
        { windowDays: GLUCOSE_CLINICAL_WINDOW_DAYS, now },
      );
      const clinical = clinicalRaw.stillLearning
        ? {
            stillLearning: true as const,
            reason: clinicalRaw.stillLearningReason,
            readingCount: clinicalRaw.readingCount,
            spanDays: Math.round(clinicalRaw.actualSpanDays),
          }
        : {
            stillLearning: false as const,
            windowDays: clinicalRaw.windowDays,
            spanDays: Math.round(clinicalRaw.actualSpanDays),
            readingCount: clinicalRaw.readingCount,
            meanInRange:
              clinicalRaw.meanMgdl !== null
                ? Math.round(
                    convertGlucose(clinicalRaw.meanMgdl, glucoseUnit) *
                      (glucoseUnit === "mmol/L" ? 10 : 1),
                  ) / (glucoseUnit === "mmol/L" ? 10 : 1)
                : null,
            tirPercent: clinicalRaw.distribution
              ? Math.round(clinicalRaw.distribution.tir * 100)
              : null,
            timeBelowPercent: clinicalRaw.distribution
              ? Math.round(clinicalRaw.distribution.tbrLevel1 * 100)
              : null,
            timeAbovePercent: clinicalRaw.distribution
              ? Math.round(clinicalRaw.distribution.tarLevel1 * 100)
              : null,
            gmi:
              clinicalRaw.gmi !== null
                ? Math.round(clinicalRaw.gmi * 10) / 10
                : null,
            estimatedA1c:
              clinicalRaw.estimatedA1c !== null
                ? Math.round(clinicalRaw.estimatedA1c * 10) / 10
                : null,
            cvPercent: clinicalRaw.variability
              ? Math.round(clinicalRaw.variability.cv)
              : null,
            unstable: clinicalRaw.variability?.unstable ?? null,
            // Density-derived: a sparse spot series stays a spot-reading
            // estimate, a continuous CGM stream (Nightscout) reads false so the
            // model can narrate the TIR/GMI as continuous-trace figures.
            isSpotEstimate: clinicalRaw.isSpotEstimate,
          };
      // The display unit travels with the block so the prompt renders
      // "<value> <unit>" and the EVIDENCE BLOCK tags glucose lines correctly.
      snapshot.glucose = { unit: glucoseUnit, byContext: contexts, clinical };
      metrics.add("glucose");
      counts.glucose = glucoseRows.length;
      registerBlock("glucose", "glucose");
      // W7 grounding: fasting glucose mean in RAW mg/dL (the reference band's
      // unit), independent of the user's mmol/L display preference. The
      // grounding line's band selection respects the W6 `hasDiabetes` opt-in;
      // here we only feed the representative fasting value. Fall back to the
      // overall mean when no row is tagged FASTING so the band is still cited.
      const fastingRows = glucoseRows.filter(
        (r) => String(r.glucoseContext).toUpperCase() === "FASTING",
      );
      const glucoseScalarRows =
        fastingRows.length > 0 ? fastingRows : glucoseRows;
      const glucoseMeanMgdl =
        glucoseScalarRows.reduce((s, r) => s + r.value, 0) /
        glucoseScalarRows.length;
      if (Number.isFinite(glucoseMeanMgdl)) {
        groundingValues.set("BLOOD_GLUCOSE", glucoseMeanMgdl);
      }
    }
  }

  // ── v1.7.0 workouts block (capped list + per-sport rollup) ────────
  //
  // The Workout model is never dumped row-for-row. The block carries
  // the most recent `WORKOUT_RECENT_CAP` sessions (sport, duration,
  // energy, distance, avg/max HR) plus a per-sport weekly count + total
  // duration/energy rollup for the tail so the prompt stays bounded
  // even for a heavy-training account at a long window.
  if (sources.has("workouts") && workoutRows) {
    // The workout sessions are read in parallel above.
    if (workoutRows.length === 0) {
      annotate({
        action: { name: "coach.cluster.empty_skipped" },
        meta: { cluster: "workouts", source: "workouts" },
      });
    } else {
      const recentList = workoutRows.slice(0, WORKOUT_RECENT_CAP).map((w) => ({
        date: tzDayKey(w.startedAt, userTz),
        weekday: tzWeekday(w.startedAt, userTz),
        sport: w.sportType,
        durationMin: Math.round(w.durationSec / 60),
        energyKcal: w.totalEnergyKcal ?? null,
        distanceM: w.totalDistanceM ?? null,
        avgHr: w.avgHeartRate ?? null,
        maxHr: w.maxHeartRate ?? null,
      }));
      // Per-sport rollup over the whole window.
      const bySport = new Map<
        string,
        { count: number; durationMin: number; energyKcal: number }
      >();
      for (const w of workoutRows) {
        const e = bySport.get(w.sportType) ?? {
          count: 0,
          durationMin: 0,
          energyKcal: 0,
        };
        e.count += 1;
        e.durationMin += Math.round(w.durationSec / 60);
        e.energyKcal += w.totalEnergyKcal ?? 0;
        bySport.set(w.sportType, e);
      }
      const sportRollup = Array.from(bySport.entries())
        .map(([sport, v]) => ({
          sport,
          count: v.count,
          totalDurationMin: v.durationMin,
          totalEnergyKcal: Math.round(v.energyKcal),
        }))
        .sort((a, b) => b.count - a.count);
      snapshot.workouts = {
        recent: recentList,
        perSport: sportRollup,
        totalInWindow: workoutRows.length,
      };
      metrics.add("workouts");
      counts.workouts = workoutRows.length;
      registerBlock("workouts", "workouts");
    }
  }

  // ── v1.4.25 W4d — GLP-1 weeklyContext block ──────────────────────
  //
  // Only emitted when the user has at least one active GLP-1 medication
  // (Medication.treatmentClass = GLP1). Web-only generic accounts never
  // pay the read cost — the helper short-circuits to `null` after a
  // single indexed Prisma lookup.
  //
  // The block names the drug, current dose, titration history, last +
  // next injection, pen inventory, and recent side-effect tags. The
  // Coach's GROUND RULE 9 forbids dose prescriptions — this block
  // exists so the reply can SAY "your Mounjaro 7.5 mg" instead of
  // "your medication", never to make recommendations.
  // v1.4.36 W3 T2 — gated on `medications` exclusion. When excluded
  // we skip the Prisma lookup entirely so the read cost vanishes too.
  if (!excludesMedications && glp1Block) {
    // The GLP-1 block is read in parallel above (null when excluded or
    // when the account has no active GLP-1 medication).
    snapshot.weeklyContext = { glp1: glp1Block };
    metrics.add("compliance");
    registerBlock("weeklyContext", "compliance");
  }

  // v1.4.36 W3 T2 — anthropometrics block (height / age / gender).
  // Sourced from `features.context`, which already reads
  // `User.heightCm / dateOfBirth / gender`. Gated on the
  // `anthropometrics` exclusion AND on at least one non-null field
  // — accounts with no profile info never see an empty block. The
  // `ctx?` guard tolerates mocked feature shapes in the test suite
  // that don't populate the `context` object.
  if (!excludesAnthropometrics) {
    const ctx = features.context;
    if (
      ctx &&
      (ctx.heightCm !== null || ctx.ageYears !== null || ctx.gender !== null)
    ) {
      snapshot.anthropometrics = {
        heightCm: ctx.heightCm,
        ageYears: ctx.ageYears,
        gender: ctx.gender,
      };
    }
  }

  // ── v1.10.0 — derived wellness layer (compact summaries) ─────────────
  //
  // The composites + persisted scores the dashboard rings render, folded
  // in as one tiny object per metric (value + band + coverage), NOT the
  // raw series. So the Coach can say "your readiness is 64, low band" and
  // ground it in the same number the user sees. Insufficient metrics are
  // omitted (no "no data" noise). Reads the same `computeDerivedMetric`
  // contract every surface uses — no recompute. Gated on at least one of
  // the signals the composites are built from staying in-scope (HRV /
  // resting HR / sleep / VO₂max), so a user who excludes those doesn't see
  // the block. `derivedActive` + `derivedProfile` are resolved up top so
  // the derived / trajectory reads can run in the parallel batch.
  if (derivedActive) {
    if (derivedBlock) {
      snapshot.derived = derivedBlock;
      metrics.add("hrv");
      registerBlock("derived", "hrv");
    }

    // ── v1.17.0 — WHOOP-native day strain ────────────────────────────────
    // The device's gold-standard strain on its native 0–21 scale, kept
    // distinct from the COMPUTED `derived.STRAIN_SCORE` (0–100). When both
    // exist we surface the native number AND flag it as the device signal
    // so the model prefers it (native-over-computed, mirroring recovery).
    // Omitted for every account without a DAY_STRAIN row.
    if (dayStrainRows && dayStrainRows.length > 0) {
      const latest = dayStrainRows[dayStrainRows.length - 1];
      const recent = dayStrainRows.filter((r) => r.measuredAt >= recentCutoff);
      const mean =
        recent.length > 0
          ? Math.round(
              (recent.reduce((sum, r) => sum + r.value, 0) / recent.length) *
                10,
            ) / 10
          : Math.round(latest.value * 10) / 10;
      snapshot.dayStrain = {
        source: "WHOOP-native",
        scale: "0-21",
        latest: Math.round(latest.value * 10) / 10,
        recentMean: mean,
        days: dayStrainRows.length,
        note: "Device-native day strain; prefer over derived.STRAIN_SCORE (computed 0-100 proxy).",
      };
      registerBlock("dayStrain", "hrv");
    }

    // ── v1.11.0 (Epic B, Pillar 3) — short-horizon trajectory block ──────
    // Additive, lowest-signal block: per in-scope metric a compact
    // direction + slope + projected horizon-end-with-band, computed by the
    // deterministic `computeTrajectory` engine (NEVER recomputed here). The
    // Coach narrates the range conditionally (system-prompt rule 11 /
    // ground rule 16) only when this block is present. Registered under an
    // `environment`-cluster source so the soft-cap degrader sheds it FIRST,
    // before any clinical cluster, under prompt-budget pressure. Read in
    // the parallel batch above.
    if (trajectoryBlock) {
      snapshot.trajectory = trajectoryBlock;
      registerBlock("trajectory", "skin_temp");
    }
  }

  // ── v1.11.0 W5a — rolling-profile memory (Pillar P2 2a) ──────────────
  //
  // Zero-LLM longitudinal recall: the latest period-narrative headline +
  // a per-metric prior-vs-current band memory, assembled from artefacts we
  // already persist. Lets the Coach reference "as I noted at the start of
  // the month…" instead of re-deriving cold every turn. Folded under the
  // `memory` key and registered against the LOWEST-signal cluster
  // (`environment`, the tail of CLUSTER_PRIORITY) so `degradeToBudget`
  // sheds it FIRST under the char cap — before any clinical cluster. The
  // builder is fault-isolated per sub-source and returns null when neither
  // a narrative nor any band movement is on file. Read in the parallel
  // batch above.
  if (memoryBlock) {
    snapshot.memory = memoryBlock;
    // `skin_temp` maps to the `environment` cluster — the lowest priority
    // in CLUSTER_PRIORITY — so this block degrades before everything else.
    registerBlock("memory", "skin_temp");
  }

  // ── v1.15 — cycle/phase block ────────────────────────────────────────
  //
  // Present only for a cycle-enabled account (the promise is null otherwise,
  // so this is byte-for-byte unchanged for everyone else). The block names the
  // current phase + day-of-cycle, the next predicted event (period range +
  // confidence + method; fertile window goal-gated), and the headline
  // phase-correlation finding — all from the same deterministic engine the
  // calendar + insights surface use, never re-derived. The Coach's cycle
  // ground rule keeps replies descriptive: never contraception-grade, never a
  // "safe day" claim. Registered against the lowest-priority `skin_temp`
  // source so the soft-cap degrader sheds it before any clinical cluster.
  if (cycleBlock) {
    snapshot.cycle = cycleBlock;
    registerBlock("cycle", "skin_temp");
  }

  // v1.18.1 P4 — illness/condition context. Small + load-bearing, so it is
  // attached WITHOUT a cluster registration (like scope/anthropometrics): the
  // budget degrader never sheds it, the Coach always knows whether the user is
  // in Rest Mode. Labels + lifecycle + dates only — no decrypted note.
  if (illnessBlock) {
    snapshot.illness = illnessBlock;
  }

  // v1.18.11 (#65) — lab-result context. Attached WITHOUT a cluster
  // registration (like illness/scope): the budget degrader never sheds it, so
  // the Coach can always answer a lab question from the user's own readings.
  // Server-authoritative + grounded — resolved name/value/unit/range per
  // biomarker, never the decrypted note.
  if (labsBlock) {
    snapshot.labs = labsBlock;
  }

  if (Object.keys(snapshot).length === 0) {
    metrics.add("general");
  }

  // Pin the scope onto the snapshot itself so the model knows which
  // windows + sources are in-bounds for the reply. The system prompt
  // tells the model to read from this block for day-level questions.
  snapshot.scope = {
    window,
    sources: Array.from(sources),
    timelineRecentDays: DAILY_TIMELINE_DAYS,
  };

  // v1.4.36 W3 T4 — compactSections drops any zero-row block before
  // serialisation so the prompt never carries a labelled-empty key.
  // The snapshot is built conditionally above so most empty paths are
  // already skipped, but the helper catches future regressions and
  // matches the contract the /insights/generate route applies on its
  // side of the prompt.
  const compactSnapshot = compactSections(snapshot);

  // v1.7.0 — assembled-snapshot soft cap. Enabling every cluster at a
  // long window can balloon the prompt; degrade progressively by
  // reverse cluster priority until the serialised size fits
  // `MAX_SNAPSHOT_CHARS`. The `scope` block is exempt — the model
  // needs it to know what is in-bounds. The helper emits its own
  // `coach.snapshot.truncated` annotation when it sheds anything.
  degradeToBudget(compactSnapshot, blockClusters);

  // v1.18.6 (W7) — build the citation-aware reference-grounding block from the
  // representative scalars collected above. Deterministic + pure; the route
  // appends it verbatim after the SNAPSHOT. Null when no present metric is
  // covered by the reference backbone. Insertion order follows the block-build
  // order (BP first), giving a stable, inspectable block for the
  // hallucination-QA pass.
  const groundingMetrics: GroundingMetricInput[] = Array.from(
    groundingValues.entries(),
  ).map(([metric, value]) => ({ metric, value }));
  const referenceGrounding = buildReferenceGroundingBlock({
    metrics: groundingMetrics,
    hasDiabetes: prefsRow?.hasDiabetes ?? false,
  });
  if (referenceGrounding) {
    annotate({
      action: { name: "coach.grounding.attached" },
      meta: {
        metrics: groundingMetrics.map((m) => m.metric).sort(),
        hasDiabetes: prefsRow?.hasDiabetes ?? false,
      },
    });
  }

  return {
    snapshotJson: JSON.stringify(compactSnapshot, null, 2),
    // v1.20.0 (F1) — the structured, post-degrade snapshot record keyed by
    // domain block (`bloodPressure`, `glucose`, `labs`, …). The coach tool
    // executor slices a single domain block out of this so a retrieval tool
    // returns exactly the numbers the legacy snapshot path would have shown —
    // same builder, same gates, same I/O. `snapshotJson` is this record
    // serialised; exposing the record avoids re-parsing it.
    sections: compactSnapshot,
    provenance: {
      windows: Array.from(windows),
      metrics: Array.from(metrics),
      counts: Object.keys(counts).length > 0 ? counts : undefined,
    },
    referenceGrounding,
  };
}

/**
 * v1.7.0 — progressive degradation to the snapshot char budget.
 *
 * Mutates `snapshot` in place. Walks the blocks in REVERSE cluster
 * priority (lowest-signal first) over two passes:
 *   1. drop `timeline.recent` (keep `aggregate` + `timeline.weekly`),
 *   2. collapse `timeline.weekly` too (keep only `aggregate` / the
 *      smallest summary the block carries).
 * Stops as soon as the serialised size fits. Emits one
 * `coach.snapshot.truncated` annotation describing what was shed.
 *
 * Returns the list of `{ key, cluster, pass }` it degraded — empty when
 * the snapshot already fit.
 */
function degradeToBudget(
  snapshot: Record<string, unknown>,
  blockClusters: Map<string, CoachDataCluster>,
): Array<{ key: string; cluster: CoachDataCluster; pass: number }> {
  const degraded: Array<{
    key: string;
    cluster: CoachDataCluster;
    pass: number;
  }> = [];
  // Measure against the SAME pretty-printed form the prompt ships
  // (`JSON.stringify(snapshot, null, 2)`), not the compact form —
  // otherwise the cap under-counts by ~2× and the prompt overflows.
  const size = () => JSON.stringify(snapshot, null, 2).length;
  if (size() <= MAX_SNAPSHOT_CHARS) return degraded;

  // Build a degrade order: blocks grouped by cluster, lowest priority
  // first. A block with no registered cluster (e.g. anthropometrics,
  // scope) is never touched — those are tiny + load-bearing.
  const priorityIndex = new Map<CoachDataCluster, number>();
  CLUSTER_PRIORITY.forEach((c, i) => priorityIndex.set(c, i));
  const orderedKeys = Array.from(blockClusters.entries()).sort((a, b) => {
    const pa = priorityIndex.get(a[1]) ?? -1;
    const pb = priorityIndex.get(b[1]) ?? -1;
    // Higher priority index = lower signal = degrade first.
    return pb - pa;
  });

  const asRecord = (v: unknown): Record<string, unknown> | null =>
    typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;

  // Drop the dense per-day detail from a block, leaving the coarser
  // weekly / aggregate summary. Handles the three block shapes:
  //   - timeline-bearing blocks (`timeline.recent`)
  //   - glucose (`byContext.<ctx>.recent`)
  //   - workouts (`recent` at the top level)
  const dropRecent = (key: string): boolean => {
    const block = asRecord(snapshot[key]);
    if (!block) return false;
    let changed = false;
    const timeline = asRecord(block.timeline);
    if (timeline && "recent" in timeline) {
      delete timeline.recent;
      changed = true;
    }
    // v1.18.7 — the coarse MONTH/YEAR tail + anomaly envelope is the
    // lowest-value, oldest detail, so it sheds in the same first pass as the
    // dense per-day rows.
    if (timeline && "coarse" in timeline) {
      delete timeline.coarse;
      changed = true;
    }
    const byContext = asRecord(block.byContext);
    if (byContext) {
      for (const ctx of Object.keys(byContext)) {
        const c = asRecord(byContext[ctx]);
        if (c && "recent" in c) {
          delete c.recent;
          changed = true;
        }
      }
    }
    if ("recent" in block) {
      delete block.recent;
      changed = true;
    }
    return changed;
  };

  // Collapse the weekly buckets too — leaves only the aggregate /
  // smallest summary the block carries.
  const dropWeekly = (key: string): boolean => {
    const block = asRecord(snapshot[key]);
    if (!block) return false;
    let changed = false;
    const timeline = asRecord(block.timeline);
    if (timeline) {
      for (const field of ["weekly", "weeklySys", "weeklyDia"]) {
        if (field in timeline) {
          delete timeline[field];
          changed = true;
        }
      }
      if (Object.keys(timeline).length === 0) {
        delete block.timeline;
      }
    }
    const byContext = asRecord(block.byContext);
    if (byContext) {
      for (const ctx of Object.keys(byContext)) {
        const c = asRecord(byContext[ctx]);
        if (c && "weekly" in c) {
          delete c.weekly;
          changed = true;
        }
      }
    }
    return changed;
  };

  // Last resort: replace the whole block with a compact marker so the
  // model still knows the cluster exists without paying for its rows.
  // v1.16.8 — the `memory` block's `facts` list survives the drop: it
  // carries the durable personal facts (a stated allergy, a stated
  // condition) and is tiny by construction (top-8, ≤160 chars each).
  // Shedding it made the Coach forget a stated allergy exactly on the
  // data-heavy accounts that hit the char cap; the bulky narrative +
  // trend recall still goes.
  const dropBlock = (key: string): boolean => {
    if (!(key in snapshot)) return false;
    const block = asRecord(snapshot[key]);
    const facts =
      block && Array.isArray(block.facts) && block.facts.length > 0
        ? block.facts
        : null;
    snapshot[key] = facts
      ? { facts, omitted: "trimmed for prompt budget" }
      : { omitted: "trimmed for prompt budget" };
    return true;
  };

  // Degrade per-block, LOWEST priority first, collapsing each block as
  // far as needed before advancing to the next (higher-priority) one.
  // For each block in turn: drop the dense per-day detail, then the
  // weekly buckets, then — only if it still overflows — replace the
  // whole block with a marker. A higher-priority block is touched only
  // once every lower-priority block is already fully collapsed and the
  // prompt still exceeds the cap, so the clinical core keeps its detail
  // until it is genuinely the last lever left.
  for (const [key, cluster] of orderedKeys) {
    if (size() <= MAX_SNAPSHOT_CHARS) break;
    if (dropRecent(key)) degraded.push({ key, cluster, pass: 1 });
    if (size() <= MAX_SNAPSHOT_CHARS) break;
    if (dropWeekly(key)) degraded.push({ key, cluster, pass: 2 });
    if (size() <= MAX_SNAPSHOT_CHARS) break;
    if (dropBlock(key)) degraded.push({ key, cluster, pass: 3 });
  }

  if (degraded.length > 0) {
    const droppedClusters = Array.from(new Set(degraded.map((d) => d.cluster)));
    annotate({
      action: { name: "coach.snapshot.truncated" },
      meta: {
        droppedClusters,
        droppedBlocks: degraded.map((d) => d.key),
        finalChars: size(),
      },
    });
  }
  return degraded;
}
