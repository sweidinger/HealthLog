/**
 * Snapshot builder for the Coach prompt.
 *
 * Reuses the analytics features pipeline so the Coach narrates the
 * exact same numbers the dashboard tiles render — single source of
 * truth for every "your avg30 BP is …" claim. The output is a compact
 * JSON block the system + user prompt frame as the SNAPSHOT for the
 * model to ground its reply in.
 */
import { extractFeatures } from "@/lib/insights/features";
import type { CoachProvenance } from "./types";

export interface CoachSnapshotResult {
  snapshotJson: string;
  /**
   * Provenance built from snapshot keys actually present. Stays in
   * sync with the SNAPSHOT block so the source-chip row mirrors what
   * the model could see.
   */
  provenance: CoachProvenance;
}

/**
 * Build the Coach prompt snapshot for `userId`. Always uses
 * `includeRaw=false` because the Coach replies are conversational and
 * the user is asking the model — they should never depend on raw
 * measurement timestamps that the privacy mode controls.
 *
 * Bounded to the last 90 days. Coach narrates the same windows the
 * Daily Briefing renders (last7 / last30 / last90); fetching every
 * historical measurement on each turn was unbounded I/O for power
 * users with multi-year Withings imports. The 90-day floor is the
 * widest window any Coach metric currently consumes.
 */
const COACH_SNAPSHOT_WINDOW_DAYS = 90;

export async function buildCoachSnapshot(
  userId: string,
): Promise<CoachSnapshotResult> {
  const features = await extractFeatures(userId, false, {
    sinceDays: COACH_SNAPSHOT_WINDOW_DAYS,
  });

  // Trim down to the metrics the Coach narrates. extractFeatures
  // returns more (sleep, steps, etc.) — the Coach surface keeps the
  // snapshot tight so each turn fits inside the provider's context
  // budget for free-tier accounts.
  const snapshot: Record<string, unknown> = {};
  const windows = new Set<CoachProvenance["windows"][number]>();
  const metrics = new Set<CoachProvenance["metrics"][number]>();
  const counts: NonNullable<CoachProvenance["counts"]> = {};

  if (features.bloodPressure) {
    snapshot.bloodPressure = features.bloodPressure;
    metrics.add("bp");
    windows.add("last30days");
    windows.add("last90days");
    counts.bp = features.bloodPressure.coverage?.count ?? undefined;
  }
  if (features.weight) {
    snapshot.weight = features.weight;
    metrics.add("weight");
    windows.add("last7days");
    windows.add("last30days");
    counts.weight = features.weight.coverage?.count ?? undefined;
  }
  if (features.pulse) {
    snapshot.pulse = features.pulse;
    metrics.add("pulse");
    windows.add("last7days");
    windows.add("last30days");
    windows.add("last90days");
    counts.pulse = features.pulse.coverage?.count ?? undefined;
  }
  if (features.mood) {
    snapshot.mood = features.mood;
    metrics.add("mood");
    windows.add("last7days");
    windows.add("last30days");
    counts.mood = features.mood.coverage?.count ?? undefined;
  }
  // Medication compliance lives outside the structured features today;
  // it is surfaced via a separate route. Mark it as "general" provenance
  // so the chip row indicates "no compliance data in the snapshot" when
  // the Coach is asked about it. Future iteration can pull a compliance
  // window into the snapshot directly.

  if (Object.keys(snapshot).length === 0) {
    metrics.add("general");
  }

  return {
    snapshotJson: JSON.stringify(snapshot, null, 2),
    provenance: {
      windows: Array.from(windows),
      metrics: Array.from(metrics),
      counts: Object.keys(counts).length > 0 ? counts : undefined,
    },
  };
}
