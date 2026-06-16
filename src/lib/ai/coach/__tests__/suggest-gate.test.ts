import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  decideFromPrefs,
  gateSuggestion,
  SUGGESTION_COOLDOWN_DAYS,
} from "@/lib/ai/coach/suggest-gate";
import { CADENCE_CATALOG } from "@/lib/ai/coach/suggest-reminder";
import { DEFAULT_REMINDER_SUGGESTION_PREFS } from "@/lib/validations/coach-prefs";

vi.mock("@/lib/modules/gate", () => ({
  isModuleEnabled: vi.fn(async () => true),
}));
import { isModuleEnabled } from "@/lib/modules/gate";

const NOW = new Date("2026-06-16T12:00:00.000Z");

describe("decideFromPrefs", () => {
  it("surfaces with default prefs", () => {
    expect(
      decideFromPrefs(DEFAULT_REMINDER_SUGGESTION_PREFS, "weight_daily", NOW),
    ).toEqual({ surface: true });
  });

  it("suppresses when disabled", () => {
    const d = decideFromPrefs(
      { ...DEFAULT_REMINDER_SUGGESTION_PREFS, enabled: false },
      "weight_daily",
      NOW,
    );
    expect(d).toEqual({ surface: false, reason: "disabled" });
  });

  it("suppresses when the user said stop", () => {
    const d = decideFromPrefs(
      { ...DEFAULT_REMINDER_SUGGESTION_PREFS, stopped: true },
      "weight_daily",
      NOW,
    );
    expect(d).toEqual({ surface: false, reason: "stopped" });
  });

  it("suppresses a dismissed cadence (dismissal memory)", () => {
    const d = decideFromPrefs(
      { ...DEFAULT_REMINDER_SUGGESTION_PREFS, dismissedCadences: ["weight_daily"] },
      "weight_daily",
      NOW,
    );
    expect(d).toEqual({ surface: false, reason: "dismissed" });
  });

  it("suppresses inside the cooldown window and surfaces after it", () => {
    const justNow = new Date(NOW.getTime() - 60_000).toISOString();
    expect(
      decideFromPrefs(
        { ...DEFAULT_REMINDER_SUGGESTION_PREFS, lastSuggestedAt: justNow },
        "weight_daily",
        NOW,
      ),
    ).toEqual({ surface: false, reason: "cooldown" });

    const longAgo = new Date(
      NOW.getTime() - (SUGGESTION_COOLDOWN_DAYS + 1) * 24 * 60 * 60 * 1000,
    ).toISOString();
    expect(
      decideFromPrefs(
        { ...DEFAULT_REMINDER_SUGGESTION_PREFS, lastSuggestedAt: longAgo },
        "weight_daily",
        NOW,
      ),
    ).toEqual({ surface: true });
  });
});

describe("gateSuggestion", () => {
  beforeEach(() => {
    vi.mocked(isModuleEnabled).mockReset();
    vi.mocked(isModuleEnabled).mockResolvedValue(true);
  });

  function fakePrisma(existing: { id: string } | null) {
    return {
      measurementReminder: {
        findFirst: vi.fn(async () => existing),
      },
    } as never;
  }

  it("surfaces a core-domain cadence with no live duplicate", async () => {
    const prisma = fakePrisma(null);
    const d = await gateSuggestion({
      prisma,
      userId: "u1",
      cadence: CADENCE_CATALOG.weight_daily,
      now: NOW,
    });
    expect(d).toEqual({ surface: true });
  });

  it("dedups against a live COACH reminder for the metric", async () => {
    const prisma = fakePrisma({ id: "r1" });
    const d = await gateSuggestion({
      prisma,
      userId: "u1",
      cadence: CADENCE_CATALOG.weight_daily,
      now: NOW,
    });
    expect(d).toEqual({ surface: false, reason: "duplicate" });
  });

  it("suppresses a module-gated cadence when its module is disabled", async () => {
    vi.mocked(isModuleEnabled).mockResolvedValue(false);
    const prisma = fakePrisma(null);
    const d = await gateSuggestion({
      prisma,
      userId: "u1",
      cadence: CADENCE_CATALOG.glucose_structured,
      now: NOW,
    });
    expect(d).toEqual({ surface: false, reason: "module_disabled" });
    expect(isModuleEnabled).toHaveBeenCalledWith("u1", "glucose");
  });

  it("never queries the DB when the pref decision already suppresses", async () => {
    const prisma = fakePrisma(null);
    await gateSuggestion({
      prisma,
      userId: "u1",
      cadence: CADENCE_CATALOG.weight_daily,
      prefs: { ...DEFAULT_REMINDER_SUGGESTION_PREFS, stopped: true },
      now: NOW,
    });
    expect(
      (prisma as unknown as { measurementReminder: { findFirst: ReturnType<typeof vi.fn> } })
        .measurementReminder.findFirst,
    ).not.toHaveBeenCalled();
  });
});
