/**
 * v1.4.20 phase B5 — integration coverage for the analytics route's
 * Personal Health Score field.
 *
 * Seeds a deterministic mix of weight + mood + medication-intake
 * fixtures alongside the existing BP-in-target seed, then asserts the
 * route returns a `healthScore` envelope whose band corresponds to the
 * synthetic-data shape.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

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
    healthScore: {
      score: number;
      band: "green" | "yellow" | "red";
      components: {
        bp: { value: number | null; weight: number };
        weight: { value: number | null; weight: number };
        mood: { value: number | null; weight: number };
        compliance: { value: number | null; weight: number };
      };
      delta: number | null;
    } | null;
  } | null;
  error?: string | null;
}

async function seedSession(username: string) {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username,
      email: `${username}@example.test`,
      role: "USER",
      heightCm: 178,
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

describe("GET /api/analytics — Health Score", () => {
  it("returns a green-band score for a strong-positive synthetic shape", async () => {
    const prisma = getPrismaClient();
    const user = await seedSession("hs-strong");

    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;

    // ── BP: 18 in-target paired readings + 2 out → ≈ 90 % ──
    for (let i = 0; i < 20; i++) {
      const at = new Date(now - i * DAY);
      const inTarget = i >= 2; // 18 in-target, 2 out
      await prisma.measurement.create({
        data: {
          userId: user.id,
          type: "BLOOD_PRESSURE_SYS",
          value: inTarget ? 120 : 145,
          unit: "mmHg",
          measuredAt: at,
        },
      });
      await prisma.measurement.create({
        data: {
          userId: user.id,
          type: "BLOOD_PRESSURE_DIA",
          value: inTarget ? 78 : 95,
          unit: "mmHg",
          measuredAt: at,
        },
      });
    }

    // ── Weight: closing toward BMI-22 target (≈ 69.7 kg for 178 cm) ──
    for (let i = 0; i < 10; i++) {
      await prisma.measurement.create({
        data: {
          userId: user.id,
          type: "WEIGHT",
          value: 72 - i * 0.2, // 72.0 -> 70.2 across 10 days
          unit: "kg",
          measuredAt: new Date(now - (10 - i) * DAY),
        },
      });
    }

    // ── Mood: stable high score ──
    for (let i = 0; i < 10; i++) {
      const at = new Date(now - i * DAY);
      const ymd = at.toISOString().slice(0, 10);
      await prisma.moodEntry.create({
        data: {
          userId: user.id,
          score: i % 2 === 0 ? 5 : 4,
          mood: "GUT",
          source: "WEB",
          date: ymd,
          moodLoggedAt: at,
        },
      });
    }

    // ── Medication: one med, perfect compliance ──
    const med = await prisma.medication.create({
      data: {
        userId: user.id,
        name: "Ramipril",
        dose: "5mg",
        active: true,
        createdAt: new Date(now - 60 * DAY),
        schedules: {
          create: [{ windowStart: "08:00", windowEnd: "10:00" }],
        },
      },
    });
    for (let i = 0; i < 30; i++) {
      const scheduledFor = new Date(now - i * DAY);
      await prisma.medicationIntakeEvent.create({
        data: {
          userId: user.id,
          medicationId: med.id,
          scheduledFor,
          takenAt: scheduledFor,
          skipped: false,
        },
      });
    }

    const { GET } = await import("@/app/api/analytics/route");
    const res = await (GET as (req: Request) => Promise<Response>)(
      new Request("http://localhost/api/analytics"),
    );
    expect(res.status).toBe(200);
    const env = (await res.json()) as AnalyticsEnvelope;
    expect(env.data).not.toBeNull();
    expect(env.data!.healthScore).not.toBeNull();
    const hs = env.data!.healthScore!;
    expect(hs.band).toBe("green");
    expect(hs.score).toBeGreaterThanOrEqual(75);
    expect(hs.components.bp.value).not.toBeNull();
    expect(hs.components.compliance.value).toBeGreaterThanOrEqual(95);
  });

  it("scores the BP pillar from all-time history even with no readings in the trailing 30 days", async () => {
    // Regression pin: the BD-Zielbereich tile headline reads the trailing
    // 30 days, but the Health-Score BP pillar must read the all-time
    // window. A prior change fed the 30-day value into the score, so an
    // account whose BP readings predate the trailing month lost the
    // 0.30-weight BP pillar entirely and rendered "no rating" despite
    // having BP data. This pins the all-time feed.
    const prisma = getPrismaClient();
    const user = await seedSession("hs-bp-old");

    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;

    // 20 paired in-target readings, all ~60–80 days ago (outside the
    // trailing-30-day window the tile headline uses, inside the all-time
    // window the score should use).
    for (let i = 0; i < 20; i++) {
      const at = new Date(now - (60 + i) * DAY);
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
          value: 78,
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
    const env = (await res.json()) as AnalyticsEnvelope & {
      data: { bpInTargetPct: number | null } | null;
    };
    expect(env.data!.healthScore).not.toBeNull();
    const hs = env.data!.healthScore!;
    // The BP pillar must score from the all-time window…
    expect(hs.components.bp.value).not.toBeNull();
    expect(hs.components.bp.value).toBeGreaterThanOrEqual(90);
    expect(hs.components.bp.weight).toBeGreaterThan(0);
    // …while the tile headline stays scoped to the trailing 30 days
    // (no readings there → null), proving the two are decoupled.
    expect(env.data!.bpInTargetPct).toBeNull();
  });

  it("returns null healthScore for a user with no data", async () => {
    await seedSession("hs-empty");
    const { GET } = await import("@/app/api/analytics/route");
    const res = await (GET as (req: Request) => Promise<Response>)(
      new Request("http://localhost/api/analytics"),
    );
    expect(res.status).toBe(200);
    const env = (await res.json()) as AnalyticsEnvelope;
    expect(env.data!.healthScore).toBeNull();
  });

  it("redistributes weights when only compliance is present", async () => {
    const prisma = getPrismaClient();
    const user = await seedSession("hs-compliance-only");

    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    const med = await prisma.medication.create({
      data: {
        userId: user.id,
        name: "Vitamin D",
        dose: "2000 IU",
        active: true,
        createdAt: new Date(now - 60 * DAY),
        schedules: {
          create: [{ windowStart: "08:00", windowEnd: "10:00" }],
        },
      },
    });
    for (let i = 0; i < 30; i++) {
      const scheduledFor = new Date(now - i * DAY);
      await prisma.medicationIntakeEvent.create({
        data: {
          userId: user.id,
          medicationId: med.id,
          scheduledFor,
          takenAt: scheduledFor,
          skipped: false,
        },
      });
    }

    const { GET } = await import("@/app/api/analytics/route");
    const res = await (GET as (req: Request) => Promise<Response>)(
      new Request("http://localhost/api/analytics"),
    );
    const env = (await res.json()) as AnalyticsEnvelope;
    const hs = env.data!.healthScore!;
    expect(hs).not.toBeNull();
    expect(hs.components.bp.value).toBeNull();
    expect(hs.components.weight.value).toBeNull();
    expect(hs.components.mood.value).toBeNull();
    expect(hs.components.compliance.value).not.toBeNull();
    expect(hs.components.compliance.weight).toBeCloseTo(1, 5);
  });
});
