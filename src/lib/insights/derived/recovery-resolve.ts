/**
 * v1.16.16 — canonical recovery resolution (one number, one engine).
 *
 * `RECOVERY_SCORE` is written by TWO sources that mean different things for the
 * same day:
 *   - `WHOOP`    — the device's own native recovery percentage (ground truth
 *                  when the user wears a WHOOP strap), ingested by the sync.
 *   - `COMPUTED` — the server-derived proxy (the READINESS blend persisted by
 *                  the nightly `recovery-score` job) — the fallback for a user
 *                  with no native recovery signal.
 *
 * The DECISION (locked): the WHOOP-native row is canonical WHEN PRESENT; the
 * COMPUTED proxy is the fallback. Every read surface — the wellness tile, the
 * doctor PDF, the iOS feed — must resolve to the SAME canonical row per day so
 * none of them shows the proxy and the native value as two competing series.
 *
 * Pure resolution: group rows by their calendar day and, per day, keep the
 * WHOOP row when one exists, else the COMPUTED one. No DB access here — the
 * caller does the bounded read and passes rows in.
 */
import type { MeasurementSource } from "@/generated/prisma/client";

/** A `RECOVERY_SCORE` row as read for resolution. */
export interface RecoveryRow {
  value: number;
  measuredAt: Date;
  source: MeasurementSource;
}

/**
 * The per-source preference for `RECOVERY_SCORE`: a native WHOOP row outranks
 * the COMPUTED proxy for the same day. Lower number = higher authority. A
 * source not listed (there is none today) falls back below both.
 */
const RECOVERY_SOURCE_RANK: Partial<Record<MeasurementSource, number>> = {
  WHOOP: 0,
  COMPUTED: 1,
};

function rankOf(source: MeasurementSource): number {
  return RECOVERY_SOURCE_RANK[source] ?? Number.MAX_SAFE_INTEGER;
}

/** The UTC calendar-day key a recovery row is filed under. */
function dayKeyOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Collapse a mixed-source `RECOVERY_SCORE` set to ONE canonical row per day:
 * the WHOOP-native row wins when present, else the COMPUTED proxy. Within a
 * source the latest `measuredAt` wins (a same-day re-score). Returns the
 * canonical rows in the same shape, sorted by `measuredAt` DESCENDING so the
 * first element is the most recent canonical day — matching the order the
 * wellness reader already expects.
 */
export function resolveCanonicalRecovery(rows: RecoveryRow[]): RecoveryRow[] {
  const byDay = new Map<string, RecoveryRow>();
  for (const row of rows) {
    const key = dayKeyOf(row.measuredAt);
    const incumbent = byDay.get(key);
    if (incumbent === undefined) {
      byDay.set(key, row);
      continue;
    }
    const rowRank = rankOf(row.source);
    const incumbentRank = rankOf(incumbent.source);
    const better =
      rowRank < incumbentRank ||
      (rowRank === incumbentRank &&
        row.measuredAt.getTime() > incumbent.measuredAt.getTime());
    if (better) byDay.set(key, row);
  }
  return [...byDay.values()].sort(
    (a, b) => b.measuredAt.getTime() - a.measuredAt.getTime(),
  );
}
