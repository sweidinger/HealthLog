/**
 * v1.20.1 perf — the comparison-snapshot builder must bound its
 * per-type measurement read to a ~400-day window instead of scanning a
 * user's entire history. The snapshot only feeds summarize()'s avg30 /
 * avg30LastMonth / avg30LastYear, and the widest of those reaches into
 * the [365, 395)-day window, so nothing older than 395 days can change a
 * result. These tests pin that:
 *   - every measurement read carries a `measuredAt.gte` lower bound,
 *   - the bound sits at ~400 days (5-day floor over the 395-day reach),
 *   - the three averages are unaffected for in-window data.
 *
 * The read fans out over all seven snapshot types on the page-blocking
 * POST /api/insights/generate path AND the nightly pregenerate cron, so
 * an unbounded scan is tens of thousands of rows per type on multi-year
 * accounts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const findUnique = vi.fn();
const measurementFindMany = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: (...a: unknown[]) => findUnique(...a),
    },
    measurement: {
      findMany: (...a: unknown[]) => measurementFindMany(...a),
    },
  },
}));
// SLEEP_DURATION branch helpers — the test never exercises the sleep
// reconstruction maths, but the builder imports these unconditionally.
vi.mock("@/lib/tz/resolver", () => ({
  resolveUserTimezone: vi.fn(async () => "Europe/Berlin"),
}));
vi.mock("@/lib/rollups/measurement-read", () => ({
  loadUserSourcePriority: vi.fn(async () => []),
}));

import { buildComparisonSnapshotForUser } from "../comprehensive-generate";

const DAY = 86_400_000;

beforeEach(() => {
  vi.clearAllMocks();
  // Comparison toggle ON → the builder runs its per-type reads. The
  // baseline value drives which prior-period mean the snapshot reports.
  // `resolveDashboardLayout` only honours `comparisonBaseline` on a blob
  // that carries a numeric `version` + a `widgets` array; otherwise it
  // clamps to "none".
  findUnique.mockResolvedValue({
    dashboardWidgetsJson: {
      version: 1,
      widgets: [],
      comparisonBaseline: "lastYear",
    },
  });
  // No measurements by default; individual tests override per call.
  measurementFindMany.mockResolvedValue([]);
});

describe("buildComparisonSnapshotForUser — bounded read window", () => {
  it("bounds every measurement read with a ~400-day measuredAt.gte floor", async () => {
    const before = Date.now();
    await buildComparisonSnapshotForUser("u1");
    const after = Date.now();

    // One findMany per snapshot type (sleep takes a different select but
    // the same where shape). Every call must carry the lower bound.
    expect(measurementFindMany).toHaveBeenCalled();
    for (const call of measurementFindMany.mock.calls) {
      const where = (call[0] as { where: Record<string, unknown> }).where;
      expect(where).toMatchObject({ userId: "u1", deletedAt: null });
      const measuredAt = where.measuredAt as { gte: Date };
      expect(measuredAt).toBeDefined();
      expect(measuredAt.gte).toBeInstanceOf(Date);

      // The floor is anchored on Date.now() - 400 days (allow scheduling
      // slack between the snapshot's clock read and the test's bracket).
      const gteMs = measuredAt.gte.getTime();
      expect(gteMs).toBeLessThanOrEqual(before - 400 * DAY);
      expect(gteMs).toBeGreaterThanOrEqual(after - 401 * DAY);
    }
  });

  it("keeps the floor strictly older than the 395-day reach of avg30LastYear", async () => {
    const now = Date.now();
    await buildComparisonSnapshotForUser("u1");

    // avg30LastYear reads points with age < 395 days. The bound must sit
    // at least 5 days older so it never clips that window.
    for (const call of measurementFindMany.mock.calls) {
      const where = (call[0] as { where: { measuredAt: { gte: Date } } }).where;
      const ageDays = (now - where.measuredAt.gte.getTime()) / DAY;
      expect(ageDays).toBeGreaterThanOrEqual(395);
    }
  });

  it("computes avg30 / avg30LastMonth / avg30LastYear unchanged for in-window data", async () => {
    findUnique.mockResolvedValue({
      dashboardWidgetsJson: {
        version: 1,
        widgets: [],
        comparisonBaseline: "lastMonth",
      },
    });

    const now = Date.now();
    // WEIGHT is the first non-sleep type. Seed three points, one in each
    // of the avg30 (current), avg30LastMonth ([30,60)) windows — all well
    // inside the 400-day floor.
    measurementFindMany.mockImplementation(
      async (args: { where: { type: string } }) => {
        if (args.where.type !== "WEIGHT") return [];
        return [
          { measuredAt: new Date(now - 5 * DAY), value: 80 }, // current
          { measuredAt: new Date(now - 45 * DAY), value: 84 }, // lastMonth
        ];
      },
    );

    const snapshot = await buildComparisonSnapshotForUser("u1");
    expect(snapshot).not.toBeNull();
    const weight = snapshot!.metrics.find((m) => m.type === "weight");
    expect(weight).toBeDefined();
    // avg30 over the single current point.
    expect(weight!.currentAvg).toBe(80);
    // lastMonth baseline over the single [30,60) point.
    expect(weight!.baselineAvg).toBe(84);
    expect(weight!.delta).toBe(-4);
  });

  it("returns null without reading measurements when the comparison toggle is off", async () => {
    findUnique.mockResolvedValue({
      dashboardWidgetsJson: {
        version: 1,
        widgets: [],
        comparisonBaseline: "none",
      },
    });
    const snapshot = await buildComparisonSnapshotForUser("u1");
    expect(snapshot).toBeNull();
    expect(measurementFindMany).not.toHaveBeenCalled();
  });
});
