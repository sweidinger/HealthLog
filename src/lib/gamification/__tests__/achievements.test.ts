import { describe, it, expect } from "vitest";
import {
  ACHIEVEMENT_DEFINITIONS,
  ACHIEVEMENT_CATEGORY_ORDER,
  applyDiscoveryFilter,
  calculateLongestStreak,
  evaluateAchievementsWithCompletionDates,
  getUniqueBerlinDays,
  type AchievementMetrics,
  type AchievementProgress,
  type EarnabilityFlags,
} from "@/lib/gamification/achievements";

const FULL_METRICS: AchievementMetrics = {
  totalTakenIntakes: 1000,
  overIntakeCount: 1000,
  skippedIntakeCount: 1000,
  bmiGreenStreak: 1000,
  bpGreenStreak: 1000,
  pulseGreenStreak: 1000,
  onTimePerfectDayStreak: 1000,
  compliance80DayStreak: 1000,
  passkeyCreatedCount: 1000,
  passkeyLoginCount: 1000,
  passwordLoginCount: 1000,
  loginDayStreak: 1000,
  bugReportCount: 1000,
  moodEntryCount: 1000,
  moodDayStreak: 1000,
  moodImprovementHit: 1000,
  weightMeasurementCount: 1000,
  bpMeasurementCount: 1000,
  pulseMeasurementCount: 1000,
  consistentMonthCount: 1000,
  entryDayStreak: 1000,
  weekendStreakCount: 1000,
  nightOwlCount: 1000,
  earlyBirdCount: 1000,
  leapDayCount: 1000,
  doctorPdfCount: 1000,
  localeFlipCount: 1000,
};

const ZERO_METRICS: AchievementMetrics = Object.fromEntries(
  Object.keys(FULL_METRICS).map((key) => [key, 0]),
) as unknown as AchievementMetrics;

const ALL_EARNABLE: EarnabilityFlags = {
  hasMedication: true,
  hasMood: true,
  hasWeight: true,
  hasBp: true,
  hasPulse: true,
};

const NONE_EARNABLE: EarnabilityFlags = {
  hasMedication: false,
  hasMood: false,
  hasWeight: false,
  hasBp: false,
  hasPulse: false,
};

describe("gamification achievements", () => {
  it("deduplicates and sorts day keys", () => {
    const days = getUniqueBerlinDays([
      new Date("2026-02-11T12:00:00Z"),
      new Date("2026-02-10T12:00:00Z"),
      new Date("2026-02-11T16:00:00Z"),
    ]);

    expect(days).toEqual(["2026-02-10", "2026-02-11"]);
  });

  it("calculates the longest streak", () => {
    expect(
      calculateLongestStreak([
        "2026-02-01",
        "2026-02-02",
        "2026-02-04",
        "2026-02-05",
        "2026-02-06",
      ]),
    ).toBe(3);
  });

  it("ships the v1.4.18 expanded definition list (59 total)", () => {
    expect(ACHIEVEMENT_DEFINITIONS).toHaveLength(59);
  });

  it("includes mood and hidden categories in the render order", () => {
    expect(ACHIEVEMENT_CATEGORY_ORDER).toContain("mood");
    expect(ACHIEVEMENT_CATEGORY_ORDER).toContain("hidden");
  });

  it("evaluates unlocked achievements and points when all metrics maxed", () => {
    const result = evaluateAchievementsWithCompletionDates(FULL_METRICS, {});

    expect(result.summary.unlockedCount).toBe(59);
    expect(result.summary.totalCount).toBe(59);
    expect(result.summary.nextAchievement).toBeNull();
    expect(result.summary.earnedPoints).toBe(result.summary.totalPoints);
  });

  it("flags hidden achievements with isHidden", () => {
    const hidden = ACHIEVEMENT_DEFINITIONS.filter((def) => def.isHidden);
    expect(hidden.length).toBeGreaterThanOrEqual(5);
    expect(hidden.length).toBeLessThanOrEqual(8);
    for (const def of hidden) {
      expect(def.category).toBe("hidden");
    }
  });

  it("flags non-hidden achievements with category != hidden", () => {
    const visible = ACHIEVEMENT_DEFINITIONS.filter((def) => !def.isHidden);
    for (const def of visible) {
      expect(def.category).not.toBe("hidden");
    }
  });
});

describe("applyDiscoveryFilter", () => {
  function progressFor(id: string): AchievementProgress {
    const def = ACHIEVEMENT_DEFINITIONS.find((d) => d.id === id);
    if (!def) throw new Error(`unknown achievement: ${id}`);
    return {
      id: def.id,
      metric: def.metric,
      category: def.category,
      titleKey: def.tTitle,
      descriptionKey: def.tDescription,
      icon: def.icon,
      format: def.format,
      target: def.target,
      current: 0,
      points: def.points,
      unlocked: false,
      progressPercent: 0,
      completedAt: null,
      isHidden: def.isHidden,
    };
  }

  it("hides public mood achievements when the user has no mood data", () => {
    const items = [progressFor("mood-first")];
    const filtered = applyDiscoveryFilter(items, NONE_EARNABLE);
    expect(filtered).toHaveLength(0);
  });

  it("keeps mood achievements when the user has at least one mood entry", () => {
    const items = [progressFor("mood-first")];
    const filtered = applyDiscoveryFilter(items, {
      ...NONE_EARNABLE,
      hasMood: true,
    });
    expect(filtered).toHaveLength(1);
  });

  it("keeps unlocked achievements even if precondition no longer holds (anti-regression)", () => {
    const items = [{ ...progressFor("mood-first"), unlocked: true }];
    const filtered = applyDiscoveryFilter(items, NONE_EARNABLE);
    expect(filtered).toHaveLength(1);
  });

  it("always keeps hidden achievements regardless of earnability", () => {
    const items = [progressFor("hidden-night-owl")];
    const filtered = applyDiscoveryFilter(items, NONE_EARNABLE);
    expect(filtered).toHaveLength(1);
  });

  it("keeps engagement / security achievements unconditionally", () => {
    const items = [progressFor("login-streak-7"), progressFor("passkey-created-1")];
    const filtered = applyDiscoveryFilter(items, NONE_EARNABLE);
    expect(filtered).toHaveLength(2);
  });

  it("keeps medication achievements only when the user has at least one medication", () => {
    const items = [progressFor("intake-total-1")];
    expect(applyDiscoveryFilter(items, NONE_EARNABLE)).toHaveLength(0);
    expect(
      applyDiscoveryFilter(items, { ...NONE_EARNABLE, hasMedication: true }),
    ).toHaveLength(1);
  });

  it("zero-progress full set with all-earnable still yields full count", () => {
    const result = evaluateAchievementsWithCompletionDates(ZERO_METRICS, {});
    const filtered = applyDiscoveryFilter(result.achievements, ALL_EARNABLE);
    expect(filtered.length).toBe(result.achievements.length);
    expect(result.summary.unlockedCount).toBe(0);
  });
});
