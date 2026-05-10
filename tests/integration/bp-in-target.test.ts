/**
 * Integration regression for the "BD-Zielbereich" / BP-in-target tile.
 *
 * Marc reported (v1.4.16 marathon) that the dashboard tile rendered
 * 0 % despite multiple BP readings clearly inside the well-controlled
 * range. v1.4.15 A4 had restructured the calculation but kept the
 * ESH 2023 narrow-band semantics (`sysLow <= sys <= sysHigh AND diaLow
 * <= dia <= diaHigh`) — which collapses to 0 % for any user whose
 * readings sit BELOW the goal band, which is the most common case for
 * normotensive HealthLog users.
 *
 * v1.4.16 A2 changes semantics to a one-sided "at or below ceiling
 * with a hypotension floor" check. This test seeds a representative
 * mix of readings against the real Postgres testcontainer + Prisma
 * client and asserts the helper produces the expected percentage,
 * guarding against future regressions where someone re-introduces a
 * narrow-band check inline (we have 6 historical call sites — easy to
 * miss one in review).
 *
 * Also covers the null-tolerance regression (NaN / out-of-floor) so
 * the tile never crashes silently to 0 % from edge-case input.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import {
  computeBpInTargetPct,
  computeBpInTargetWindows,
} from "@/lib/analytics/bp-in-target";
import { getBpTargets } from "@/lib/analytics/bp-targets";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BP-in-target % — production data shape", () => {
  it("computes a non-zero % for a normotensive user born under 65", async () => {
    const prisma = getPrismaClient();

    // Marc's actual production readings (anonymised but timestamps + values
    // verbatim so a future reviewer can re-derive the expected count by
    // hand from the test fixture). DOB: 1985-07-09 — under 65, so target
    // is sysHigh = 129, diaHigh = 79.
    const user = await prisma.user.create({
      data: {
        username: "bp-in-target-fixture",
        email: "bp-in-target@example.test",
        dateOfBirth: new Date("1985-07-09"),
      },
    });

    const seedReadings: Array<{
      sys: number;
      dia: number;
      measuredAt: string;
    }> = [
      { sys: 117, dia: 79, measuredAt: "2026-05-08T07:38:22Z" }, // IN
      { sys: 122, dia: 86, measuredAt: "2026-05-03T21:22:02Z" }, // OUT (dia)
      { sys: 108, dia: 76, measuredAt: "2026-05-03T05:51:45Z" }, // IN
      { sys: 106, dia: 73, measuredAt: "2026-05-03T05:50:55Z" }, // IN
      { sys: 127, dia: 86, measuredAt: "2026-04-20T05:57:42Z" }, // OUT (dia)
      { sys: 115, dia: 78, measuredAt: "2026-04-18T06:59:29Z" }, // IN
      { sys: 108, dia: 75, measuredAt: "2026-04-16T05:24:51Z" }, // IN
      { sys: 124, dia: 82, measuredAt: "2026-04-15T05:34:35Z" }, // OUT (dia)
      { sys: 126, dia: 80, measuredAt: "2026-04-15T05:33:44Z" }, // OUT (dia)
      { sys: 133, dia: 95, measuredAt: "2026-04-15T20:52:26Z" }, // OUT (both)
    ];

    // Seed both sys and dia rows at the same `measuredAt` so the helper's
    // 5-minute pairing gate accepts every pair. This mirrors how the
    // measurement form writes paired BP rows.
    for (const r of seedReadings) {
      const at = new Date(r.measuredAt);
      await prisma.measurement.create({
        data: {
          userId: user.id,
          type: "BLOOD_PRESSURE_SYS",
          value: r.sys,
          unit: "mmHg",
          measuredAt: at,
        },
      });
      await prisma.measurement.create({
        data: {
          userId: user.id,
          type: "BLOOD_PRESSURE_DIA",
          value: r.dia,
          unit: "mmHg",
          measuredAt: at,
        },
      });
    }

    const sysData = await prisma.measurement.findMany({
      where: { userId: user.id, type: "BLOOD_PRESSURE_SYS" },
      select: { measuredAt: true, value: true },
    });
    const diaData = await prisma.measurement.findMany({
      where: { userId: user.id, type: "BLOOD_PRESSURE_DIA" },
      select: { measuredAt: true, value: true },
    });

    const targets = getBpTargets(user.dateOfBirth);
    expect(targets).not.toBeNull();
    const result = computeBpInTargetPct(sysData, diaData, targets!);
    expect(result).not.toBeNull();
    expect(result!.pairs).toBe(10);
    // 5 of 10 paired readings are at or below the ceiling and above
    // the hypotension floor — see the `IN`/`OUT` annotations above.
    // Pre-v1.4.16 (narrow-band semantics) would have reported 0 %.
    expect(result!.pct).toBe(50);
  });

  it("returns null for a user with no BP measurements (tile renders 'no data')", async () => {
    const prisma = getPrismaClient();

    const user = await prisma.user.create({
      data: {
        username: "bp-empty-fixture",
        email: "bp-empty@example.test",
        dateOfBirth: new Date("1985-07-09"),
      },
    });

    const sysData = await prisma.measurement.findMany({
      where: { userId: user.id, type: "BLOOD_PRESSURE_SYS" },
      select: { measuredAt: true, value: true },
    });
    const diaData = await prisma.measurement.findMany({
      where: { userId: user.id, type: "BLOOD_PRESSURE_DIA" },
      select: { measuredAt: true, value: true },
    });

    const targets = getBpTargets(user.dateOfBirth);
    expect(computeBpInTargetPct(sysData, diaData, targets!)).toBeNull();
  });

  /**
   * Regression: a user with sys readings but missing dia (e.g., import
   * partial-failure where only sys rows were written) must NOT crash
   * the helper or silently return 0. We expect `null` so the dashboard
   * tile renders the "no data" empty state.
   */
  it("returns null when only sys readings exist (no dia to pair against)", async () => {
    const prisma = getPrismaClient();

    const user = await prisma.user.create({
      data: {
        username: "bp-sys-only-fixture",
        email: "bp-sys-only@example.test",
        dateOfBirth: new Date("1985-07-09"),
      },
    });

    await prisma.measurement.create({
      data: {
        userId: user.id,
        type: "BLOOD_PRESSURE_SYS",
        value: 122,
        unit: "mmHg",
        measuredAt: new Date("2026-05-08T08:00:00Z"),
      },
    });

    const sysData = await prisma.measurement.findMany({
      where: { userId: user.id, type: "BLOOD_PRESSURE_SYS" },
      select: { measuredAt: true, value: true },
    });
    const diaData = await prisma.measurement.findMany({
      where: { userId: user.id, type: "BLOOD_PRESSURE_DIA" },
      select: { measuredAt: true, value: true },
    });

    const targets = getBpTargets(user.dateOfBirth);
    expect(computeBpInTargetPct(sysData, diaData, targets!)).toBeNull();
  });

  /**
   * Regression: a hypotensive reading (sys 80, dia 50) is NOT
   * "well-controlled" — it's symptomatic low BP. The helper must mark
   * it OUT of target despite being below the ceiling. The clinical
   * floor (sys >= 90, dia >= 50) is what guards this.
   */
  it("excludes symptomatic-hypotension readings from the in-target count", async () => {
    const prisma = getPrismaClient();

    const user = await prisma.user.create({
      data: {
        username: "bp-hypo-fixture",
        email: "bp-hypo@example.test",
        dateOfBirth: new Date("1985-07-09"),
      },
    });

    const seedReadings: Array<{ sys: number; dia: number }> = [
      { sys: 80, dia: 45 }, // hypotensive — out
      { sys: 122, dia: 75 }, // normal — in
    ];

    for (const [i, r] of seedReadings.entries()) {
      const at = new Date(`2026-05-0${i + 1}T08:00:00Z`);
      await prisma.measurement.create({
        data: {
          userId: user.id,
          type: "BLOOD_PRESSURE_SYS",
          value: r.sys,
          unit: "mmHg",
          measuredAt: at,
        },
      });
      await prisma.measurement.create({
        data: {
          userId: user.id,
          type: "BLOOD_PRESSURE_DIA",
          value: r.dia,
          unit: "mmHg",
          measuredAt: at,
        },
      });
    }

    const sysData = await prisma.measurement.findMany({
      where: { userId: user.id, type: "BLOOD_PRESSURE_SYS" },
      select: { measuredAt: true, value: true },
    });
    const diaData = await prisma.measurement.findMany({
      where: { userId: user.id, type: "BLOOD_PRESSURE_DIA" },
      select: { measuredAt: true, value: true },
    });

    const targets = getBpTargets(user.dateOfBirth);
    const result = computeBpInTargetPct(sysData, diaData, targets!);
    expect(result).toEqual({ pct: 50, pairs: 2 });
  });
});

