import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    auditLog: { findFirst: vi.fn(), create: vi.fn() },
    medication: { findMany: vi.fn() },
    medicationIntakeEvent: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/ai/provider", () => ({
  resolveProvider: vi.fn(),
}));

vi.mock("@/lib/insights/memory", () => ({
  getPreviousInsightContext: vi.fn().mockResolvedValue(null),
  formatPreviousContextForPrompt: vi.fn().mockReturnValue(""),
}));

vi.mock("@/lib/medication-category", () => ({
  getMedicationCategories: vi.fn(),
}));

import { prisma } from "@/lib/db";
import { resolveProvider } from "@/lib/ai/provider";
import { getMedicationCategories } from "@/lib/medication-category";
import { generateMedicationComplianceStatusForUser } from "../medication-compliance-status";

const dayMs = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getMedicationCategories).mockResolvedValue({});
});

describe("generateMedicationComplianceStatusForUser — v1.4.6 bucketed payload", () => {
  it("emits {daily, monthly} compliance series per medication spanning 3 years", async () => {
    const now = new Date();
    const medication = {
      id: "med-1",
      name: "TestMed",
      dose: "5mg",
      active: true,
      createdAt: new Date(now.getTime() - 1100 * dayMs),
      schedules: [{ id: "s1", time: "08:00" }],
    };

    const events: Array<{
      medicationId: string;
      scheduledFor: Date;
      takenAt: Date | null;
      skipped: boolean;
    }> = [];
    for (let day = 0; day < 1000; day++) {
      const scheduledFor = new Date(now.getTime() - day * dayMs);
      events.push({
        medicationId: "med-1",
        scheduledFor,
        takenAt: day % 3 === 0 ? null : scheduledFor,
        skipped: false,
      });
    }

    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.medication.findMany).mockResolvedValue([
      medication,
    ] as never);
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
      events as never,
    );
    vi.mocked(prisma.auditLog.create).mockResolvedValue({
      createdAt: new Date(),
    } as never);

    const captured: { userPrompt: string | null } = { userPrompt: null };
    vi.mocked(resolveProvider).mockResolvedValue({
      type: "anthropic",
      generateCompletion: vi.fn(async (args: { userPrompt: string }) => {
        captured.userPrompt = args.userPrompt;
        return {
          content: '{"summary":"OK","medications":[]}',
          model: "x",
          tokensUsed: 1,
        };
      }),
    } as never);

    await generateMedicationComplianceStatusForUser("user-1", {
      locale: "en",
    });

    const match = captured.userPrompt!.match(/\{[\s\S]*\}/);
    const snapshot = JSON.parse(match![0]);

    expect(snapshot.medications).toBeInstanceOf(Array);
    expect(snapshot.medications.length).toBe(1);
    const dailySeries = snapshot.medications[0].dailySeries;
    expect(dailySeries).toHaveProperty("daily");
    expect(dailySeries).toHaveProperty("monthly");
    expect(dailySeries.daily.length).toBeGreaterThan(0);
    expect(dailySeries.monthly.length).toBeGreaterThan(0);
    expect(dailySeries.daily[0]).toHaveProperty("dayOffset");
    expect(dailySeries.daily[0]).toHaveProperty("value");
    expect(dailySeries.daily[0]).toHaveProperty("n");
    expect(dailySeries.monthly[0]).toHaveProperty("monthOffset");
    expect(dailySeries.monthly[0]).toHaveProperty("value");
    expect(dailySeries.monthly[0]).toHaveProperty("n");
  });
});
