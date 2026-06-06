/**
 * Cycle-import accumulator — folds the reproductive HealthKit samples a
 * `export.xml` parse emits into one merged `CycleDayLog` per user-local day.
 *
 * The streaming importer (`import-apple-health-export.ts`) sees one
 * `<Record>` per HK sample. Several reproductive samples can share a day
 * (flow + cervical mucus + a symptom). The `CycleDayLog` is one canonical
 * row per `(user, date)`, so we merge same-day samples in memory and flush
 * one upsert per day at the end of the parse.
 *
 * Dedup / idempotency: each merged day writes with `source:APPLE_HEALTH` and
 * a synthetic per-day `externalId` (`hkcycle:<YYYY-MM-DD>`), so a re-import
 * upserts the same row on the `(userId, source, externalId)` NULL-distinct
 * key — first-write-wins at the day grain, last-writer-wins on the field
 * set (the day-log write helper's contract). This mirrors the cumulative
 * `stats:<HKType>:<day>` convention the measurement importer already uses.
 *
 * A contraceptive STATUS sample additionally nudges the `CycleProfile`
 * goal toward AVOID_PREGNANCY — but only when the goal is still on its
 * GENERAL_HEALTH default, so an explicit user choice is never clobbered.
 */
import { prisma } from "@/lib/db";
import { upsertCycleDayLog } from "@/lib/cycle/day-log-write";
import { findOwningCycleId } from "@/lib/cycle/cycle-attribution";
import {
  mapHkCycleSample,
  isCycleHkIdentifier,
  type CycleDayLogFields,
} from "@/lib/cycle/healthkit-mapping";
import type { CycleDayLogInput } from "@/lib/validations/cycle";
import type { ContraceptiveKind } from "@/generated/prisma/client";

/** Synthetic per-day externalId prefix for HealthKit-imported cycle rows. */
export const HK_CYCLE_DAY_EXTERNAL_PREFIX = "hkcycle:";

/** Per-day merge state held during the parse. */
interface DayBucket {
  fields: CycleDayLogFields;
  symptomKeys: Set<string>;
  /** A contraceptive method seen this day → triggers the profile nudge. */
  contraceptiveNudge: ContraceptiveKind | null;
}

/** Terminal stats the importer folds into its `ImportJobResult`. */
export interface CycleImportStats {
  /** Reproductive samples consumed into a day-bucket. */
  samplesConsumed: number;
  /** Day-logs upserted at flush. */
  daysUpserted: number;
  /** Day-logs that the write created (vs refreshed). */
  daysInserted: number;
  /** Whether a CycleProfile goal nudge fired. */
  goalNudged: boolean;
}

/**
 * In-memory fold of the reproductive HK samples for one user's import.
 * Construct once per parse; `consume()` per matching `<Record>`; `flush()`
 * once at the end.
 */
export class CycleImportAccumulator {
  private readonly byDay = new Map<string, DayBucket>();
  private samplesConsumed = 0;
  private gated: boolean | null = null;

  constructor(
    private readonly userId: string,
    private readonly userTimezone: string,
  ) {}

  /** Does this importer own the inbound HK identifier? */
  static handles(hkIdentifier: string): boolean {
    return isCycleHkIdentifier(hkIdentifier);
  }

  /** True once at least one reproductive sample folded into a day-bucket. */
  hasSamples(): boolean {
    return this.byDay.size > 0;
  }

  /**
   * Fold one reproductive HK sample into its day-bucket. `dayKey` is the
   * already-resolved user-local `YYYY-MM-DD`. `rawValue` is the sample's
   * `value` attribute (symbolic name or integer string). `protectionUsed`
   * is the resolved SexualActivity protection metadata (or undefined).
   * Returns true when the sample was consumed (recognised + routed).
   */
  consume(
    hkIdentifier: string,
    dayKey: string,
    rawValue: string | undefined,
    protectionUsed?: boolean,
  ): boolean {
    const route = mapHkCycleSample(hkIdentifier, rawValue, protectionUsed);
    if (route.kind === "skip") return false;

    const bucket = this.bucketFor(dayKey);
    this.mergeFields(bucket, route.fields);

    if (route.kind === "day-log+profile" && route.profile.contraceptive) {
      bucket.contraceptiveNudge = route.profile.contraceptive;
    }

    this.samplesConsumed += 1;
    return true;
  }

  private bucketFor(dayKey: string): DayBucket {
    let bucket = this.byDay.get(dayKey);
    if (!bucket) {
      bucket = { fields: {}, symptomKeys: new Set(), contraceptiveNudge: null };
      this.byDay.set(dayKey, bucket);
    }
    return bucket;
  }

