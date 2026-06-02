import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    auditLog: { findFirst: vi.fn(), create: vi.fn() },
    measurement: { findMany: vi.fn(), count: vi.fn() },
    measurementRollup: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/insights/status-provider", () => ({
  runStatusCompletion: vi.fn(),
}));

vi.mock("@/lib/insights/memory", () => ({
  getPreviousInsightContext: vi.fn().mockResolvedValue(null),
  formatPreviousContextForPrompt: vi.fn().mockReturnValue(""),
}));

import { prisma } from "@/lib/db";
import { runStatusCompletion } from "@/lib/insights/status-provider";
import { generateMetricStatus } from "../metric-status";
import {
  getMetricArchetypeSystemPrompt,
  getMetricArchetypeUserPrompt,
} from "@/lib/ai/prompts/metric-archetypes";
import {
  getMetricStatusMeta,
  metricStatusScope,
  METRIC_STATUS_IDS,
} from "../metric-status-registry";

const dayMs = 24 * 60 * 60 * 1000;

function stubCompletion(
  content: string,
  capture?: { systemPrompt: string | null; userPrompt: string | null },
) {
  vi.mocked(runStatusCompletion).mockImplementation(
    async (args: { systemPrompt: string; userPrompt: string }) => {
      if (capture) {
        capture.systemPrompt = args.systemPrompt;
        capture.userPrompt = args.userPrompt;
      }
      return {
        kind: "ok",
        content,
        providerType: "anthropic",
        model: "x",
        tokensUsed: 1,
      } as never;
    },
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.measurementRollup.findMany).mockResolvedValue([] as never);
});

describe("metric-status registry", () => {
  it("excludes the seven specialised metrics from the generic set", () => {
    for (const excluded of [
      "WEIGHT",
      "BLOOD_PRESSURE_SYS",
      "BLOOD_PRESSURE_DIA",
      "PULSE",
      "BMI",
      "MOOD",
      "MEDICATION",
    ]) {
      expect(METRIC_STATUS_IDS).not.toContain(excluded);
    }
  });

  it("scope id carries the metric: prefix and (with -status suffix) keeps the eviction substring", () => {
    expect(metricStatusScope("RESTING_HEART_RATE")).toBe(
      "metric:RESTING_HEART_RATE",
    );
    // The cache action appends `-status.<locale>`; the eviction sweep
    // matches on the `-status.` substring, so a generic scope is swept too.
    expect(
      `insights.${metricStatusScope("SLEEP_DURATION")}-status.de`,
    ).toContain("-status.");
  });

  it("maps STEPS / ACTIVE_ENERGY ids onto their divergent MeasurementType", () => {
    expect(getMetricStatusMeta("STEPS")?.measurementType).toBe(
      "ACTIVITY_STEPS",
    );
    expect(getMetricStatusMeta("ACTIVE_ENERGY")?.measurementType).toBe(
      "ACTIVE_ENERGY_BURNED",
    );
  });
});

describe("archetype prompt templates", () => {
  it("injects the metric metadata + normal range into the system prompt", () => {
    const meta = getMetricStatusMeta("OXYGEN_SATURATION")!;
    const sys = getMetricArchetypeSystemPrompt(meta, "en");
    expect(sys).toContain("Blood oxygen");
    expect(sys).toContain("95");
    expect(sys).toContain("PHYSIOLOGICAL VITAL");
  });

  it("uses the dedicated sleep archetype for SLEEP_DURATION", () => {
    const meta = getMetricStatusMeta("SLEEP_DURATION")!;
    const sys = getMetricArchetypeSystemPrompt(meta, "en");
    expect(sys).toContain("SLEEP");
    expect(getMetricArchetypeUserPrompt(meta, "{}", "2026-06-02", "en")).toContain(
      "sleep duration",
    );
  });
});

describe("generateMetricStatus — empty-data guard", () => {
  it("returns insufficient WITHOUT calling the provider when the metric has no data", async () => {
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.measurement.count).mockResolvedValue(0 as never);

    const result = await generateMetricStatus({
      metric: "RESTING_HEART_RATE",
      userId: "user-1",
      locale: "en",
      readOnly: true,
    });

    expect(result.insufficient).toBe(true);
    expect(result.text).toBeNull();
    expect(runStatusCompletion).not.toHaveBeenCalled();
    // No raw read either — the guard short-circuits before the gather.
    expect(prisma.measurement.findMany).not.toHaveBeenCalled();
  });
});

describe("generateMetricStatus — generation path", () => {
  it("builds a graded snapshot, runs the archetype completion, and persists", async () => {
    const now = new Date();
    const records: Array<{ value: number; measuredAt: Date }> = [];
    for (let day = 0; day < 400; day++) {
      records.push({
        value: 55 + (day % 6),
        measuredAt: new Date(now.getTime() - day * dayMs),
      });
    }

    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.measurement.count).mockResolvedValue(400 as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue(records as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dateOfBirth: null,
      gender: null,
    } as never);
    vi.mocked(prisma.auditLog.create).mockResolvedValue({
      createdAt: now,
    } as never);

    const captured = { systemPrompt: null, userPrompt: null } as {
      systemPrompt: string | null;
      userPrompt: string | null;
    };
    stubCompletion('{"summary":"Your resting heart rate is steady."}', captured);

    const result = await generateMetricStatus({
      metric: "RESTING_HEART_RATE",
      userId: "user-1",
      locale: "en",
    });

    expect(runStatusCompletion).toHaveBeenCalledTimes(1);
    expect(result.text).toBe("Your resting heart rate is steady.");
    expect(result.cached).toBe(false);
    expect(result.hasProvider).toBe(true);

    // The snapshot embeds the graded series, not a raw daily array.
    const match = captured.userPrompt!.match(/\{[\s\S]*\}/);
    const snapshot = JSON.parse(match![0]);
    expect(snapshot.RESTING_HEART_RATE.series).toHaveProperty("recent");
    expect(snapshot.metric.unit).toBe("bpm");

    // Persisted under the generic scope cache action.
    const createCall = vi.mocked(prisma.auditLog.create).mock.calls[0][0] as {
      data: { action: string; details: string };
    };
    expect(createCall.data.action).toBe(
      "insights.metric:RESTING_HEART_RATE-status.en",
    );
  });

  it("strips chart tokens from the persisted text", async () => {
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.measurement.count).mockResolvedValue(3 as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { value: 58, measuredAt: new Date() },
    ] as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dateOfBirth: null,
      gender: null,
    } as never);
    vi.mocked(prisma.auditLog.create).mockResolvedValue({
      createdAt: new Date(),
    } as never);

    stubCompletion(
      '{"summary":"Steady. metric:RESTING_HEART_RATE Good baseline."}',
    );

    const result = await generateMetricStatus({
      metric: "RESTING_HEART_RATE",
      userId: "user-1",
      locale: "en",
    });

    expect(result.text).not.toContain("metric:");
    expect(result.text).toContain("Steady.");
  });
});
