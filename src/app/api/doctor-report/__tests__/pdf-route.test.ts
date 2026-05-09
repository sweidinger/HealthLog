import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// --- Mocks must come before importing the route. ---

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { findMany: vi.fn() },
    medication: { findMany: vi.fn() },
    medicationIntakeEvent: { findMany: vi.fn() },
    moodEntry: { findMany: vi.fn() },
    user: { findUnique: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn(),
}));

vi.mock("@/lib/geo", () => ({
  lookupIpLocation: vi.fn(),
}));

vi.mock("@/lib/analytics/effective-range", () => ({
  getEffectiveRange: vi.fn(() => ({ range: null })),
}));

vi.mock("@/lib/logging/transports", () => ({
  emitIfSampled: vi.fn(),
}));

import { POST } from "../pdf/route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { auditLog } from "@/lib/auth/audit";

function makeRequest(
  body?: Record<string, unknown>,
  headers: Record<string, string> = {},
): NextRequest {
  const baseHeaders: Record<string, string> = {
    "content-type": "application/json",
    ...headers,
  };
  return new NextRequest("http://localhost/api/doctor-report/pdf", {
    method: "POST",
    headers: baseHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3600_000) },
  user: { id: "user-1", role: "USER" as const },
};

function setEmptyDataMocks() {
  vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.medication.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
    [] as never,
  );
  vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    username: "marc",
    dateOfBirth: null,
    gender: null,
    heightCm: null,
    glucoseUnit: null,
    thresholdsJson: null,
  } as never);
}

describe("POST /api/doctor-report/pdf", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);

    const res = await POST(makeRequest({ days: 90 }));
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("Not authenticated");
  });

  it("returns 429 when rate limit exceeded", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 3600_000,
    });

    const res = await POST(makeRequest({ days: 90 }));
    expect(res.status).toBe(429);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/Maximum/);
  });

  it("returns 200 application/pdf with PDF bytes on happy path", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      remaining: 9,
      resetAt: Date.now() + 3600_000,
    });
    vi.mocked(auditLog).mockResolvedValue(undefined as never);
    setEmptyDataMocks();

    const res = await POST(
      makeRequest({ days: 30, locale: "de" }, { "accept-language": "de-DE" }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const disposition = res.headers.get("content-disposition") ?? "";
    expect(disposition).toMatch(/attachment;\s*filename="healthlog-report-/);
    expect(disposition).toMatch(/\.pdf"/);

    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.byteLength).toBeGreaterThan(1024);
    expect(buf.slice(0, 5).toString("utf8")).toBe("%PDF-");

    expect(auditLog).toHaveBeenCalledWith(
      "doctor-report.pdf.generate",
      expect.objectContaining({
        userId: "user-1",
        details: expect.objectContaining({ days: 30, locale: "de" }),
      }),
    );
  });

  it("falls back to default days=90 when body omits it", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      remaining: 9,
      resetAt: Date.now() + 3600_000,
    });
    vi.mocked(auditLog).mockResolvedValue(undefined as never);
    setEmptyDataMocks();

    const res = await POST(makeRequest({}));
    expect(res.status).toBe(200);
    expect(auditLog).toHaveBeenCalledWith(
      "doctor-report.pdf.generate",
      expect.objectContaining({
        details: expect.objectContaining({ days: 90 }),
      }),
    );
  });

  it("uses Accept-Language to pick the locale when body omits it", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      remaining: 9,
      resetAt: Date.now() + 3600_000,
    });
    vi.mocked(auditLog).mockResolvedValue(undefined as never);
    setEmptyDataMocks();

    const res = await POST(
      makeRequest({ days: 7 }, { "accept-language": "en-US,en;q=0.9" }),
    );
    expect(res.status).toBe(200);
    expect(auditLog).toHaveBeenCalledWith(
      "doctor-report.pdf.generate",
      expect.objectContaining({
        details: expect.objectContaining({ locale: "en" }),
      }),
    );
  });

  // ── v1.4.15 phase B6 ── configurable date range + practice name.

  it("accepts an explicit startDate / endDate range in the body", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      remaining: 9,
      resetAt: Date.now() + 3600_000,
    });
    vi.mocked(auditLog).mockResolvedValue(undefined as never);
    setEmptyDataMocks();

    const startDate = "2026-01-01T00:00:00.000Z";
    const endDate = "2026-04-01T00:00:00.000Z";
    const res = await POST(makeRequest({ startDate, endDate }));
    expect(res.status).toBe(200);
    expect(prisma.measurement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          measuredAt: { gte: new Date(startDate), lte: new Date(endDate) },
        }),
      }),
    );
    expect(auditLog).toHaveBeenCalledWith(
      "doctor-report.pdf.generate",
      expect.objectContaining({
        details: expect.objectContaining({ startDate, endDate }),
      }),
    );
  });

  it("falls back when range is invalid (end < start)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      remaining: 9,
      resetAt: Date.now() + 3600_000,
    });
    vi.mocked(auditLog).mockResolvedValue(undefined as never);
    setEmptyDataMocks();

    const res = await POST(
      makeRequest({
        startDate: "2026-04-01T00:00:00.000Z",
        endDate: "2026-01-01T00:00:00.000Z",
      }),
    );
    expect(res.status).toBe(200);
    // Falls back to days=90.
    expect(auditLog).toHaveBeenCalledWith(
      "doctor-report.pdf.generate",
      expect.objectContaining({
        details: expect.objectContaining({ days: 90 }),
      }),
    );
  });

});