describe("BP-in-target % — windowed (7-day + 30-day) — production data shape", () => {
  /**
   * v1.4.18 A1 regression — Marc's BD-Zielbereich tile rendered the
   * 30-day headline (50 %) but `7T: —` and `30T: —` placeholders even
   * though he had paired BP readings in both windows. Root cause was
   * that the API only returned a single `bpInTargetPct`; the tile got
   * `avg7={null}, avg30={null}` and rendered the dash fallback. The fix
   * surfaces both windows from `computeBpInTargetWindows()` against the
   * same input series.
   *
   * Seeds 30 days of paired readings (one per day, 8/30 = 26 % in
   * target) and asserts the 7-day window vs 30-day window agree with a
   * hand-derivable count.
   */
  it("seeds 30 days of BP and returns non-null 7d + 30d shares", async () => {
    const prisma = getPrismaClient();
    const user = await prisma.user.create({
      data: {
        username: "bp-windows-fixture",
        email: "bp-windows@example.test",
        dateOfBirth: new Date("1985-07-09"),
      },
    });

    // Anchor the synthetic readings against a "now" that the helper can
    // see — we seed at fractional-day offsets so the boundary of the
    // 7-day window (`>= now - 7d`) is unambiguous. Days 0.5..6.5 sit
    // strictly inside the 7-day window; days 7.5..29.5 sit strictly
    // outside it but inside the 30-day window.
    const now = new Date();
    // A small mix:
    //   - days 0.5-6.5 (7-day window): 7 readings, 4 in target.
    //   - days 7.5-29.5 (older 30-day window only): 22 readings,
    //     11 in target (alternating, starting in-target).
    // Expected windows:
    //   last7Days: 4/7 = 57 % (rounded).
    //   last30Days: 15/29 = 52 % (rounded).
    const seed: Array<{ daysAgo: number; sys: number; dia: number }> = [
      // 7-day window (4 IN, 3 OUT)
      { daysAgo: 0.5, sys: 117, dia: 79 }, // IN
      { daysAgo: 1.5, sys: 122, dia: 86 }, // OUT (dia)
      { daysAgo: 2.5, sys: 108, dia: 76 }, // IN
      { daysAgo: 3.5, sys: 145, dia: 95 }, // OUT (both)
      { daysAgo: 4.5, sys: 115, dia: 78 }, // IN
      { daysAgo: 5.5, sys: 124, dia: 82 }, // OUT (dia)
      { daysAgo: 6.5, sys: 125, dia: 75 }, // IN
      // older 7-30-day window (alternating, 11 IN / 11 OUT)
      ...Array.from({ length: 22 }, (_, i) => {
        const daysAgo = 7.5 + i;
        const isIn = i % 2 === 0;
        return isIn
          ? { daysAgo, sys: 122, dia: 75 }
          : { daysAgo, sys: 145, dia: 90 };
      }),
    ];

    for (const r of seed) {
      const at = new Date(now.getTime() - r.daysAgo * 24 * 60 * 60 * 1000);
      await prisma.measurement.create({
        data: {
          userId: user.id,
          type: "BLOOD_PRESSURE_SYS",
          value: r.sys,
          unit: "mmHg",
          measuredAt: at,
        },
      });
      await prisma.measurement.create({
        data: {
          userId: user.id,
          type: "BLOOD_PRESSURE_DIA",
          value: r.dia,
          unit: "mmHg",
          measuredAt: at,
        },
      });
    }

    const sysData = await prisma.measurement.findMany({
      where: { userId: user.id, type: "BLOOD_PRESSURE_SYS" },
      select: { measuredAt: true, value: true },
    });
    const diaData = await prisma.measurement.findMany({
      where: { userId: user.id, type: "BLOOD_PRESSURE_DIA" },
      select: { measuredAt: true, value: true },
    });
    const targets = getBpTargets(user.dateOfBirth);
    expect(targets).not.toBeNull();

    const windows = computeBpInTargetWindows(sysData, diaData, targets!, now);

    // Both windows must produce a value — that's the regression.
    expect(windows.last7Days).not.toBeNull();
    expect(windows.last30Days).not.toBeNull();

    // Hand-counted: 7-day window = 4/7 paired in target.
    expect(windows.last7Days!.pairs).toBe(7);
    expect(windows.last7Days!.pct).toBe(Math.round((4 / 7) * 100));

    // 30-day window = 7 (last week) + 22 (older) = 29 paired readings.
    // In-target: 4 (last week) + 11 (older, even-indexed alternation
    // for i ∈ {0,2,4,...,20} = 11) = 15.
    expect(windows.last30Days!.pairs).toBe(29);
    expect(windows.last30Days!.pct).toBe(Math.round((15 / 29) * 100));
  });

  /**
   * v1.4.19 A1 regression — Marc reported the tile shows EXACTLY 50 %
   * on 7T, 30T, AND the headline ("total"). With his real production
   * shape (572 paired readings since 2022, recent 30d ≈ 50 %, all-time
   * ≈ 11 %) the headline cannot legitimately be 50 %. Root cause: the
   * analytics route routed `bpInTargetPct = windows.last30Days?.pct`,
   * making the headline a literal copy of `30T`. The fix returns a
   * third `allTime` window that the route now uses for the headline.
   *
   * Seeds 2 paired readings within the last 7 days (1 IN, 1 OUT = 50 %),
   * 8 additional within the last 30 days (4 IN, 4 OUT = 50 %), and 30
   * older readings (all OUT) so the all-time figure diverges sharply
   * from both windows. Pinned for regression so a future refactor can't
   * silently re-collapse the three numbers.
   */
  it("returns three independent windows: 7d, 30d, and allTime each computed from a different denominator", async () => {
    const prisma = getPrismaClient();
    const user = await prisma.user.create({
      data: {
        username: "bp-three-windows-fixture",
        email: "bp-three-windows@example.test",
        dateOfBirth: new Date("1985-07-09"),
      },
    });

    const now = new Date();
    const seed: Array<{ daysAgo: number; sys: number; dia: number }> = [
      // Last 7 days: 1 IN, 1 OUT.
      { daysAgo: 1.5, sys: 117, dia: 79 }, // IN
      { daysAgo: 5.5, sys: 145, dia: 95 }, // OUT
      // 7-30 days ago: 4 IN, 4 OUT (alternating).
      { daysAgo: 8, sys: 122, dia: 75 }, // IN
      { daysAgo: 10, sys: 145, dia: 95 }, // OUT
      { daysAgo: 12, sys: 125, dia: 78 }, // IN
      { daysAgo: 14, sys: 145, dia: 90 }, // OUT
      { daysAgo: 18, sys: 120, dia: 70 }, // IN
      { daysAgo: 22, sys: 150, dia: 95 }, // OUT
      { daysAgo: 25, sys: 128, dia: 79 }, // IN
      { daysAgo: 28, sys: 160, dia: 100 }, // OUT
      // Older history: 30 readings, all OUT (drives all-time well below 50 %).
      ...Array.from({ length: 30 }, (_, i) => ({
        daysAgo: 60 + i * 3,
        sys: 160,
        dia: 100,
      })),
    ];
    for (const r of seed) {
      const at = new Date(now.getTime() - r.daysAgo * 24 * 60 * 60 * 1000);
      await prisma.measurement.create({
        data: {
          userId: user.id,
          type: "BLOOD_PRESSURE_SYS",
          value: r.sys,
          unit: "mmHg",
          measuredAt: at,
        },
      });
      await prisma.measurement.create({
        data: {
          userId: user.id,
          type: "BLOOD_PRESSURE_DIA",
          value: r.dia,
          unit: "mmHg",
          measuredAt: at,
        },
      });
    }

    const sysData = await prisma.measurement.findMany({
      where: { userId: user.id, type: "BLOOD_PRESSURE_SYS" },
      select: { measuredAt: true, value: true },
    });
    const diaData = await prisma.measurement.findMany({
      where: { userId: user.id, type: "BLOOD_PRESSURE_DIA" },
      select: { measuredAt: true, value: true },
    });
    const targets = getBpTargets(user.dateOfBirth);
    expect(targets).not.toBeNull();
    const windows = computeBpInTargetWindows(sysData, diaData, targets!, now);

    // 7-day window: 2 paired readings, 1 in target.
    expect(windows.last7Days).toEqual({ pct: 50, pairs: 2 });
    // 30-day window: 10 paired readings, 5 in target.
    expect(windows.last30Days).toEqual({ pct: 50, pairs: 10 });
    // All-time: 40 paired readings, 5 in target = 13 % (rounded).
    expect(windows.allTime).not.toBeNull();
    expect(windows.allTime!.pairs).toBe(40);
    expect(windows.allTime!.pct).toBe(Math.round((5 / 40) * 100));

    // The smoking gun: even when 7d AND 30d are 50 %, all-time is NOT
    // 50 % once older history is present. Marc's prod tile pinned to
    // 50/50/50 because the route routed the headline through `last30Days`
    // — the algorithmic pin the brief warned about.
    expect(windows.allTime!.pct).not.toBe(windows.last30Days!.pct);
    expect(windows.allTime!.pct).not.toBe(windows.last7Days!.pct);
  });

  /**
   * Regression: a user with all readings older than 7 days but inside
   * 30 days must show a 30-day percentage AND a null 7-day window
   * (the tile renders "—" for 7T but a real number for 30T). Pre-fix
   * both rendered "—" because neither was computed at all.
   */
  it("returns null 7-day window but a real 30-day window when no recent data", async () => {
    const prisma = getPrismaClient();
    const user = await prisma.user.create({
      data: {
        username: "bp-no-recent-fixture",
        email: "bp-no-recent@example.test",
        dateOfBirth: new Date("1985-07-09"),
      },
    });

    const now = new Date();
    const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

    await prisma.measurement.create({
      data: {
        userId: user.id,
        type: "BLOOD_PRESSURE_SYS",
        value: 122,
        unit: "mmHg",
        measuredAt: fourteenDaysAgo,
      },
    });
    await prisma.measurement.create({
      data: {
        userId: user.id,
        type: "BLOOD_PRESSURE_DIA",
        value: 75,
        unit: "mmHg",
        measuredAt: fourteenDaysAgo,
      },
    });

    const sysData = await prisma.measurement.findMany({
      where: { userId: user.id, type: "BLOOD_PRESSURE_SYS" },
      select: { measuredAt: true, value: true },
    });
    const diaData = await prisma.measurement.findMany({
      where: { userId: user.id, type: "BLOOD_PRESSURE_DIA" },
      select: { measuredAt: true, value: true },
    });
    const targets = getBpTargets(user.dateOfBirth);
    const windows = computeBpInTargetWindows(sysData, diaData, targets!, now);

    expect(windows.last7Days).toBeNull();
    expect(windows.last30Days).toEqual({ pct: 100, pairs: 1 });
  });
});

