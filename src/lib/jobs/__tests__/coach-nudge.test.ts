/**
 * v1.15.20 — proactive Coach nudge: deterministic-trigger unit tests.
 *
 * Pins the pure trigger predicates and the localised payload builder
 * without a DB or pg-boss boot:
 *   - compliance: < 60 % over ≥ 5 due doses fires; deliberate skips
 *     are excluded from both sides of the ratio.
 *   - bp: weekly systolic mean strictly above the effective greenMax
 *     fires; fewer than 3 readings (or no resolvable target) never does.
 *   - score: the recent 7-day mean must sit ≥ 15 points under the
 *     prior 7-day mean, with ≥ 3 samples in each window.
 *   - payload: title + body resolve per locale and fall back to the
 *     app default for null / unknown locales.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import {
  COACH_NUDGE_COMPLIANCE_MIN_DOSES,
  COACH_NUDGE_FOCUS_MAX_CHARS,
  COACH_NUDGE_SCORE_DROP,
  COACH_NUDGE_SLEEP_MIN_NIGHTS,
  COACH_NUDGE_TRIGGER_GROUPS,
  buildCoachNudgePayload,
  evaluateBpTrigger,
  evaluateComplianceTrigger,
  evaluateMeasurementGapTrigger,
  evaluateScoreTrigger,
  evaluateSelfContextTrigger,
  evaluateSleepDebtTrigger,
  evaluateWeightTrigger,
  runCoachNudgeTick,
} from "../coach-nudge";
import { getAssistantFlags } from "@/lib/feature-flags";
import { userRowHasProviderCredential } from "@/lib/ai/provider";

vi.mock("@/lib/feature-flags", () => ({
  getAssistantFlags: vi.fn(async () => ({ coach: true })),
}));
vi.mock("@/lib/ai/provider", () => ({
  userRowHasProviderCredential: vi.fn(() => true),
}));
vi.mock("@/lib/ai/coach/bytes-codec", () => ({
  decryptFromBytes: vi.fn(() => "morning blood pressure"),
  encryptToBytes: vi.fn(),
}));

function dose(taken: boolean, skipped = false, autoMissed?: boolean) {
  return {
    takenAt: taken ? new Date() : null,
    skipped,
    // An untaken, unskipped row in these fixtures models a RESOLVED miss
    // (the hourly auto-miss cron has flipped it). A still-open pending is
    // modelled explicitly with `autoMissed: false`.
    autoMissed: autoMissed ?? (!taken && !skipped),
  };
}

describe("evaluateComplianceTrigger", () => {
  it("fires below 60 % with enough due doses", () => {
    // 2 of 6 taken → 33 %.
    const rows = [
      dose(true),
      dose(true),
      dose(false),
      dose(false),
      dose(false),
      dose(false),
    ];
    expect(evaluateComplianceTrigger(rows)).toBe(true);
  });

  it("stays silent at or above 60 %", () => {
    // 4 of 6 taken → 67 %.
    const rows = [
      dose(true),
      dose(true),
      dose(true),
      dose(true),
      dose(false),
      dose(false),
    ];
    expect(evaluateComplianceTrigger(rows)).toBe(false);
  });

  it("requires the minimum due-dose floor", () => {
    const rows = Array.from(
      { length: COACH_NUDGE_COMPLIANCE_MIN_DOSES - 1 },
      () => dose(false),
    );
    expect(evaluateComplianceTrigger(rows)).toBe(false);
  });

  it("excludes deliberate skips from the ratio", () => {
    // 3 taken + 2 missed = 60 % (no fire); 4 skips must not drag the
    // denominator down into trigger territory.
    const rows = [
      dose(true),
      dose(true),
      dose(true),
      dose(false),
      dose(false),
      dose(false, true),
      dose(false, true),
      dose(false, true),
      dose(false, true),
    ];
    expect(evaluateComplianceTrigger(rows)).toBe(false);
  });

  it("excludes still-open pendings from the denominator (v1.16.1)", () => {
    // 3 taken + 2 auto-missed = 60 % (no fire). Four open pendings —
    // today's not-yet-due slots, or slots whose grace window is still
    // running (autoMissed false) — must not count as misses: with them
    // the rate would read 33 % and nudge an adherent user at 05:15.
    const rows = [
      dose(true),
      dose(true),
      dose(true),
      dose(false), // resolved miss (auto-missed)
      dose(false), // resolved miss (auto-missed)
      dose(false, false, false), // open pending
      dose(false, false, false), // open pending
      dose(false, false, false), // open pending
      dose(false, false, false), // open pending
    ];
    expect(evaluateComplianceTrigger(rows)).toBe(false);
  });
});

describe("evaluateBpTrigger", () => {
  it("fires when the weekly mean exceeds the target", () => {
    expect(evaluateBpTrigger([150, 148, 152], 135)).toBe(true);
  });

  it("stays silent when the mean sits at or under the target", () => {
    expect(evaluateBpTrigger([135, 134, 136], 135)).toBe(false);
  });

  it("requires at least 3 readings", () => {
    expect(evaluateBpTrigger([180, 180], 135)).toBe(false);
  });

  it("never fires without a resolvable target", () => {
    expect(evaluateBpTrigger([180, 180, 180], null)).toBe(false);
  });
});

describe("evaluateScoreTrigger", () => {
  it("fires on a sharp week-over-week drop", () => {
    expect(
      evaluateScoreTrigger([50, 52, 48], [70, 72, 68]),
    ).toBe(true);
  });

  it("stays silent under the drop threshold", () => {
    const prior = [70, 70, 70];
    const recent = prior.map((v) => v - COACH_NUDGE_SCORE_DROP + 1);
    expect(evaluateScoreTrigger(recent, prior)).toBe(false);
  });

  it("requires enough samples in both windows", () => {
    expect(evaluateScoreTrigger([40, 40], [70, 70, 70])).toBe(false);
    expect(evaluateScoreTrigger([40, 40, 40], [70, 70])).toBe(false);
  });
});

describe("buildCoachNudgePayload", () => {
  it("resolves the German payload", () => {
    const { title, body } = buildCoachNudgePayload("bp", "de");
    expect(title).toBe("Blutdruck im Wochenmittel erhöht");
    expect(body.length).toBeGreaterThan(0);
  });

  it("resolves the English payload", () => {
    const { title } = buildCoachNudgePayload("compliance", "en");
    expect(title).toBe("Your Coach has a thought on this");
  });

  it("falls back to the default locale for unknown locales", () => {
    const fallback = buildCoachNudgePayload("score", null);
    const unknown = buildCoachNudgePayload("score", "xx");
    expect(unknown).toEqual(fallback);
  });

  it("produces a distinct payload per trigger", () => {
    const titles = new Set(
      (
        [
          "compliance",
          "bp",
          "score",
          "selfContext",
          "weight",
          "sleepDebt",
          "measurementGap",
        ] as const
      ).map((trigger) => buildCoachNudgePayload(trigger, "en").title),
    );
    expect(titles.size).toBe(7);
  });

  it("appends the personal focus suffix when a Coach focus exists", () => {
    const { body } = buildCoachNudgePayload("bp", "en", "morning readings");
    expect(body).toContain("You wanted to keep an eye on: morning readings.");
  });

  it("clamps an over-long focus before quoting it", () => {
    const focus = "x".repeat(COACH_NUDGE_FOCUS_MAX_CHARS + 40);
    const { body } = buildCoachNudgePayload("weight", "en", focus);
    expect(body).toContain("…");
    expect(body).not.toContain(focus);
  });

  it("skips the suffix for the self-context check-up nudge", () => {
    const plain = buildCoachNudgePayload("selfContext", "en");
    const withFocus = buildCoachNudgePayload(
      "selfContext",
      "en",
      "morning readings",
    );
    expect(withFocus).toEqual(plain);
  });

  it("skips the suffix for a null / blank focus", () => {
    const plain = buildCoachNudgePayload("bp", "en");
    expect(buildCoachNudgePayload("bp", "en", null)).toEqual(plain);
    expect(buildCoachNudgePayload("bp", "en", "   ")).toEqual(plain);
  });
});

describe("evaluateWeightTrigger", () => {
  const range = { greenMin: 60, greenMax: 80 };

  it("fires when the weekly mean sits outside the range and drifts away", () => {
    expect(
      evaluateWeightTrigger([82, 82.5, 83], [81, 81.3, 81.5], range),
    ).toBe(true);
  });

  it("fires for a drift below the range too", () => {
    expect(evaluateWeightTrigger([57, 57, 57], [59, 59, 59], range)).toBe(
      true,
    );
  });

  it("stays silent inside the range", () => {
    expect(evaluateWeightTrigger([79, 79, 79], [70, 70, 70], range)).toBe(
      false,
    );
  });

  it("stays silent while converging back toward the range", () => {
    expect(evaluateWeightTrigger([81, 81, 81], [83, 83, 83], range)).toBe(
      false,
    );
  });

  it("stays silent under the drift floor", () => {
    // 1.3 kg vs 1.0 kg from the range — only 0.3 kg of drift.
    expect(
      evaluateWeightTrigger([81.3, 81.3, 81.3], [81, 81, 81], range),
    ).toBe(false);
  });

  it("requires enough readings in both windows", () => {
    expect(evaluateWeightTrigger([85, 85], [81, 81, 81], range)).toBe(false);
    expect(evaluateWeightTrigger([85, 85, 85], [81, 81], range)).toBe(false);
  });

  it("never fires without a resolvable range", () => {
    expect(evaluateWeightTrigger([85, 85, 85], [81, 81, 81], null)).toBe(
      false,
    );
  });
});

describe("evaluateSleepDebtTrigger", () => {
  const floor = 7; // effective greenMin; deficit means < 6.5 h.

  it("fires when 4 of 5 recorded nights clearly undershoot the floor", () => {
    expect(
      evaluateSleepDebtTrigger([6, 6.2, 5.9, 6.4, 7.5], floor),
    ).toBe(true);
  });

  it("stays silent with only 3 deficit nights", () => {
    expect(evaluateSleepDebtTrigger([6, 6, 6, 7.5, 8], floor)).toBe(false);
  });

  it("does not count near-misses inside the margin as deficits", () => {
    // 6.6 h against a 7 h floor is within the 0.5 h margin.
    expect(
      evaluateSleepDebtTrigger([6.6, 6.6, 6.6, 6.6, 6.6], floor),
    ).toBe(false);
  });

  it("requires the minimum number of recorded nights", () => {
    const nights = Array.from(
      { length: COACH_NUDGE_SLEEP_MIN_NIGHTS - 1 },
      () => 5,
    );
    expect(evaluateSleepDebtTrigger(nights, floor)).toBe(false);
  });

  it("never fires without a resolvable floor", () => {
    expect(evaluateSleepDebtTrigger([5, 5, 5, 5, 5], null)).toBe(false);
  });
});

describe("evaluateMeasurementGapTrigger", () => {
  it("fires when an active account goes fully silent", () => {
    expect(evaluateMeasurementGapTrigger(12, 0)).toBe(true);
  });

  it("stays silent for a sporadically tracking account", () => {
    expect(evaluateMeasurementGapTrigger(9, 0)).toBe(false);
  });

  it("stays silent while anything still arrives", () => {
    expect(evaluateMeasurementGapTrigger(12, 1)).toBe(false);
  });
});

describe("COACH_NUDGE_TRIGGER_GROUPS", () => {
  it("maps every trigger onto its pref group", () => {
    expect(COACH_NUDGE_TRIGGER_GROUPS).toEqual({
      compliance: "medication",
      bp: "vitals",
      score: "vitals",
      weight: "vitals",
      sleepDebt: "vitals",
      measurementGap: "routine",
      selfContext: "routine",
    });
  });
});

describe("evaluateSelfContextTrigger", () => {
  const now = new Date("2026-06-10T05:15:00Z");
  const daysAgo = (days: number) =>
    new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const fullProfile = (updatedAt: Date) => ({
    hasAboutMe: true,
    hasConditions: true,
    hasAllergies: true,
    hasCoachFocus: true,
    updatedAt,
  });

  it("never fires without recent Coach activity", () => {
    expect(
      evaluateSelfContextTrigger(
        { profile: null, lastCoachUseAt: null },
        now,
      ),
    ).toBe(false);
    expect(
      evaluateSelfContextTrigger(
        { profile: null, lastCoachUseAt: daysAgo(15) },
        now,
      ),
    ).toBe(false);
  });

  it("fires for an active user with no profile at all", () => {
    expect(
      evaluateSelfContextTrigger(
        { profile: null, lastCoachUseAt: daysAgo(2) },
        now,
      ),
    ).toBe(true);
  });

  it("fires for an incomplete profile", () => {
    expect(
      evaluateSelfContextTrigger(
        {
          profile: { ...fullProfile(daysAgo(1)), hasAllergies: false },
          lastCoachUseAt: daysAgo(2),
        },
        now,
      ),
    ).toBe(true);
  });

  it("fires for a complete-but-stale profile (60+ days)", () => {
    expect(
      evaluateSelfContextTrigger(
        { profile: fullProfile(daysAgo(61)), lastCoachUseAt: daysAgo(2) },
        now,
      ),
    ).toBe(true);
  });

  it("stays silent for a complete, fresh profile", () => {
    expect(
      evaluateSelfContextTrigger(
        { profile: fullProfile(daysAgo(10)), lastCoachUseAt: daysAgo(2) },
        now,
      ),
    ).toBe(false);
  });
});

/**
 * v1.16.5 — tick-level contracts: gate order, per-group prefs gating,
 * the per-user frequency cap, and the focus personalisation. The
 * Prisma client is a hand-rolled mock; flags / provider / decrypt are
 * module mocks (see the vi.mock calls at the top).
 */
