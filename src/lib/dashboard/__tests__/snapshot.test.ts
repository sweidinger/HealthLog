/**
 * v1.7.0 W6 — unit tests for `buildDashboardSnapshot`.
 *
 * The builder is tested in isolation with every sub-helper mocked so
 * the assertions pin the assembly contract without a live DB / LLM:
 *   - every above-the-fold tile field is present in the envelope;
 *   - the two-phase contract: `extras` is null on a rollup-coverage
 *     miss, populated when warm;
 *   - the briefingState matrix (ready / preparing / disabled /
 *     no-provider) plus the stale-briefing delivery contract;
 *   - NO LLM client is reachable from the builder (the provider chain
 *     is never imported by `snapshot.ts` — asserted structurally).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const computeSummariesSlice = vi.fn();
const probeRollupCoverage = vi.fn();
const isFullyCovered = vi.fn();
const readMoodDayRollups = vi.fn();
const ensureUserMoodRollupsFresh = vi.fn();
const computeBpInTargetFastPath = vi.fn();
const getAssistantFlags = vi.fn();
const hasAnyConfiguredProvider = vi.fn();
const buildMedsTodayBlock = vi.fn();
const computeUserHealthScoreFastPath = vi.fn();

vi.mock("@/lib/analytics/summaries-slice", () => ({
  computeSummariesSlice: (...a: unknown[]) => computeSummariesSlice(...a),
}));
vi.mock("@/lib/rollups/measurement-coverage", () => ({
  probeRollupCoverage: (...a: unknown[]) => probeRollupCoverage(...a),
  isFullyCovered: (...a: unknown[]) => isFullyCovered(...a),
}));
vi.mock("@/lib/rollups/mood-rollups", () => ({
  readMoodDayRollups: (...a: unknown[]) => readMoodDayRollups(...a),
  ensureUserMoodRollupsFresh: (...a: unknown[]) =>
    ensureUserMoodRollupsFresh(...a),
}));
vi.mock("@/lib/analytics/bp-in-target-fast-path", () => ({
  computeBpInTargetFastPath: (...a: unknown[]) =>
    computeBpInTargetFastPath(...a),
}));
vi.mock("@/lib/feature-flags", () => ({
  getAssistantFlags: (...a: unknown[]) => getAssistantFlags(...a),
}));
// The builder imports only the credential-PRESENCE check; mock it so the
// test never touches the real provider module (prisma / crypto imports).
vi.mock("@/lib/ai/provider", () => ({
  hasAnyConfiguredProvider: (...a: unknown[]) => hasAnyConfiguredProvider(...a),
}));
// Meds-today + health-score builders are tested in their own suites;
// here only the assembly contract (fast vs warm phase) is pinned.
vi.mock("@/lib/dashboard/meds-today", () => ({
  buildMedsTodayBlock: (...a: unknown[]) => buildMedsTodayBlock(...a),
}));
vi.mock("@/lib/analytics/health-score-fast-path", () => ({
  computeUserHealthScoreFastPath: (...a: unknown[]) =>
    computeUserHealthScoreFastPath(...a),
}));

import {
  buildDashboardSnapshot,
  type SnapshotUserInput,
} from "../snapshot";

const emptySummary = {
  count: 0,
  latest: null,
  min: null,
  max: null,
  mean: null,
  avg7: null,
  avg30: null,
  slope7: null,
  slope30: null,
  slope90: null,
  anomalyCount: 0,
};

const fakePrisma = {
  measurement: { findMany: vi.fn().mockResolvedValue([]) },
  moodEntry: { findMany: vi.fn().mockResolvedValue([]) },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

function baseUser(overrides: Partial<SnapshotUserInput> = {}): SnapshotUserInput {
  return {
    id: "user-1",
    username: "tester",
    displayName: null,
    timezone: "Europe/Berlin",
    heightCm: 180,
    dateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
    gender: "MALE",
    glucoseUnit: "mg/dL",
    onboardingTourCompleted: true,
    disableCoach: false,
    insightsCachedText: null,
    insightsCachedAt: null,
    dashboardWidgetsJson: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  computeSummariesSlice.mockResolvedValue({
    summaries: { WEIGHT: { ...emptySummary, count: 3, latest: 80 } },
    lastSeenByType: {
      WEIGHT: { lastSeenAt: new Date().toISOString() },
    },
    bmi: null,
  });
  readMoodDayRollups.mockResolvedValue([]);
  getAssistantFlags.mockResolvedValue({
    enabled: true,
    coach: true,
    briefing: true,
    insightStatus: true,
    correlations: true,
    healthScoreExplainer: true,
  });
  fakePrisma.measurement.findMany.mockResolvedValue([]);
  fakePrisma.moodEntry.findMany.mockResolvedValue([]);
  hasAnyConfiguredProvider.mockResolvedValue(true);
  buildMedsTodayBlock.mockResolvedValue({
    activeCount: 1,
    scheduledToday: 2,
    takenToday: 1,
    skippedToday: 0,
    nextDueAt: null,
    nextDueOverdue: false,
    nextDueMedicationName: null,
  });
  computeUserHealthScoreFastPath.mockResolvedValue(null);
});

describe("buildDashboardSnapshot — envelope shape", () => {
  it("assembles every above-the-fold field with warm coverage", async () => {
    probeRollupCoverage.mockResolvedValue(new Map([["WEIGHT", true]]));
    isFullyCovered.mockReturnValue(true);
    computeBpInTargetFastPath.mockResolvedValue({
      last7Days: { pct: 70 },
      last30Days: { pct: 80 },
      allTime: { pct: 75 },
      priorMonth: { pct: 60 },
      priorYear: { pct: 50 },
    });

    const snap = await buildDashboardSnapshot(fakePrisma, baseUser());

    // user block
    expect(snap.user.username).toBe("tester");
    expect(snap.user.timezone).toBe("Europe/Berlin");
    expect(snap.user.heightCm).toBe(180);
    expect(snap.user.gender).toBe("MALE");
    expect(typeof snap.user.greetingHour).toBe("number");
    expect(snap.user.greetingHour).toBeGreaterThanOrEqual(0);
    expect(snap.user.greetingHour).toBeLessThan(24);

    // tiles (fast phase) always present
    expect(snap.tiles.summaries.WEIGHT.latest).toBe(80);
    expect(snap.tiles.lastSeenByType.WEIGHT).not.toBeNull();
    expect(snap.tiles.lastSeenByType.WEIGHT!.daysAgo).toBe(0);
    expect(snap.tiles.mood).toBeDefined();

    // extras (thick phase) present + populated when warm
    expect(snap.extras).not.toBeNull();
    expect(snap.extras!.bpInTargetPct).toBe(80);
    expect(snap.extras!.bpInTargetPct7d).toBe(70);
    expect(snap.extras!.bpInTargetPctPriorMonth).toBe(60);

    // layout + briefing slots
    expect(snap.layout).toBeDefined();
    expect(typeof snap.generatedAt).toBe("string");
  });

  it("probes rollup coverage once and threads it into the summaries slice (A5)", async () => {
    const coverageMap = new Map([["WEIGHT", true]]);
    probeRollupCoverage.mockResolvedValue(coverageMap);
    isFullyCovered.mockReturnValue(true);
    computeBpInTargetFastPath.mockResolvedValue({
      last7Days: { pct: 70 },
      last30Days: { pct: 80 },
      allTime: { pct: 75 },
      priorMonth: { pct: 60 },
      priorYear: { pct: 50 },
    });

    await buildDashboardSnapshot(fakePrisma, baseUser());

    // The snapshot probes coverage exactly once up front — the slice no
    // longer re-runs the identical probe internally.
    expect(probeRollupCoverage).toHaveBeenCalledTimes(1);
    // The already-probed map is passed as the slice's second argument so
    // it reuses it instead of probing again.
    expect(computeSummariesSlice).toHaveBeenCalledWith("user-1", coverageMap);
  });
});

describe("buildDashboardSnapshot — two-phase null extras", () => {
  it("returns extras: null on a rollup-coverage miss and never runs the thick read", async () => {
    probeRollupCoverage.mockResolvedValue(new Map([["WEIGHT", false]]));
    isFullyCovered.mockReturnValue(false);

    const snap = await buildDashboardSnapshot(fakePrisma, baseUser());

    expect(snap.extras).toBeNull();
    // The fast phase still resolved fully.
    expect(snap.tiles.summaries.WEIGHT.latest).toBe(80);
    // The thick BP read must NOT have fired — paint-together vs
    // slowest-wins mitigation.
    expect(computeBpInTargetFastPath).not.toHaveBeenCalled();
    // The glucose findMany (part of the thick read) must NOT have fired.
    expect(fakePrisma.measurement.findMany).not.toHaveBeenCalled();
  });
});

describe("buildDashboardSnapshot — medsToday (fast phase)", () => {
  it("rides the fast phase and is present even on a rollup-coverage miss", async () => {
    probeRollupCoverage.mockResolvedValue(new Map([["WEIGHT", false]]));
    isFullyCovered.mockReturnValue(false);

    const snap = await buildDashboardSnapshot(fakePrisma, baseUser());

    expect(snap.medsToday).toEqual({
      activeCount: 1,
      scheduledToday: 2,
      takenToday: 1,
      skippedToday: 0,
      nextDueAt: null,
      nextDueOverdue: false,
      nextDueMedicationName: null,
    });
    // Built from the user's id + timezone, not from any body field.
    expect(buildMedsTodayBlock).toHaveBeenCalledWith(
      fakePrisma,
      "user-1",
      "Europe/Berlin",
      expect.any(Date),
    );
  });
});

describe("buildDashboardSnapshot — healthScore (warm phase only)", () => {
  it("is null on a rollup-coverage miss and the fast path never runs", async () => {
    probeRollupCoverage.mockResolvedValue(new Map([["WEIGHT", false]]));
    isFullyCovered.mockReturnValue(false);

    const snap = await buildDashboardSnapshot(fakePrisma, baseUser());

    expect(snap.healthScore).toBeNull();
    expect(computeUserHealthScoreFastPath).not.toHaveBeenCalled();
  });

  it("serialises score + band + delta — and ONLY those — when warm", async () => {
    const coverageMap = new Map([["WEIGHT", true]]);
    probeRollupCoverage.mockResolvedValue(coverageMap);
    isFullyCovered.mockReturnValue(true);
    computeBpInTargetFastPath.mockResolvedValue({
      last7Days: { pct: 70 },
      last30Days: { pct: 80 },
      allTime: { pct: 75 },
      priorMonth: { pct: 60 },
      priorYear: { pct: 50 },
      gradedScore: 88,
    });
    computeUserHealthScoreFastPath.mockResolvedValue({
      score: 72,
      band: "yellow",
      delta: -12,
      components: { bp: {}, weight: {}, mood: {}, compliance: {} },
    });

    const snap = await buildDashboardSnapshot(fakePrisma, baseUser());

    // Score + band + delta only — components never reach the wire.
    expect(snap.healthScore).toEqual({ score: 72, band: "yellow", delta: -12 });

    // The fast path reuses the BP windows + coverage map already
    // computed for `extras` (no re-probe, graded score threaded).
    expect(computeUserHealthScoreFastPath).toHaveBeenCalledTimes(1);
    const arg = computeUserHealthScoreFastPath.mock.calls[0][0] as {
      userId: string;
      bpInTargetPct: number | null;
      bpGradedScore: number | null;
      heightCm: number | null;
      coverage: unknown;
    };
    expect(arg.userId).toBe("user-1");
    expect(arg.bpInTargetPct).toBe(80);
    expect(arg.bpGradedScore).toBe(88);
    expect(arg.heightCm).toBe(180);
    expect(arg.coverage).toBe(coverageMap);
  });

  it("is null when warm but no pillar is computable (fast path returns null)", async () => {
    probeRollupCoverage.mockResolvedValue(new Map([["WEIGHT", true]]));
    isFullyCovered.mockReturnValue(true);
    computeBpInTargetFastPath.mockResolvedValue({
      last7Days: null,
      last30Days: null,
      allTime: null,
      priorMonth: null,
      priorYear: null,
      gradedScore: null,
    });
    computeUserHealthScoreFastPath.mockResolvedValue(null);

    const snap = await buildDashboardSnapshot(fakePrisma, baseUser());

    expect(snap.extras).not.toBeNull();
    expect(snap.healthScore).toBeNull();
  });
});

describe("buildDashboardSnapshot — briefingState matrix", () => {
  beforeEach(() => {
    probeRollupCoverage.mockResolvedValue(new Map());
    isFullyCovered.mockReturnValue(false);
  });

  it("ready — fresh cached briefing with a valid dailyBriefing block", async () => {
    const briefing = {
      greeting: "Hallo",
      paragraph: "Alles im grünen Bereich.",
      keyFindings: [],
    };
    const snap = await buildDashboardSnapshot(
      fakePrisma,
      baseUser({
        insightsCachedAt: new Date(),
        insightsCachedText: JSON.stringify({ dailyBriefing: briefing }),
      }),
    );
    expect(snap.briefingState).toBe("ready");
    expect(snap.briefing).not.toBeNull();
    expect(snap.briefing!.paragraph).toContain("grünen");
  });

  it("preparing — cache older than 24h still DELIVERS the stale briefing with briefingStale: true", async () => {
    const cachedAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const snap = await buildDashboardSnapshot(
      fakePrisma,
      baseUser({
        insightsCachedAt: cachedAt,
        insightsCachedText: JSON.stringify({
          dailyBriefing: { greeting: "x", paragraph: "y", keyFindings: [] },
        }),
      }),
    );
    expect(snap.briefingState).toBe("preparing");
    // v1.15.20 — the last good briefing rides along instead of a blank
    // tile; the stale flag + timestamp carry the honesty.
    expect(snap.briefing).not.toBeNull();
    expect(snap.briefingStale).toBe(true);
    expect(snap.briefingUpdatedAt).toBe(cachedAt.toISOString());
  });

  it("preparing — never generated (null cache)", async () => {
    const snap = await buildDashboardSnapshot(fakePrisma, baseUser());
    expect(snap.briefingState).toBe("preparing");
    expect(snap.briefing).toBeNull();
    expect(snap.briefingStale).toBe(false);
  });

  it("no-provider — stale cache and no provider configured anywhere", async () => {
    hasAnyConfiguredProvider.mockResolvedValue(false);
    const snap = await buildDashboardSnapshot(fakePrisma, baseUser());
    expect(snap.briefingState).toBe("no-provider");
    expect(snap.briefing).toBeNull();
  });

  it("no-provider — still delivers a stale briefing when one exists", async () => {
    hasAnyConfiguredProvider.mockResolvedValue(false);
    const snap = await buildDashboardSnapshot(
      fakePrisma,
      baseUser({
        insightsCachedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
        insightsCachedText: JSON.stringify({
          dailyBriefing: { greeting: "x", paragraph: "y", keyFindings: [] },
        }),
      }),
    );
    expect(snap.briefingState).toBe("no-provider");
    expect(snap.briefing).not.toBeNull();
    expect(snap.briefingStale).toBe(true);
  });

  it("ready — the provider presence probe never runs on a fresh cache", async () => {
    await buildDashboardSnapshot(
      fakePrisma,
      baseUser({
        insightsCachedAt: new Date(),
        insightsCachedText: JSON.stringify({
          dailyBriefing: { greeting: "x", paragraph: "y", keyFindings: [] },
        }),
      }),
    );
    expect(hasAnyConfiguredProvider).not.toHaveBeenCalled();
  });

  it("disabled — coach surface off (flag)", async () => {
    getAssistantFlags.mockResolvedValue({
      enabled: false,
      coach: false,
      briefing: false,
      insightStatus: false,
      correlations: false,
      healthScoreExplainer: false,
    });
    const snap = await buildDashboardSnapshot(
      fakePrisma,
      baseUser({
        insightsCachedAt: new Date(),
        insightsCachedText: JSON.stringify({
          dailyBriefing: { greeting: "x", paragraph: "y", keyFindings: [] },
        }),
      }),
    );
    expect(snap.briefingState).toBe("disabled");
    expect(snap.briefing).toBeNull();
  });

  it("disabled — per-user disableCoach", async () => {
    const snap = await buildDashboardSnapshot(
      fakePrisma,
      baseUser({
        disableCoach: true,
        insightsCachedAt: new Date(),
        insightsCachedText: JSON.stringify({
          dailyBriefing: { greeting: "x", paragraph: "y", keyFindings: [] },
        }),
      }),
    );
    expect(snap.briefingState).toBe("disabled");
  });

  it("preparing — malformed cached briefing (invalid shape)", async () => {
    const snap = await buildDashboardSnapshot(
      fakePrisma,
      baseUser({
        insightsCachedAt: new Date(),
        insightsCachedText: JSON.stringify({ dailyBriefing: { bogus: 1 } }),
      }),
    );
    expect(snap.briefingState).toBe("preparing");
    expect(snap.briefing).toBeNull();
  });
});

describe("buildDashboardSnapshot — no LLM in the path", () => {
  it("the builder module never imports the provider chain", async () => {
    // Structural guard — the builder must assemble from rollup / mood /
    // widget reads only. If a future edit pulls a provider client in,
    // this assertion fails before it ships.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../snapshot.ts"),
      "utf8",
    );
    // Strip line + block comments so the guard checks executable code,
    // not the docstring that explicitly states the no-LLM contract.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toMatch(/provider-runner|provider-chain|resolveProvider/);
    expect(code).not.toMatch(/runRawCompletion|extractFeatures/);
    expect(code).not.toMatch(/fetch\(\s*["'`][^"'`]*insights\/generate/);
  });
});

describe("buildDashboardSnapshot — metricStates (iOS cold-launch seed)", () => {
  beforeEach(() => {
    probeRollupCoverage.mockResolvedValue(new Map());
    isFullyCovered.mockReturnValue(false);
  });

  it("keys each entry by the iOS MetricKind raw value (incl. the non-obvious raws)", async () => {
    const now = new Date().toISOString();
    computeSummariesSlice.mockResolvedValue({
      summaries: {
        WEIGHT: { ...emptySummary, count: 1, latest: 80 },
        OXYGEN_SATURATION: { ...emptySummary, count: 1, latest: 98 },
        TOTAL_BODY_WATER: { ...emptySummary, count: 1, latest: 42 },
        HEART_RATE_VARIABILITY: { ...emptySummary, count: 1, latest: 55 },
        BODY_MASS_INDEX: { ...emptySummary, count: 1, latest: 24.5 },
        WALKING_ASYMMETRY: { ...emptySummary, count: 1, latest: 3 },
        WALKING_DOUBLE_SUPPORT: { ...emptySummary, count: 1, latest: 27 },
        AUDIO_EXPOSURE_ENV: { ...emptySummary, count: 1, latest: 72 },
        AUDIO_EXPOSURE_HEADPHONE: { ...emptySummary, count: 1, latest: 65 },
        ACTIVE_ENERGY_BURNED: { ...emptySummary, count: 1, latest: 540 },
      },
      lastSeenByType: {
        WEIGHT: { lastSeenAt: now },
        OXYGEN_SATURATION: { lastSeenAt: now },
        TOTAL_BODY_WATER: { lastSeenAt: now },
        HEART_RATE_VARIABILITY: { lastSeenAt: now },
        BODY_MASS_INDEX: { lastSeenAt: now },
        WALKING_ASYMMETRY: { lastSeenAt: now },
        WALKING_DOUBLE_SUPPORT: { lastSeenAt: now },
        AUDIO_EXPOSURE_ENV: { lastSeenAt: now },
        AUDIO_EXPOSURE_HEADPHONE: { lastSeenAt: now },
        ACTIVE_ENERGY_BURNED: { lastSeenAt: now },
      },
      bmi: null,
    });

    const snap = await buildDashboardSnapshot(fakePrisma, baseUser());
    const m = snap.metricStates;

    // Obvious raws.
    expect(m.weight).toEqual({ value: 80, measuredAt: now, unit: "kg" });
    // Non-obvious raws — the convergence-locks §4b mappings.
    expect(m.oxygenSaturation.value).toBe(98);
    expect(m.totalBodyWater.value).toBe(42);
    expect(m.heartRateVariability.value).toBe(55);
    expect(m.bodyMassIndex.value).toBe(24.5);
    expect(m.walkingAsymmetryPercentage.value).toBe(3);
    expect(m.walkingDoubleSupportPercentage.value).toBe(27);
    expect(m.environmentalAudioExposure.value).toBe(72);
    expect(m.headphoneAudioExposure.value).toBe(65);
    expect(m.activeEnergyBurned.value).toBe(540);

    // The raw enum keys must NOT leak — only MetricKind raw values.
    expect(m.OXYGEN_SATURATION).toBeUndefined();
    expect(m.WEIGHT).toBeUndefined();

    // Every entry carries value + measuredAt + unit.
    for (const state of Object.values(m)) {
      expect(typeof state.value).toBe("number");
      expect(typeof state.measuredAt).toBe("string");
      expect(typeof state.unit).toBe("string");
    }
  });

  it("omits metrics with no latest value or no timestamp", async () => {
    computeSummariesSlice.mockResolvedValue({
      summaries: {
        WEIGHT: { ...emptySummary, count: 0, latest: null },
        PULSE: { ...emptySummary, count: 1, latest: 60 },
      },
      lastSeenByType: {
        // WEIGHT has a latest of null → omitted.
        // PULSE has no lastSeen entry → omitted.
        WEIGHT: { lastSeenAt: new Date().toISOString() },
        PULSE: null,
      },
      bmi: null,
    });
    const snap = await buildDashboardSnapshot(fakePrisma, baseUser());
    expect(snap.metricStates.weight).toBeUndefined();
    expect(snap.metricStates.pulse).toBeUndefined();
  });
});

describe("buildDashboardSnapshot — layoutCatalogue (35-id round-trip)", () => {
  beforeEach(() => {
    probeRollupCoverage.mockResolvedValue(new Map());
    isFullyCovered.mockReturnValue(false);
  });

  it("emits all 35 catalogue ids with visibility + order", async () => {
    const snap = await buildDashboardSnapshot(fakePrisma, baseUser());
    expect(snap.layoutCatalogue).toHaveLength(35);
    const ids = new Set(snap.layoutCatalogue.map((w) => w.id));
    expect(ids.size).toBe(35);
    // iOS-only ids appended default-invisible.
    const hrv = snap.layoutCatalogue.find((w) => w.id === "hrv");
    expect(hrv).toBeDefined();
    expect(hrv!.visible).toBe(false);
    for (const w of snap.layoutCatalogue) {
      expect(typeof w.visible).toBe("boolean");
      expect(typeof w.order).toBe("number");
    }
  });

  it("inherits the user's resolved visibility for server-known ids", async () => {
    const snap = await buildDashboardSnapshot(
      fakePrisma,
      baseUser({
        dashboardWidgetsJson: {
          version: 1,
          widgets: [
            { id: "weight", visible: true, order: 0 },
            { id: "sleep", visible: false, order: 7 },
          ],
        },
      }),
    );
    const weight = snap.layoutCatalogue.find((w) => w.id === "weight");
    expect(weight!.visible).toBe(true);
  });
});

describe("buildDashboardSnapshot — additive proof", () => {
  it("leaves every existing top-level field present and unchanged in shape", async () => {
    probeRollupCoverage.mockResolvedValue(new Map([["WEIGHT", true]]));
    isFullyCovered.mockReturnValue(true);
    computeBpInTargetFastPath.mockResolvedValue({
      last7Days: { pct: 70 },
      last30Days: { pct: 80 },
      allTime: { pct: 75 },
      priorMonth: { pct: 60 },
      priorYear: { pct: 50 },
    });

    const snap = await buildDashboardSnapshot(fakePrisma, baseUser());

    // The pre-v1.7.0 top-level keys must all still be present.
    const legacyKeys = [
      "user",
      "layout",
      "tiles",
      "extras",
      "briefing",
      "briefingState",
      "briefingUpdatedAt",
      "generatedAt",
    ];
    for (const key of legacyKeys) {
      expect(snap).toHaveProperty(key);
    }
    // The new additive blocks sit alongside, not in place of.
    expect(snap).toHaveProperty("metricStates");
    expect(snap).toHaveProperty("layoutCatalogue");
    expect(snap).toHaveProperty("briefingStale");
    expect(snap).toHaveProperty("medsToday");
    expect(snap).toHaveProperty("healthScore");

    // The web-consumed `layout` block is the resolved per-user layout —
    // NOT replaced by the 35-id catalogue.
    expect(snap.layout).toHaveProperty("version");
    expect(Array.isArray(snap.layout.widgets)).toBe(true);
    // Resolved layout still carries only server-known widget ids.
    expect(snap.layout.widgets.length).toBeLessThanOrEqual(24);

    // tiles shape unchanged.
    expect(snap.tiles).toHaveProperty("summaries");
    expect(snap.tiles).toHaveProperty("lastSeenByType");
    expect(snap.tiles).toHaveProperty("mood");
  });
});