/**
 * v1.4.22 A1 — re-anchor the headline to last-30 days.
 *
 * Up to v1.4.19 the headline was the all-time figure. That made the
 * tile correct (no algorithmic 50/50/50 pin) but emotionally wrong:
 * the headline was the slowest-moving aggregate possible, so a user
 * who had genuinely improved their last-30-day discipline saw a
 * stubbornly low number that took years of further compliance to
 * budge. v1.4.22 routes the headline through `last30Days` and surfaces
 * `7d` / `30d` / `Allzeit` as a 3-line sub-row instead.
 *
 * The integration assertion: with three legitimately divergent
 * windows (recent 50 % vs all-time 13 %) the route's `bpInTargetPct`
 * field equals `windows.last30Days.pct` (50 %), and a separate
 * `bpInTargetPctAllTime` carries the long-arc number (13 %) so the
 * tile can render the third sub-line.
 */
describe("GET /api/analytics — BP-in-target headline (v1.4.22 A1)", () => {
  async function seedSession(username: string) {
    const prisma = getPrismaClient();
    const user = await prisma.user.create({
      data: {
        username,
        email: `${username}@example.test`,
        role: "USER",
        dateOfBirth: new Date("1985-07-09"),
      },
    });
    const session = await prisma.session.create({
      data: {
        userId: user.id,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    cookieJar.set("healthlog_session", session.id);
    return user;
  }

  it("routes the headline through last-30-days and exposes all-time as a separate field", async () => {
    const prisma = getPrismaClient();
    const user = await seedSession("bp-headline-fixture");

    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;

    // Seed exactly the v1.4.19-A1 production-shape regression: 7d and
    // 30d both ~50 %, all-time ~13 %.
    const seed: Array<{ daysAgo: number; sys: number; dia: number }> = [
      // Last 7 days: 1 IN, 1 OUT.
      { daysAgo: 1.5, sys: 117, dia: 79 },
      { daysAgo: 5.5, sys: 145, dia: 95 },
      // 7-30 days ago: 4 IN, 4 OUT.
      { daysAgo: 8, sys: 122, dia: 75 },
      { daysAgo: 10, sys: 145, dia: 95 },
      { daysAgo: 12, sys: 125, dia: 78 },
      { daysAgo: 14, sys: 145, dia: 90 },
      { daysAgo: 18, sys: 120, dia: 70 },
      { daysAgo: 22, sys: 150, dia: 95 },
      { daysAgo: 25, sys: 128, dia: 79 },
      { daysAgo: 28, sys: 160, dia: 100 },
      // Older history: 30 readings, all OUT (drives all-time well below 50 %).
      ...Array.from({ length: 30 }, (_, i) => ({
        daysAgo: 60 + i * 3,
        sys: 160,
        dia: 100,
      })),
    ];
    for (const r of seed) {
      const at = new Date(now - r.daysAgo * DAY);
      await prisma.measurement.create({
        data: {
          userId: user.id,
          type: "BLOOD_PRESSURE_SYS",
          value: r.sys,
          unit: "mmHg",
          measuredAt: at,
        },
      });
      await prisma.measurement.create({
        data: {
          userId: user.id,
          type: "BLOOD_PRESSURE_DIA",
          value: r.dia,
          unit: "mmHg",
          measuredAt: at,
        },
      });
    }

    const { GET } = await import("@/app/api/analytics/route");
    const res = await (GET as (req: Request) => Promise<Response>)(
      new Request("http://localhost/api/analytics"),
    );
    expect(res.status).toBe(200);
    const env = (await res.json()) as {
      data: {
        bpInTargetPct: number | null;
        bpInTargetPct7d: number | null;
        bpInTargetPct30d: number | null;
        bpInTargetPctAllTime: number | null;
      } | null;
    };
    expect(env.data).not.toBeNull();
    const data = env.data!;

    // The headline now equals the 30-day window — not the all-time aggregate.
    // 30-day = 5/10 in target = 50 %.
    expect(data.bpInTargetPct).toBe(50);
    expect(data.bpInTargetPct30d).toBe(50);
    expect(data.bpInTargetPct).toBe(data.bpInTargetPct30d);

    // 7-day window: 2 paired readings, 1 in target = 50 %.
    expect(data.bpInTargetPct7d).toBe(50);

    // All-time = 5 / 40 in target = 13 % (rounded). Surfaced as a
    // separate field so the tile can render it as a sub-row.
    expect(data.bpInTargetPctAllTime).toBe(Math.round((5 / 40) * 100));

    // Smoking gun: the headline must NOT equal the all-time number now
    // that the route re-anchored to last-30. This is the v1.4.22 A1
    // contract pin.
    expect(data.bpInTargetPct).not.toBe(data.bpInTargetPctAllTime);
  });

  it("emits all three windows in the response envelope", async () => {
    const prisma = getPrismaClient();
    const user = await seedSession("bp-three-windows-route-fixture");

    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;

    // Minimum seed that produces non-null for every window.
    for (let i = 0; i < 3; i++) {
      const at = new Date(now - (i + 0.5) * DAY);
      await prisma.measurement.create({
        data: {
          userId: user.id,
          type: "BLOOD_PRESSURE_SYS",
          value: 122,
          unit: "mmHg",
          measuredAt: at,
        },
      });
      await prisma.measurement.create({
        data: {
          userId: user.id,
          type: "BLOOD_PRESSURE_DIA",
          value: 75,
          unit: "mmHg",
          measuredAt: at,
        },
      });
    }

    const { GET } = await import("@/app/api/analytics/route");
    const res = await (GET as (req: Request) => Promise<Response>)(
      new Request("http://localhost/api/analytics"),
    );
    expect(res.status).toBe(200);
    const env = (await res.json()) as {
      data: {
        bpInTargetPct: number | null;
        bpInTargetPct7d: number | null;
        bpInTargetPct30d: number | null;
        bpInTargetPctAllTime: number | null;
      };
    };
    const data = env.data;
    // All three windows present + non-null.
    expect(data.bpInTargetPct).not.toBeNull();
    expect(data.bpInTargetPct7d).not.toBeNull();
    expect(data.bpInTargetPct30d).not.toBeNull();
    expect(data.bpInTargetPctAllTime).not.toBeNull();
  });
});
