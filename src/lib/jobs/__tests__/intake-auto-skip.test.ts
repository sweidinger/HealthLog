/**
 * v1.4.46 — coverage for the hourly intake-auto-miss helper.
 *
 * v1.15.9 — the terminal state is now `auto_missed = true`, NOT
 * `skipped = true`. A forgotten dose is a real MISS that must count against
 * adherence; flipping `skipped` (which the compliance engine excludes from
 * the denominator) silently inflated the rate. The helper runs a single
 * `updateMany` with the `skipped = false AND auto_missed = false AND
 * takenAt IS NULL AND scheduledFor < cutoff` gate, where `cutoff = now - 24 h`.
 * These tests pin:
 *   * cron + queue contract (constants don't drift),
 *   * cutoff is `now - 24 h` exactly (off-by-one safety),
 *   * Prisma `updateMany` is called with the spec'd shape
 *     (`auto_missed = true`, not `skipped = true`),
 *   * a user-skipped row is left untouched (a deliberate pause is never
 *     reclassified as a miss),
 *   * idempotency-by-construction (a second pass finds zero candidates).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";

import {
  INTAKE_AUTO_SKIP_CRON,
  INTAKE_AUTO_SKIP_GRACE_HOURS,
  INTAKE_AUTO_SKIP_QUEUE,
  runIntakeAutoSkipPass,
} from "../intake-auto-skip";

interface FakeIntakeRow {
  id: string;
  userId: string;
  scheduledFor: Date;
  takenAt: Date | null;
  skipped: boolean;
  autoMissed: boolean;
}

interface FakeUpdateManyWhere {
  skipped?: boolean;
  autoMissed?: boolean;
  takenAt?: null;
  scheduledFor?: { lt: Date };
}

function makeFakePrisma(state: { rows: FakeIntakeRow[] }) {
  return {
    medicationIntakeEvent: {
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: FakeUpdateManyWhere;
          data: { autoMissed: boolean };
        }) => {
          let count = 0;
          for (const row of state.rows) {
            if (where.skipped !== undefined && row.skipped !== where.skipped)
              continue;
            if (
              where.autoMissed !== undefined &&
              row.autoMissed !== where.autoMissed
            )
              continue;
            if (where.takenAt === null && row.takenAt !== null) continue;
            if (
              where.scheduledFor?.lt !== undefined &&
              row.scheduledFor.getTime() >= where.scheduledFor.lt.getTime()
            )
              continue;
            row.autoMissed = data.autoMissed;
            count += 1;
          }
          return { count };
        },
      ),
    },
  } as unknown as PrismaClient;
}

const NOW = new Date("2026-05-22T12:00:00Z");
const NOW_MS = NOW.getTime();
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

describe("intake-auto-skip — schedule contract", () => {
  it("cron fires hourly at :05 to dodge the :00 reminder-check tick", () => {
    expect(INTAKE_AUTO_SKIP_CRON).toBe("5 * * * *");
  });

  it("queue name stays stable so the scheduler entry doesn't desync", () => {
    expect(INTAKE_AUTO_SKIP_QUEUE).toBe("intake-auto-skip");
  });

  it("grace window is exactly 24 hours", () => {
    expect(INTAKE_AUTO_SKIP_GRACE_HOURS).toBe(24);
  });
});

describe("runIntakeAutoSkipPass", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("flips pending rows older than 24 h to auto_missed=true (NOT skipped)", async () => {
    const rows: FakeIntakeRow[] = [
      // Stale + unmarked → must flip.
      {
        id: "i-stale-1",
        userId: "u1",
        scheduledFor: new Date(NOW_MS - 30 * HOUR_MS),
        takenAt: null,
        skipped: false,
        autoMissed: false,
      },
      // Stale + unmarked (different user) → must flip.
      {
        id: "i-stale-2",
        userId: "u2",
        scheduledFor: new Date(NOW_MS - 48 * HOUR_MS),
        takenAt: null,
        skipped: false,
        autoMissed: false,
      },
      // Recent (< 24 h) → must stay pending.
      {
        id: "i-recent",
        userId: "u1",
        scheduledFor: new Date(NOW_MS - 6 * HOUR_MS),
        takenAt: null,
        skipped: false,
        autoMissed: false,
      },
      // Already taken → must stay.
      {
        id: "i-taken",
        userId: "u1",
        scheduledFor: new Date(NOW_MS - 36 * HOUR_MS),
        takenAt: new Date(NOW_MS - 30 * HOUR_MS),
        skipped: false,
        autoMissed: false,
      },
      // Already manually skipped → must stay a deliberate skip, never
      // reclassified as an auto-miss.
      {
        id: "i-already-skipped",
        userId: "u1",
        scheduledFor: new Date(NOW_MS - 48 * HOUR_MS),
        takenAt: null,
        skipped: true,
        autoMissed: false,
      },
    ];
    const state = { rows };
    const prisma = makeFakePrisma(state);

    const result = await runIntakeAutoSkipPass(prisma, { nowMs: NOW_MS });

    expect(result.skippedCount).toBe(2);
    expect(result.cutoff.getTime()).toBe(NOW_MS - DAY_MS);
    expect(state.rows.find((r) => r.id === "i-stale-1")?.autoMissed).toBe(true);
    expect(state.rows.find((r) => r.id === "i-stale-2")?.autoMissed).toBe(true);
    expect(state.rows.find((r) => r.id === "i-recent")?.autoMissed).toBe(false);
    expect(state.rows.find((r) => r.id === "i-taken")?.autoMissed).toBe(false);
    // The forgotten doses are NOT marked as a user skip.
    expect(state.rows.find((r) => r.id === "i-stale-1")?.skipped).toBe(false);
    // A deliberate user skip is left exactly as it was.
    expect(
      state.rows.find((r) => r.id === "i-already-skipped")?.skipped,
    ).toBe(true);
    expect(
      state.rows.find((r) => r.id === "i-already-skipped")?.autoMissed,
    ).toBe(false);
  });

  it("calls prisma.updateMany with the spec'd where + data shape", async () => {
    const state = { rows: [] as FakeIntakeRow[] };
    const prisma = makeFakePrisma(state);

    await runIntakeAutoSkipPass(prisma, { nowMs: NOW_MS });

    expect(prisma.medicationIntakeEvent.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.medicationIntakeEvent.updateMany).toHaveBeenCalledWith({
      where: {
        skipped: false,
        autoMissed: false,
        takenAt: null,
        scheduledFor: { lt: new Date(NOW_MS - DAY_MS) },
      },
      data: { autoMissed: true },
    });
  });

  it("is idempotent — a second pass on the same state finds zero candidates", async () => {
    const rows: FakeIntakeRow[] = [
      {
        id: "i-stale",
        userId: "u1",
        scheduledFor: new Date(NOW_MS - 30 * HOUR_MS),
        takenAt: null,
        skipped: false,
        autoMissed: false,
      },
    ];
    const state = { rows };
    const prisma = makeFakePrisma(state);

    const first = await runIntakeAutoSkipPass(prisma, { nowMs: NOW_MS });
    expect(first.skippedCount).toBe(1);

    const second = await runIntakeAutoSkipPass(prisma, { nowMs: NOW_MS });
    expect(second.skippedCount).toBe(0);
  });

  it("does NOT flip rows exactly at the 24 h boundary (uses strict <)", async () => {
    // The SQL gate is `scheduledFor < NOW - 24h` — a row whose
    // `scheduledFor` lands at the cutoff instant must stay pending so
    // the user still has the closing minute of the window to mark it.
    const rows: FakeIntakeRow[] = [
      {
        id: "i-boundary",
        userId: "u1",
        scheduledFor: new Date(NOW_MS - DAY_MS),
        takenAt: null,
        skipped: false,
        autoMissed: false,
      },
    ];
    const state = { rows };
    const prisma = makeFakePrisma(state);

    const result = await runIntakeAutoSkipPass(prisma, { nowMs: NOW_MS });
    expect(result.skippedCount).toBe(0);
    expect(state.rows[0].autoMissed).toBe(false);
  });

  it("uses Date.now() when no nowMs override is supplied", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const state = { rows: [] as FakeIntakeRow[] };
      const prisma = makeFakePrisma(state);

      const result = await runIntakeAutoSkipPass(prisma);
      expect(result.cutoff.getTime()).toBe(NOW_MS - DAY_MS);
    } finally {
      vi.useRealTimers();
    }
  });
});