  /** Last-writer-wins merge of a sample's fields into the day-bucket. */
  private mergeFields(bucket: DayBucket, fields: CycleDayLogFields): void {
    if (fields.symptomKey) bucket.symptomKeys.add(fields.symptomKey);
    if (fields.flow !== undefined) bucket.fields.flow = fields.flow;
    if (fields.intermenstrualBleeding !== undefined) {
      bucket.fields.intermenstrualBleeding = fields.intermenstrualBleeding;
    }
    if (fields.ovulationTest !== undefined) {
      bucket.fields.ovulationTest = fields.ovulationTest;
    }
    if (fields.cervicalMucus !== undefined) {
      bucket.fields.cervicalMucus = fields.cervicalMucus;
    }
    if (fields.sexualActivity !== undefined) {
      bucket.fields.sexualActivity = fields.sexualActivity;
    }
    if (fields.protectedSex !== undefined) {
      bucket.fields.protectedSex = fields.protectedSex;
    }
    if (fields.pregnancyTest !== undefined) {
      bucket.fields.pregnancyTest = fields.pregnancyTest;
    }
    if (fields.progesteroneTest !== undefined) {
      bucket.fields.progesteroneTest = fields.progesteroneTest;
    }
    if (fields.contraceptive !== undefined) {
      bucket.fields.contraceptive = fields.contraceptive;
    }
  }

  /**
   * Resolve whether cycle tracking is enabled for the user (gender-derived
   * or the explicit toggle). Cached for the parse lifetime. The importer
   * skips the whole cycle fold when this is false so a non-cycle account's
   * Apple Health export never silently provisions cycle rows.
   */
  async isEnabled(): Promise<boolean> {
    if (this.gated !== null) return this.gated;
    const [user, profile] = await Promise.all([
      prisma.user.findUnique({
        where: { id: this.userId },
        select: { gender: true },
      }),
      prisma.cycleProfile.findUnique({
        where: { userId: this.userId },
        select: { cycleTrackingEnabled: true },
      }),
    ]);
    // Inline the gate logic (no profile auto-create on the import path).
    const toggle = profile?.cycleTrackingEnabled;
    this.gated =
      toggle === true
        ? true
        : toggle === false
          ? false
          : user?.gender === "FEMALE";
    return this.gated;
  }

  /**
   * Upsert one merged `CycleDayLog` per accumulated day. No-op when nothing
   * was consumed. Returns the terminal stats for the importer result.
   */
  async flush(): Promise<CycleImportStats> {
    const stats: CycleImportStats = {
      samplesConsumed: this.samplesConsumed,
      daysUpserted: 0,
      daysInserted: 0,
      goalNudged: false,
    };
    if (this.byDay.size === 0) return stats;

    let contraceptiveNudge: ContraceptiveKind | null = null;

    for (const [dayKey, bucket] of this.byDay.entries()) {
      const symptoms =
        bucket.symptomKeys.size > 0
          ? Array.from(bucket.symptomKeys).map((key) => ({ key }))
          : undefined;

      const entry: CycleDayLogInput = {
        date: dayKey,
        ...bucket.fields,
        ...(symptoms ? { symptoms } : {}),
        source: "APPLE_HEALTH",
        externalId: `${HK_CYCLE_DAY_EXTERNAL_PREFIX}${dayKey}`,
        // The day-log write helper requires a `loggedAt`; anchor it to noon
        // of the day so it is stable across re-imports (the row's measured
        // moment is the day, not a wall-clock instant from the sample).
        loggedAt: `${dayKey}T12:00:00.000Z`,
      };

      const cycleId = await findOwningCycleId(this.userId, dayKey);
      const result = await upsertCycleDayLog(
        this.userId,
        entry,
        this.userTimezone,
        cycleId,
      );
      stats.daysUpserted += 1;
      if (!result.existed) stats.daysInserted += 1;

      // The most-recent contraceptive method across the import drives the
      // single goal nudge (applied once after the day loop).
      if (bucket.contraceptiveNudge) {
        contraceptiveNudge = bucket.contraceptiveNudge;
      }
    }

    // Goal nudge: an active contraceptive method moves a still-default
    // GENERAL_HEALTH profile to AVOID_PREGNANCY. NONE/UNSPECIFIED do not
    // assert avoidance intent, so they leave the goal untouched.
    if (
      contraceptiveNudge &&
      contraceptiveNudge !== "NONE" &&
      contraceptiveNudge !== "UNSPECIFIED"
    ) {
      const updated = await prisma.cycleProfile.updateMany({
        where: { userId: this.userId, goal: "GENERAL_HEALTH" },
        data: { goal: "AVOID_PREGNANCY" },
      });
      if (updated.count > 0) stats.goalNudged = true;
    }

    return stats;
  }
}
