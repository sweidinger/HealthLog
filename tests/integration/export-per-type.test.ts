/**
 * Integration regression guard for the per-type export endpoints
 * (v1.4.16 phase B7):
 *
 *   GET /api/export/measurements.csv
 *   GET /api/export/medications.csv
 *   GET /api/export/mood.csv
 *   GET /api/export/full-backup.json
 *
 * Each endpoint:
 *   1. Is gated by `requireAuth()`.
 *   2. Returns the right content-type + attachment disposition.
 *   3. Writes a `user.export.<kind>` audit-log entry.
 *   4. Round-trips real DB rows for the authenticated user only
 *      (a different user's data must NOT leak).
 *
 * The full-backup endpoint additionally has its body validated against
 * the canonical `backupPayloadSchema` so the file the user downloads
 * is the same shape `POST /api/admin/backups/upload` accepts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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

async function seedUserSession(username = "export-user") {
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

describe("GET /api/export/measurements.csv", () => {
  it("returns 401 without a session", async () => {
    const { GET } = await import("@/app/api/export/measurements.csv/route");
    const res = await GET(
      new Request("http://localhost/api/export/measurements.csv", {
        method: "GET",
      }) as Parameters<typeof GET>[0],
    );
    expect(res.status).toBe(401);
  });

  it("returns 200 + CSV body for the authed user only (no cross-tenant leak)", async () => {
    const prisma = getPrismaClient();
    const me = await seedUserSession("alice");
    const other = await prisma.user.create({
      data: {
        username: "bob",
        email: "bob@example.test",
        role: "USER",
      },
    });

    await prisma.measurement.createMany({
      data: [
        {
          userId: me.id,
          type: "WEIGHT",
          value: 80,
          unit: "kg",
          measuredAt: new Date("2026-05-01T08:00:00.000Z"),
          source: "MANUAL",
        },
        {
          userId: other.id,
          type: "WEIGHT",
          value: 999,
          unit: "kg",
          measuredAt: new Date("2026-05-01T08:00:00.000Z"),
          source: "MANUAL",
        },
      ],
    });

    const { GET } = await import("@/app/api/export/measurements.csv/route");
    const res = await GET(
      new Request("http://localhost/api/export/measurements.csv", {
        method: "GET",
      }) as Parameters<typeof GET>[0],
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/csv/);
    expect(res.headers.get("content-disposition")).toMatch(
      /attachment; filename=.*healthlog-measurements/,
    );

    const body = await res.text();
    expect(body).toContain("WEIGHT,80,kg");
    // Bob's row must never leak into Alice's export.
    expect(body).not.toContain("999");

    const audits = await prisma.auditLog.findMany({
      where: { userId: me.id, action: "user.export.measurements" },
    });
    expect(audits.length).toBe(1);
  });
});

describe("GET /api/export/medications.csv", () => {
  it("returns 401 without a session", async () => {
    const { GET } = await import("@/app/api/export/medications.csv/route");
    const res = await GET(
      new Request("http://localhost/api/export/medications.csv", {
        method: "GET",
      }) as Parameters<typeof GET>[0],
    );
    expect(res.status).toBe(401);
  });

  it("includes intake history when intake=true (default)", async () => {
    const prisma = getPrismaClient();
    const me = await seedUserSession("med-user");
    const med = await prisma.medication.create({
      data: {
        userId: me.id,
        name: "Aspirin",
        dose: "100mg",
        active: true,
      },
    });
    await prisma.medicationIntakeEvent.create({
      data: {
        userId: me.id,
        medicationId: med.id,
        scheduledFor: new Date("2026-05-01T08:00:00.000Z"),
        takenAt: new Date("2026-05-01T08:05:00.000Z"),
        skipped: false,
        // IntakeSource enum values: WEB, API, REMINDER, IMPORT
        source: "WEB",
      },
    });

    const { GET } = await import("@/app/api/export/medications.csv/route");
    const res = await GET(
      new Request("http://localhost/api/export/medications.csv", {
        method: "GET",
      }) as Parameters<typeof GET>[0],
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Aspirin");
    expect(body).toContain("# Intake history");
    expect(body).toContain("scheduledFor");

    const audits = await prisma.auditLog.findMany({
      where: { userId: me.id, action: "user.export.medications" },
    });
    expect(audits.length).toBe(1);
  });

  it("omits intake history when intake=false", async () => {
    const prisma = getPrismaClient();
    const me = await seedUserSession("med-user-2");
    await prisma.medication.create({
      data: {
        userId: me.id,
        name: "Ibuprofen",
        dose: "200mg",
        active: true,
      },
    });

    const { GET } = await import("@/app/api/export/medications.csv/route");
    const res = await GET(
      new Request("http://localhost/api/export/medications.csv?intake=false", {
        method: "GET",
      }) as Parameters<typeof GET>[0],
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Ibuprofen");
    expect(body).not.toContain("# Intake history");
  });
});

describe("GET /api/export/mood.csv", () => {
  it("returns 401 without a session", async () => {
    const { GET } = await import("@/app/api/export/mood.csv/route");
    const res = await GET(
      new Request("http://localhost/api/export/mood.csv", {
        method: "GET",
      }) as Parameters<typeof GET>[0],
    );
    expect(res.status).toBe(401);
  });

  it("returns the user's mood entries as CSV", async () => {
    const prisma = getPrismaClient();
    const me = await seedUserSession("mood-user");
    await prisma.moodEntry.create({
      data: {
        userId: me.id,
        date: "2026-05-01",
        mood: "good",
        score: 4,
        // MoodEntry.source is a plain string column; "WEB" matches the
        // values the rest of the suite uses.
        source: "WEB",
        moodLoggedAt: new Date("2026-05-01T20:00:00.000Z"),
      },
    });

    const { GET } = await import("@/app/api/export/mood.csv/route");
    const res = await GET(
      new Request("http://localhost/api/export/mood.csv", {
        method: "GET",
      }) as Parameters<typeof GET>[0],
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/csv/);
    const body = await res.text();
    expect(body).toContain("good");
    expect(body).toContain("2026-05-01");

    const audits = await prisma.auditLog.findMany({
      where: { userId: me.id, action: "user.export.mood" },
    });
    expect(audits.length).toBe(1);
  });
});

describe("GET /api/export/full-backup.json", () => {
  it("returns 401 without a session", async () => {
    const { GET } = await import("@/app/api/export/full-backup.json/route");
    const res = await GET(
      new Request("http://localhost/api/export/full-backup.json", {
        method: "GET",
      }) as Parameters<typeof GET>[0],
    );
    expect(res.status).toBe(401);
  });

  it("returns a JSON blob that round-trips through `parseBackupPayload`", async () => {
    const { parseBackupPayload } = await import("@/lib/validations/backup");
    const prisma = getPrismaClient();
    const me = await seedUserSession("backup-user");

    await prisma.measurement.create({
      data: {
        userId: me.id,
        type: "WEIGHT",
        value: 75,
        unit: "kg",
        measuredAt: new Date("2026-05-01T08:00:00.000Z"),
        source: "MANUAL",
      },
    });
    await prisma.moodEntry.create({
      data: {
        userId: me.id,
        date: "2026-05-01",
        mood: "great",
        score: 5,
        source: "WEB",
        moodLoggedAt: new Date("2026-05-01T20:00:00.000Z"),
      },
    });

    const { GET } = await import("@/app/api/export/full-backup.json/route");
    const res = await GET(
      new Request("http://localhost/api/export/full-backup.json", {
        method: "GET",
      }) as Parameters<typeof GET>[0],
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(res.headers.get("content-disposition")).toMatch(
      /attachment; filename=.*healthlog-backup/,
    );

    const text = await res.text();
    const parsed = parseBackupPayload(text);
    expect(parsed.userId).toBe(me.id);
    expect(parsed.measurements.length).toBe(1);
    expect(parsed.moodEntries.length).toBe(1);

    const audits = await prisma.auditLog.findMany({
      where: { userId: me.id, action: "user.export.full-backup" },
    });
    expect(audits.length).toBe(1);
  });
});
