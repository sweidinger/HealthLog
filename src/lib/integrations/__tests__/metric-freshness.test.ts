/**
 * F-SYNC-1 — per-metric-type last-value freshness.
 *
 * Pins that the helper distinguishes a silently-dead metric (its newest reading
 * frozen in the past) from a genuinely-current one, keyed by integration, from
 * one grouped read over the live Measurement rows — the honest signal the
 * per-integration "connected · 5 min ago" pill cannot carry.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const groupByMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({
  prisma: { measurement: { groupBy: groupByMock } },
}));

import {
  getSourceMetricFreshness,
  INTEGRATION_MEASUREMENT_SOURCE,
} from "../metric-freshness";

beforeEach(() => groupByMock.mockReset());

describe("getSourceMetricFreshness", () => {
  it("maps grouped source/type rows to per-integration last-seen entries", async () => {
    groupByMock.mockResolvedValue([
      {
        source: "OURA",
        type: "RESPIRATORY_RATE",
        _max: { measuredAt: new Date("2026-01-01T00:00:00.000Z") },
      },
      {
        source: "OURA",
        type: "RECOVERY_SCORE",
        _max: { measuredAt: new Date("2026-07-07T00:00:00.000Z") },
      },
      {
        source: "WITHINGS",
        type: "WEIGHT",
        _max: { measuredAt: new Date("2026-07-06T00:00:00.000Z") },
      },
    ]);

    const result = await getSourceMetricFreshness("u1");

    // The dead metric (respiratory rate, frozen in January) is visible as a
    // distinct, older timestamp next to the current recovery score — exactly
    // the "broken pipe vs healthy-idle" distinction the pill can't express.
    expect(result.oura).toEqual([
      { type: "RECOVERY_SCORE", lastSeenAt: "2026-07-07T00:00:00.000Z" },
      { type: "RESPIRATORY_RATE", lastSeenAt: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(result.withings).toEqual([
      { type: "WEIGHT", lastSeenAt: "2026-07-06T00:00:00.000Z" },
    ]);
    // Only the sync sources are queried.
    expect(groupByMock.mock.calls[0][0].where.source.in).toEqual(
      Object.values(INTEGRATION_MEASUREMENT_SOURCE),
    );
    expect(groupByMock.mock.calls[0][0].where.deletedAt).toBeNull();
  });

  it("skips rows with no reading and unmapped sources", async () => {
    groupByMock.mockResolvedValue([
      { source: "OURA", type: "VO2_MAX", _max: { measuredAt: null } },
      {
        source: "MANUAL",
        type: "WEIGHT",
        _max: { measuredAt: new Date("2026-07-01T00:00:00.000Z") },
      },
    ]);

    const result = await getSourceMetricFreshness("u1");
    // A null max (no rows) yields no entry; MANUAL isn't a sync integration.
    expect(result.oura).toBeUndefined();
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("returns an empty map when the user has no synced measurements", async () => {
    groupByMock.mockResolvedValue([]);
    expect(await getSourceMetricFreshness("u1")).toEqual({});
  });
});
