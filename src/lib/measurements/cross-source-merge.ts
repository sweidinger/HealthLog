/**
 * v1.11.4 (iOS #2) — same-reading merge for the MANUAL ↔ APPLE_HEALTH
 * mirror duplicate.
 *
 * ## The problem
 * When the iOS app runs standalone/offline and the user logs a MANUAL
 * measurement, iOS mirrors that reading into HealthKit too. On pairing a
 * server, two independent upload paths then reach
 * `POST /api/measurements/batch` for the SAME physical reading:
 *   1. adopt-on-pair backfill uploads it as `source = MANUAL`
 *      (externalId = the app's local id), and
 *   2. HealthKit background sync re-ingests the mirrored sample and
 *      uploads it as `source = APPLE_HEALTH` (externalId = HKSample.uuid).
 *
 * The two carry different `externalId`s and different `source`s, so the
 * `(userId, type, source, externalId)` unique index treats them as two
 * distinct rows — duplicating the whole manually-logged history on first
 * pair.
 *
 * ## The rule
 * Treat a MANUAL row and an APPLE_HEALTH row as the SAME physical
 * reading when they share:
 *   - the same `userId` (multi-tenant scoping — always narrowed), AND
 *   - the same `type`, AND
 *   - the same `value` (within a tiny float epsilon — both rows are the
 *     same hand-entered number run through the identical
 *     `mapAppleHealthEntry` conversion, so equality is exact in practice;
 *     the epsilon only guards against sub-ulp drift), AND
 *   - a `measuredAt` within `MEASURED_AT_TOLERANCE_MS` of each other.
 *
 * The merge is deliberately ONE-SIDED in scope: it only fires for the
 * MANUAL ↔ APPLE_HEALTH cross-source pair. MANUAL ↔ MANUAL,
 * APPLE_HEALTH ↔ APPLE_HEALTH, and any pair involving a server-owned
 * source (WITHINGS / IMPORT / COMPUTED / WHOOP) keep the existing
 * first-write-wins / per-source contracts untouched. Two genuinely
 * distinct readings at the same minute from two devices therefore never
 * collapse — they are same-source or involve a server source, both of
 * which fall outside this rule.
 *
 * ## Ingest-time, first-physical-reading-wins
 * The collapse runs at INGEST time, not read time: read-time dedup would
 * have to live in the rollup tier and every analytics path forever.
 * Ingest-time keeps the storage clean and the rule contained.
 *
 * Because the two uploads can arrive in either order and minutes apart
 * in SEPARATE batches, the collapse compares each incoming row against
 * the rows already PERSISTED for the user (cross-batch) as well as the
 * rows already chosen for insert earlier in the SAME batch.
 *
 * The winner is whichever physical reading landed first. The `value` is
 * identical between the two rows by construction, so the only difference
 * the surviving row carries is its `source` label — the numeric series
 * the user sees is the same either way. A source-priority-aware REPLACE
 * (overwrite the loser's source/row with the higher-ranked source) was
 * considered and rejected for a patch: it would require mutating or
 * re-sourcing an existing row (rollup re-source + sync-version churn) for
 * zero change to the displayed value. First-physical-reading-wins is the
 * natural extension of the endpoint's existing first-write-wins
 * philosophy across the MANUAL↔APPLE_HEALTH boundary.
 *
 * `stats:*` cumulative externalIds are explicitly OUT of scope — those
 * are per-day aggregate rows the iOS observer overwrites in place
 * (issue #213), never hand-entered point readings, so the cross-source
 * mirror duplicate cannot arise for them.
 */
import type { MeasurementType } from "@/generated/prisma/client";

/**
 * Timestamp tolerance for the same-reading match. A reading the user
 * hand-enters and the app mirrors to HealthKit shares the same instant;
 * the HealthKit re-ingest may round to the second or carry a sub-second
 * drift, so a tight ±2 s window absorbs that without any chance of
 * catching a separate genuine reading — a user does not hand-enter two
 * distinct readings of the same type within two seconds.
 */
export const MEASURED_AT_TOLERANCE_MS = 2_000;

/**
 * Relative epsilon for the value match. Both rows run the same
 * `convertToDbUnit` over the same source number, so the stored floats
 * are bit-identical in practice; the epsilon is a defensive guard
 * against any future conversion that introduces sub-ulp rounding. Scaled
 * to the magnitude of the value so it stays meaningful for both a
 * 0.97-fraction SpO2 and a 12 000-step count.
 */
const VALUE_RELATIVE_EPSILON = 1e-9;

/** The two client-facing sources that can mirror the same reading. */
type MergeableSource = "MANUAL" | "APPLE_HEALTH";

/** The opposite member of the MANUAL ↔ APPLE_HEALTH pair. */
export function oppositeMergeSource(source: MergeableSource): MergeableSource {
  return source === "MANUAL" ? "APPLE_HEALTH" : "MANUAL";
}

/**
 * True when `source` participates in the cross-source merge. Only the
 * two client-facing mirror sources qualify; server-owned sources are
 * untouched.
 */
export function isMergeableSource(source: string): source is MergeableSource {
  return source === "MANUAL" || source === "APPLE_HEALTH";
}

/** Are two values the same reading within the relative epsilon? */
export function valuesMatch(a: number, b: number): boolean {
  if (a === b) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) <= VALUE_RELATIVE_EPSILON * scale;
}

/** Are two instants within the same-reading tolerance window? */
export function measuredAtMatch(a: Date, b: Date): boolean {
  return Math.abs(a.getTime() - b.getTime()) <= MEASURED_AT_TOLERANCE_MS;
}

/**
 * A candidate same-reading row — either already persisted for the user
 * or already chosen for insert earlier in the same batch. Carries only
 * the fields the match needs.
 */
export interface MergeCandidate {
  type: MeasurementType;
  source: string;
  value: number;
  measuredAt: Date;
}

/**
 * Does `candidate` represent the same physical reading as an incoming
 * row of `(type, incomingSource, value, measuredAt)`, under the
 * cross-source MANUAL↔APPLE_HEALTH rule? Requires:
 *   - the incoming row's source is mergeable,
 *   - the candidate's source is the OPPOSITE mergeable source,
 *   - same type, value (±epsilon), measuredAt (±tolerance).
 */
export function isSameReadingAcrossSource(
  incoming: {
    type: MeasurementType;
    source: string;
    value: number;
    measuredAt: Date;
  },
  candidate: MergeCandidate,
): boolean {
  if (!isMergeableSource(incoming.source)) return false;
  if (candidate.source !== oppositeMergeSource(incoming.source)) return false;
  if (candidate.type !== incoming.type) return false;
  if (!valuesMatch(candidate.value, incoming.value)) return false;
  return measuredAtMatch(candidate.measuredAt, incoming.measuredAt);
}
