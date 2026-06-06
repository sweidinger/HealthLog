/**
 * Cycle prediction cache — debounced stale-while-revalidate (the v1.8.7
 * insight-assessment cache pattern, ios-contract §2.D).
 *
 * `GET /api/cycle/calendar` runs the pure engine synchronously (it is
 * cheap) for the live forecast it returns, AND persists that forecast to
 * the `CyclePrediction` cache row so the Coach snapshot + notifications
 * read a stable materialised value without re-running the engine. The
 * persist is debounced: a re-write only lands when the prior row is older
 * than the debounce window OR the forecast actually changed, so a tight
 * read loop never thrashes the row.
 */
import { prisma } from "@/lib/db";
import type { CyclePredictionResult } from "@/lib/cycle/types";

/** Don't re-persist an unchanged forecast more often than this. */
const PREDICTION_DEBOUNCE_MS = 6 * 60 * 60 * 1000; // 6h

/**
 * Persist (or refresh) the cached forecast for a user, debounced. A
 * no-op when a fresh-enough identical row already exists. Best-effort:
 * never throws into the read path.
 */
export async function persistPredictionCache(
  userId: string,
  result: CyclePredictionResult,
  now: Date = new Date(),
): Promise<void> {
  try {
    const existing = await prisma.cyclePrediction.findUnique({
      where: { userId },
      select: {
        method: true,
        nextPeriodStart: true,
        nextPeriodStartLow: true,
        nextPeriodStartHigh: true,
        confidence: true,
        cyclesObserved: true,
        generatedAt: true,
      },
    });

    const unchanged =
      existing !== null &&
      existing.method === result.method &&
      existing.nextPeriodStart === result.nextPeriodStart &&
      existing.nextPeriodStartLow === result.nextPeriodStartLow &&
      existing.nextPeriodStartHigh === result.nextPeriodStartHigh &&
      existing.confidence === result.confidence &&
      existing.cyclesObserved === result.cyclesObserved;

    const fresh =
      existing !== null &&
      now.getTime() - existing.generatedAt.getTime() < PREDICTION_DEBOUNCE_MS;

    // Skip the write only when the row is BOTH unchanged AND fresh.
    if (unchanged && fresh) return;

    const data = {
      method: result.method,
      nextPeriodStart: result.nextPeriodStart,
      nextPeriodStartLow: result.nextPeriodStartLow,
      nextPeriodStartHigh: result.nextPeriodStartHigh,
      fertileWindowStart: result.fertileWindowStart,
      fertileWindowEnd: result.fertileWindowEnd,
      predictedOvulation: result.predictedOvulation,
      confidence: result.confidence,
      cyclesObserved: result.cyclesObserved,
      generatedAt: now,
    };

    await prisma.cyclePrediction.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
  } catch {
    /* best-effort cache write — the live engine result is authoritative */
  }
}