describe("runCoachNudgeTick — gates and prefs", () => {
  const now = new Date("2026-06-10T05:15:00Z");
  const MS_PER_DAY = 24 * 60 * 60 * 1000;

  function userRow(notificationPrefs: unknown) {
    return {
      id: "user-1",
      locale: "en",
      notificationPrefs,
      heightCm: null,
      dateOfBirth: null,
      gender: null,
      thresholdsJson: null,
    };
  }

  function prismaMock(overrides: {
    users?: unknown[];
    intakeRows?: unknown[];
    recentNudge?: unknown;
    coachFocusEncrypted?: Uint8Array | null;
  }) {
    return {
      user: {
        findMany: vi.fn(async () => overrides.users ?? []),
      },
      appSettings: {
        findUnique: vi.fn(async () => ({ adminAiKeyEncrypted: "k" })),
      },
      pushAttempt: {
        findFirst: vi.fn(async (args?: unknown) => {
          void args;
          return overrides.recentNudge ?? null;
        }),
      },
      medicationIntakeEvent: {
        findMany: vi.fn(async () => overrides.intakeRows ?? []),
      },
      measurement: {
        findMany: vi.fn(async () => []),
        count: vi.fn(async () => 1),
      },
      coachUsage: { findFirst: vi.fn(async () => null) },
      userHealthProfile: {
        findUnique: vi.fn(async () => ({
          coachFocusEncrypted: overrides.coachFocusEncrypted ?? null,
        })),
      },
      $queryRaw: vi.fn(async () => [{ days: 0 }]),
    };
  }

  /** Six resolved doses, one taken → 17 %, well under the 60 % gate. */
  const failingIntakes = [
    { takenAt: new Date(), skipped: false, autoMissed: false },
    ...Array.from({ length: 5 }, () => ({
      takenAt: null,
      skipped: false,
      autoMissed: true,
    })),
  ];

  beforeEach(() => {
    vi.mocked(getAssistantFlags).mockResolvedValue({
      coach: true,
    } as Awaited<ReturnType<typeof getAssistantFlags>>);
    vi.mocked(userRowHasProviderCredential).mockReturnValue(true);
  });

  it("counts a master opt-out before touching provider or cap gates", async () => {
    const prisma = prismaMock({
      users: [userRow({ coach: { nudgesEnabled: false } })],
    });
    const summary = await runCoachNudgeTick(
      prisma as unknown as PrismaClient,
      now,
      { dispatch: vi.fn() },
    );
    expect(summary.skippedOptedOut).toBe(1);
    expect(userRowHasProviderCredential).not.toHaveBeenCalled();
    expect(prisma.pushAttempt.findFirst).not.toHaveBeenCalled();
  });

  it("treats every group disabled as opted out, not as no-trigger", async () => {
    const prisma = prismaMock({
      users: [
        userRow({
          coach: {
            nudgesEnabled: true,
            nudgeMedication: false,
            nudgeVitals: false,
            nudgeRoutine: false,
          },
        }),
      ],
      intakeRows: failingIntakes,
    });
    const summary = await runCoachNudgeTick(
      prisma as unknown as PrismaClient,
      now,
      { dispatch: vi.fn() },
    );
    expect(summary.skippedOptedOut).toBe(1);
    expect(prisma.medicationIntakeEvent.findMany).not.toHaveBeenCalled();
  });

  it("checks the provider gate before the frequency cap", async () => {
    vi.mocked(userRowHasProviderCredential).mockReturnValue(false);
    const prisma = prismaMock({ users: [userRow(null)] });
    const summary = await runCoachNudgeTick(
      prisma as unknown as PrismaClient,
      now,
      { dispatch: vi.fn() },
    );
    expect(summary.skippedNoProvider).toBe(1);
    expect(prisma.pushAttempt.findFirst).not.toHaveBeenCalled();
  });

  it("widens the cap cutoff to 14 days for a biweekly user", async () => {
    const prisma = prismaMock({
      users: [userRow({ coach: { nudgeFrequency: "biweekly" } })],
    });
    await runCoachNudgeTick(prisma as unknown as PrismaClient, now, {
      dispatch: vi.fn(),
    });
    const arg = vi.mocked(prisma.pushAttempt.findFirst).mock.calls[0]?.[0] as {
      where: { createdAt: { gte: Date } };
    } | undefined;
    expect(arg?.where.createdAt.gte.getTime()).toBe(
      now.getTime() - 14 * MS_PER_DAY,
    );
  });

  it("skips a disabled group's trigger queries entirely", async () => {
    const prisma = prismaMock({
      users: [
        userRow({
          coach: { nudgeMedication: false },
        }),
      ],
      intakeRows: failingIntakes,
    });
    const summary = await runCoachNudgeTick(
      prisma as unknown as PrismaClient,
      now,
      { dispatch: vi.fn() },
    );
    // The would-be compliance hit is never even queried; the remaining
    // groups find nothing in the empty fixtures.
    expect(prisma.medicationIntakeEvent.findMany).not.toHaveBeenCalled();
    expect(summary.skippedNoTrigger).toBe(1);
  });

  it("personalises the dispatched body with the decrypted Coach focus", async () => {
    const dispatch = vi.fn(async (input: unknown) => {
      void input;
      return { dispatched: true };
    });
    const prisma = prismaMock({
      users: [userRow(null)],
      intakeRows: failingIntakes,
      coachFocusEncrypted: new Uint8Array([1, 2, 3]),
    });
    const summary = await runCoachNudgeTick(
      prisma as unknown as PrismaClient,
      now,
      { dispatch: dispatch as never },
    );
    expect(summary.dispatched).toBe(1);
    const payload = dispatch.mock.calls[0]?.[0] as unknown as {
      message: string;
      metadata: { trigger: string };
    };
    expect(payload.metadata.trigger).toBe("compliance");
    expect(payload.message).toContain(
      "You wanted to keep an eye on: morning blood pressure.",
    );
  });
});
