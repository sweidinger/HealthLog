import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    auditLog: { findFirst: vi.fn(), create: vi.fn() },
    measurement: { findMany: vi.fn() },
    moodEntry: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/ai/provider", () => ({
  resolveProvider: vi.fn(),
}));

vi.mock("@/lib/insights/memory", () => ({
  getPreviousInsightContext: vi.fn().mockResolvedValue(null),
  formatPreviousContextForPrompt: vi.fn().mockReturnValue(""),
}));

import { prisma } from "@/lib/db";
import { resolveProvider } from "@/lib/ai/provider";
import { generatePulseStatusForUser } from "../pulse-status";

const dayMs = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.resetAllMocks();
});

describe("generatePulseStatusForUser — v1.4.6 bucketed payload", () => {
  it("emits {daily, monthly} pulse series with dayOffset/monthOffset/value/n", async () => {
    const now = new Date();
    const records: Array<{ value: number; measuredAt: Date }> = [];
    for (let day = 0; day < 1000; day++) {
      records.push({
        value: 70 + (day % 8),
        measuredAt: new Date(now.getTime() - day * dayMs),
      });
    }

    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dateOfBirth: null,
      gender: null,
    } as never);
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue(records as never);
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.auditLog.create).mockResolvedValue({
      createdAt: new Date(),
    } as never);

    const captured: { userPrompt: string | null } = { userPrompt: null };
    vi.mocked(resolveProvider).mockResolvedValue({
      type: "anthropic",
      generateCompletion: vi.fn(async (args: { userPrompt: string }) => {
        captured.userPrompt = args.userPrompt;
        return {
          content: '{"summary":"OK"}',
          model: "x",
          tokensUsed: 1,
        };
      }),
    } as never);

    await generatePulseStatusForUser("user-1", { locale: "en" });

    const match = captured.userPrompt!.match(/\{[\s\S]*\}/);
    const snapshot = JSON.parse(match![0]);

    const pulse = snapshot.pulse.series;
    expect(pulse).toHaveProperty("daily");
    expect(pulse).toHaveProperty("monthly");
    expect(pulse.daily.length).toBeGreaterThan(0);
    expect(pulse.monthly.length).toBeGreaterThan(0);
    expect(pulse.daily[0]).toHaveProperty("dayOffset");
    expect(pulse.daily[0]).toHaveProperty("value");
    expect(pulse.daily[0]).toHaveProperty("n");
    expect(pulse.monthly[0]).toHaveProperty("monthOffset");
    expect(pulse.monthly[0]).toHaveProperty("value");
    expect(pulse.monthly[0]).toHaveProperty("n");
  });
});
