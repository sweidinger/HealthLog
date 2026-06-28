import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    biomarker: { findFirst: vi.fn() },
    labResult: { findMany: vi.fn(), count: vi.fn() },
    auditLog: { findFirst: vi.fn(), create: vi.fn() },
  },
}));

vi.mock("@/lib/insights/status-provider", () => ({
  runStatusCompletion: vi.fn(),
  // Consent never blocks in these fixtures — the gate has its own tests.
  statusConsentBlocksGeneration: vi.fn(async () => false),
}));

import { prisma } from "@/lib/db";
import { runStatusCompletion } from "@/lib/insights/status-provider";
import { hashInsightSnapshot } from "@/lib/insights/snapshot-hash";
import { PROMPT_VERSION } from "@/lib/ai/prompts/base-system";
import { toBerlinDayKey } from "@/lib/tz/resolver";
import {
  generateBiomarkerStatus,
  biomarkerStatusScope,
} from "../biomarker-status";

const MARKER = {
  id: "bm-1",
  name: "LDL Cholesterol",
  unit: "mg/dL",
  lowerBound: 0,
  upperBound: 100,
};

const TAKEN_AT = new Date("2026-06-20T08:00:00.000Z");

function stubCompletion(content: string, capture?: { userPrompt: string }) {
  vi.mocked(runStatusCompletion).mockImplementation(
    async (args: { userPrompt: string }) => {
      if (capture) capture.userPrompt = args.userPrompt;
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

/** The fingerprint the generator computes for a single-reading marker. */
function inputHashFor(reading: {
  id: string;
  value: number;
  takenAt: Date;
}): string {
  return hashInsightSnapshot({
    scope: biomarkerStatusScope(MARKER.id),
    locale: "en",
    promptVersion: PROMPT_VERSION,
    count: 1,
    bounds: { lower: MARKER.lowerBound, upper: MARKER.upperBound },
    latest: {
      id: reading.id,
      takenAt: reading.takenAt.toISOString(),
      value: reading.value,
    },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.biomarker.findFirst).mockResolvedValue(MARKER as never);
  vi.mocked(prisma.auditLog.create).mockResolvedValue({
    createdAt: new Date("2026-06-20T09:00:00.000Z"),
  } as never);
});

describe("generateBiomarkerStatus — empty-data guard", () => {
  it("returns insufficient WITHOUT calling the provider for a marker with no numeric readings", async () => {
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.labResult.findMany).mockResolvedValue([] as never);

    const result = await generateBiomarkerStatus({
      biomarkerId: MARKER.id,
      userId: "u1",
      locale: "en",
      readOnly: true,
    });

    expect(result.insufficient).toBe(true);
    expect(result.text).toBeNull();
    expect(runStatusCompletion).not.toHaveBeenCalled();
    expect(prisma.labResult.count).not.toHaveBeenCalled();
  });

  it("returns insufficient for an unknown / cross-user marker", async () => {
    vi.mocked(prisma.biomarker.findFirst).mockResolvedValue(null as never);

    const result = await generateBiomarkerStatus({
      biomarkerId: "nope",
      userId: "u1",
      locale: "en",
      readOnly: true,
    });

    expect(result.insufficient).toBe(true);
    expect(runStatusCompletion).not.toHaveBeenCalled();
  });
});

describe("generateBiomarkerStatus — cache read", () => {
  it("serves today's cached text without calling the provider", async () => {
    const todayKey = toBerlinDayKey(new Date());
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue({
      createdAt: new Date(),
      details: JSON.stringify({
        dateKey: todayKey,
        locale: "en",
        text: "Your LDL is steady.",
        model: "x",
      }),
    } as never);

    const result = await generateBiomarkerStatus({
      biomarkerId: MARKER.id,
      userId: "u1",
      locale: "en",
    });

    expect(result.cached).toBe(true);
    expect(result.text).toBe("Your LDL is steady.");
    expect(runStatusCompletion).not.toHaveBeenCalled();
    // Cache hit short-circuits before the reading read.
    expect(prisma.labResult.findMany).not.toHaveBeenCalled();
  });
});

describe("generateBiomarkerStatus — generation path", () => {
  it("builds a snapshot, runs the completion, and persists with an inputHash", async () => {
    const reading = { id: "r1", value: 95, takenAt: TAKEN_AT };
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.labResult.findMany).mockResolvedValue([reading] as never);
    vi.mocked(prisma.labResult.count).mockResolvedValue(1 as never);

    const capture = { userPrompt: "" };
    stubCompletion(
      '{"summary":"Your LDL sits inside the reference range."}',
      capture,
    );

    const result = await generateBiomarkerStatus({
      biomarkerId: MARKER.id,
      userId: "u1",
      locale: "en",
    });

    expect(runStatusCompletion).toHaveBeenCalledTimes(1);
    expect(result.text).toBe("Your LDL sits inside the reference range.");
    expect(result.cached).toBe(false);
    expect(result.hasProvider).toBe(true);

    // The snapshot carries the marker metadata + the latest reading.
    const match = capture.userPrompt.match(/\{[\s\S]*\}/);
    const snapshot = JSON.parse(match![0]);
    expect(snapshot.marker.name).toBe("LDL Cholesterol");
    expect(snapshot.marker.unit).toBe("mg/dL");
    expect(snapshot.latest.value).toBe(95);

    // Persisted under the biomarker scope cache action, carrying the inputHash.
    const createCall = vi
      .mocked(prisma.auditLog.create)
      .mock.calls.at(-1)![0] as {
      data: { action: string; details: string };
    };
    expect(createCall.data.action).toBe("insights.biomarker:bm-1-status.en");
    const persisted = JSON.parse(createCall.data.details);
    expect(persisted.inputHash).toBe(inputHashFor(reading));
  });
});

describe("generateBiomarkerStatus — input gate (regenerate only on a new reading)", () => {
  it("re-stamps the cached text WITHOUT calling the provider when the latest reading is unchanged", async () => {
    const reading = { id: "r1", value: 95, takenAt: TAKEN_AT };
    // A prior assessment from an earlier day whose inputHash matches the
    // current latest reading — readFreshStatusText misses on the day key, but
    // the input gate matches the fingerprint.
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue({
      createdAt: new Date(),
      details: JSON.stringify({
        dateKey: "2000-01-01",
        locale: "en",
        text: "Stable LDL from a previous reading.",
        model: "x",
        inputHash: inputHashFor(reading),
      }),
    } as never);
    vi.mocked(prisma.labResult.findMany).mockResolvedValue([reading] as never);
    vi.mocked(prisma.labResult.count).mockResolvedValue(1 as never);

    const result = await generateBiomarkerStatus({
      biomarkerId: MARKER.id,
      userId: "u1",
      locale: "en",
    });

    expect(runStatusCompletion).not.toHaveBeenCalled();
    expect(result.cached).toBe(true);
    expect(result.text).toBe("Stable LDL from a previous reading.");
  });

  it("regenerates when a new reading lands (inputHash differs)", async () => {
    const oldReading = { id: "r1", value: 95, takenAt: TAKEN_AT };
    const newReading = {
      id: "r2",
      value: 130,
      takenAt: new Date("2026-06-25T08:00:00.000Z"),
    };
    // The cached row's inputHash is for the OLD reading; the live latest is the
    // new reading, so the fingerprint differs and the gate misses.
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue({
      createdAt: new Date(),
      details: JSON.stringify({
        dateKey: "2000-01-01",
        locale: "en",
        text: "Stale assessment.",
        model: "x",
        inputHash: inputHashFor(oldReading),
      }),
    } as never);
    vi.mocked(prisma.labResult.findMany).mockResolvedValue([
      newReading,
    ] as never);
    vi.mocked(prisma.labResult.count).mockResolvedValue(1 as never);

    stubCompletion('{"summary":"LDL rose above the reference range."}');

    const result = await generateBiomarkerStatus({
      biomarkerId: MARKER.id,
      userId: "u1",
      locale: "en",
    });

    expect(runStatusCompletion).toHaveBeenCalledTimes(1);
    expect(result.text).toBe("LDL rose above the reference range.");
    expect(result.cached).toBe(false);
  });
});
