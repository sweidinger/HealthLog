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
import { describe, expect, it } from "vitest";

import {
  COACH_NUDGE_COMPLIANCE_MIN_DOSES,
  COACH_NUDGE_SCORE_DROP,
  buildCoachNudgePayload,
  evaluateBpTrigger,
  evaluateComplianceTrigger,
  evaluateScoreTrigger,
} from "../coach-nudge";

function dose(taken: boolean, skipped = false) {
  return { takenAt: taken ? new Date() : null, skipped };
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
      (["compliance", "bp", "score"] as const).map(
        (trigger) => buildCoachNudgePayload(trigger, "en").title,
      ),
    );
    expect(titles.size).toBe(3);
  });
});
