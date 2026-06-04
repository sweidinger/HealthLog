/**
 * v1.4.23 — sleep-stage aggregation in `GET /api/analytics`.
 *
 * The Apple Health batch endpoint stores one Measurement row per sleep
 * stage per night. Two contracts the analytics route now upholds:
 *
 *   1. `summaries.SLEEP_DURATION` aggregates per Berlin day (sums the
 *      stage rows) so the summary's `latest`/`mean` reflect the total
 *      minutes asleep on a given night, not a single stage.
 *
 *   2. A new `sleepStages` block surfaces the per-stage breakdown over
 *      the trailing 30 days when stage-tagged rows exist; it is
 *      `null` for a user with no per-stage rows so the existing UI
 *      keeps painting the totals-only path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

interface AnalyticsEnvelope {
  data: {
    summaries: Record<
      string,
      {
        count: number;
        latest: number | null;
        mean: number | null;
      }
    >;
    sleepStages: {
      windowDays: number;
      nights: number;
      totalMinutes: number;
      stages: Record<string, number>;
      perNight: Array<{ dayKey: string; stages: Record<string, number> }>;
    } | null;
  };
}

async function seedSession(username: string) {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username,
      email: `${username}@example.test`,
      role: "USER",
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

describe("GET /api/analytics — sleep-stage aggregation", () => {
  it("aggregates per-stage rows into a single per-night summary + a stage breakdown", async () => {
    const prisma = getPrismaClient();
    const user = await seedSession("sleep-stage-user");

    // One night with the four iOS-16+ stages tagged. The analytics
    // route should surface a single Measurement-summary datapoint
    // (~480 minutes total) plus a per-stage breakdown.
    const baseDate = new Date("2026-05-09T01:00:00.000Z");
    const stages: Array<{
      stage: "IN_BED" | "CORE" | "DEEP" | "REM";
      min: number;
    }> = [
      { stage: "IN_BED", min: 480 },
      { stage: "CORE", min: 220 },
      { stage: "DEEP", min: 90 },
      { stage: "REM", min: 90 },
    ];
    let i = 0;
    for (const { stage, min } of stages) {
      await prisma.measurement.create({
        data: {
          userId: user.id,
          type: "SLEEP_DURATION",
          value: min,
          unit: "minutes",
          source: "APPLE_HEALTH",
          measuredAt: new Date(baseDate.getTime() + i * 60 * 1000),
          externalId: `uuid-night-1-${stage}`,
          sleepStage: stage,
        },
      });
      i++;
    }

    const { GET } = await import("@/app/api/analytics/route");
    // The wrapped handler reads `request.url` for logging metadata;
    // the inner handler ignores its arguments. Cast through `unknown`
    // because `apiHandler`'s narrowed type signature is the inner
    // handler's `()`, not the wrapper's `(NextRequest)`.
    const response = await (
      GET as unknown as (req: Request) => Promise<Response>
    )(new Request("http://localhost/api/analytics"));
    expect(response.status).toBe(200);
    const envelope = (await response.json()) as AnalyticsEnvelope;

    // v1.11.4 — the SLEEP_DURATION summary is now computed over per-night
    // asleep totals (CORE + DEEP + REM, excluding IN_BED/AWAKE), grouped by
    // sleep session, rather than counting raw per-stage rows. One night of
    // stage rows therefore surfaces as a single datapoint whose value is the
    // night's time asleep (220 + 90 + 90 = 400 min). The dedicated
    // `sleepStages` block below still reports the full per-stage breakdown
    // (including IN_BED) for the dashboard card.
    const summary = envelope.data.summaries.SLEEP_DURATION;
    expect(summary.count).toBe(1);
    expect(summary.latest).toBe(400);

    // Stage breakdown surfaces the per-stage minutes verbatim.
    const sleepStages = envelope.data.sleepStages;
    expect(sleepStages).not.toBeNull();
    expect(sleepStages!.nights).toBe(1);
    expect(sleepStages!.totalMinutes).toBe(880);
    expect(sleepStages!.stages.IN_BED).toBe(480);
    expect(sleepStages!.stages.CORE).toBe(220);
    expect(sleepStages!.stages.DEEP).toBe(90);
    expect(sleepStages!.stages.REM).toBe(90);
  });

  it("returns sleepStages: null when the user has no stage-tagged sleep rows", async () => {
    const prisma = getPrismaClient();
    const user = await seedSession("sleep-no-stages");

    // A single sleep row WITHOUT a stage — the legacy/manual path.
    await prisma.measurement.create({
      data: {
        userId: user.id,
        type: "SLEEP_DURATION",
        value: 420,
        unit: "minutes",
        source: "MANUAL",
        measuredAt: new Date("2026-05-09T07:00:00.000Z"),
      },
    });

    const { GET } = await import("@/app/api/analytics/route");
    // The wrapped handler reads `request.url` for logging metadata;
    // the inner handler ignores its arguments. Cast through `unknown`
    // because `apiHandler`'s narrowed type signature is the inner
    // handler's `()`, not the wrapper's `(NextRequest)`.
    const response = await (
      GET as unknown as (req: Request) => Promise<Response>
    )(new Request("http://localhost/api/analytics"));
    expect(response.status).toBe(200);
    const envelope = (await response.json()) as AnalyticsEnvelope;

    expect(envelope.data.sleepStages).toBeNull();
    // The non-stage summary path keeps working — one row, value 420.
    expect(envelope.data.summaries.SLEEP_DURATION.count).toBe(1);
    expect(envelope.data.summaries.SLEEP_DURATION.latest).toBe(420);
  });

  // v1.11.5 — the breakdown is now reconciled onto reconstructSleepNights,
  // so a midnight-spanning night stays ONE perNight bucket and a dual-source
  // night collapses to the canonical source (no double-count).
  it("keeps a midnight-spanning, dual-source night as one reconciled bucket", async () => {
    const prisma = getPrismaClient();
    const user = await seedSession("sleep-reconcile-user");

    // Contiguous overnight: 22:30 → 06:15 local (Berlin, UTC+2 in June),
    // stage ends straddling UTC midnight. WHOOP + Apple Health both report
    // it; WHOOP wins the default ladder.
    const seed = async (
      iso: string,
      stage: "CORE" | "DEEP" | "REM",
      min: number,
      source: "WHOOP" | "APPLE_HEALTH",
    ) => {
      await prisma.measurement.create({
        data: {
          userId: user.id,
          type: "SLEEP_DURATION",
          value: min,
          unit: "minutes",
          source,
          measuredAt: new Date(iso),
          externalId: `uuid-${source}-${stage}-${iso}`,
          sleepStage: stage,
        },
      });
    };
    // WHOOP — the canonical source. CORE 60 + DEEP 90 + REM 120 + CORE 195.
    await seed("2026-06-03T21:30:00.000Z", "CORE", 60, "WHOOP");
    await seed("2026-06-03T23:00:00.000Z", "DEEP", 90, "WHOOP");
    await seed("2026-06-04T01:00:00.000Z", "REM", 120, "WHOOP");
    await seed("2026-06-04T04:15:00.000Z", "CORE", 195, "WHOOP");
    // Apple Health parallel rows for the SAME night — must be dropped.
    await seed("2026-06-03T21:35:00.000Z", "CORE", 55, "APPLE_HEALTH");
    await seed("2026-06-04T01:05:00.000Z", "REM", 110, "APPLE_HEALTH");

    const { GET } = await import("@/app/api/analytics/route");
    const response = await (
      GET as unknown as (req: Request) => Promise<Response>
    )(new Request("http://localhost/api/analytics"));
    expect(response.status).toBe(200);
    const envelope = (await response.json()) as AnalyticsEnvelope;

    const sleepStages = envelope.data.sleepStages;
    expect(sleepStages).not.toBeNull();
    // ONE night, not two (no midnight split).
    expect(sleepStages!.nights).toBe(1);
    expect(sleepStages!.perNight).toHaveLength(1);
    // WHOOP only — Apple Health's parallel rows dropped (no double-count).
    expect(sleepStages!.stages.CORE).toBe(255); // 60 + 195
    expect(sleepStages!.stages.DEEP).toBe(90);
    expect(sleepStages!.stages.REM).toBe(120);
    // Total = the WHOOP night only (255 + 90 + 120 = 465), not a blend.
    expect(sleepStages!.totalMinutes).toBe(465);
  });
});
