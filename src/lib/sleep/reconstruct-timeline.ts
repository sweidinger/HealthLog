/**
 * Shared reconstructed-sleep-timeline builder.
 *
 * Some wearables (WHOOP v2, Polar) expose only per-stage DURATION totals for a
 * night — no per-stage onset timestamps and no hypnogram endpoint. Stamping
 * every stage total on the one sleep-END instant collapses the hypnogram into
 * overlapping spans that all touch the night's right edge. Since the API never
 * carries an order, both vendors RECONSTRUCT an ordered, contiguous timeline:
 * lay the stages back-to-back from sleep ONSET in a fixed physiological order,
 * emitting one timed row per segment with `measuredAt = that segment's END`.
 *
 * The ORDER is synthetic, so every laid segment is flagged `reconstructed:
 * true`; the night DTO advertises it and the UI labels such a night as an
 * approximate layout, never as measured stage timing. The reader's honesty
 * flag (`analytics/sleep-night.ts` `RECONSTRUCTED_TIMELINE_SOURCES`) carries
 * the same contract on the read side.
 *
 * This helper is the single source of the algorithm; each vendor `mapSleep`
 * keeps only its field-name → tuple normalisation (ms vs sec, source field
 * names) so the segment shape and externalId scheme can never drift between the
 * two synthetic-timeline vendors. Oura's measured 5-min hypnogram is a
 * different algorithm and does NOT use this helper.
 */

/** The sleep-row shape both vendor mappers emit. Kept structurally identical to
 * each vendor's local `MappedMeasurement`; the helper returns rows assignable to
 * either. */
export interface ReconstructedSleepRow {
  type: "SLEEP_DURATION";
  value: number;
  unit: "minutes";
  measuredAt: Date;
  fieldTag: string;
  externalId?: string;
  sleepStage: "CORE" | "DEEP" | "REM" | "AWAKE" | "IN_BED";
  reconstructed?: boolean;
}

/** One asleep/awake stage to lay onto the reconstructed timeline. `durationMs`
 * is the stage total in milliseconds; non-positive or non-finite durations are
 * skipped. */
export interface ReconstructedStage {
  durationMs: number | null | undefined;
  stage: "CORE" | "DEEP" | "REM" | "AWAKE";
  fieldTag: string;
}

/** Optional single IN_BED envelope row over the whole sleep window. The in-bed
 * reader consumes the union envelope, so this stays one row stamped at the
 * sleep END (`measuredAt`) — NOT a placed segment. */
export interface ReconstructedInBed {
  durationMs: number | null | undefined;
  /** Sleep END instant; the in-bed reader resolves the span back to its window. */
  measuredAt: Date;
  fieldTag: string;
}

export interface ReconstructTimelineOptions {
  /** Sleep ONSET instant; the contiguous walk starts here. */
  startMs: number;
  /** Stages in physiological lay-out order (e.g. AWAKE → CORE → DEEP → REM). */
  stages: ReadonlyArray<ReconstructedStage>;
  /** Optional IN_BED envelope row. */
  inBed?: ReconstructedInBed;
  /**
   * Builds the indexed externalId for a laid segment so the several rows of one
   * night stay distinct under `userId_type_source_externalId`. Called with the
   * segment's fieldTag and its running index.
   */
  externalIdFor: (fieldTag: string, index: number) => string;
}

const MS_TO_MIN = 1 / 60_000;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Lay the asleep/awake stages contiguously from `startMs` in the given order,
 * emitting one timed `SLEEP_DURATION` row per stage (`measuredAt` = that
 * segment's END), each flagged `reconstructed: true` and keyed by an indexed
 * externalId. Appends a single IN_BED envelope row when `inBed` is provided.
 */
export function reconstructContiguousSleepTimeline(
  opts: ReconstructTimelineOptions,
): ReconstructedSleepRow[] {
  const { startMs, stages, inBed, externalIdFor } = opts;
  const out: ReconstructedSleepRow[] = [];

  let cursor = startMs;
  let segIndex = 0;
  for (const { durationMs, stage, fieldTag } of stages) {
    if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs <= 0) {
      continue;
    }
    const segEnd = cursor + durationMs;
    out.push({
      type: "SLEEP_DURATION",
      value: round2(durationMs * MS_TO_MIN),
      unit: "minutes",
      measuredAt: new Date(segEnd),
      fieldTag,
      externalId: externalIdFor(fieldTag, segIndex),
      sleepStage: stage,
      reconstructed: true,
    });
    cursor = segEnd;
    segIndex += 1;
  }

  if (
    inBed &&
    typeof inBed.durationMs === "number" &&
    Number.isFinite(inBed.durationMs) &&
    inBed.durationMs > 0
  ) {
    out.push({
      type: "SLEEP_DURATION",
      value: round2(inBed.durationMs * MS_TO_MIN),
      unit: "minutes",
      measuredAt: inBed.measuredAt,
      fieldTag: inBed.fieldTag,
      sleepStage: "IN_BED",
    });
  }

  return out;
}
