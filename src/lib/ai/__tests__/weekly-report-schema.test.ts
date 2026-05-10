import { describe, it, expect } from "vitest";
import {
  aiInsightResponseSchema,
  weeklyReportSchema,
  storyboardAnnotationSchema,
  storyboardAnnotationsSchema,
  type AIInsightResponse,
} from "../schema";
import {
  PROMPT_VERSION,
  getStrictInsightsSystemPrompt,
} from "../prompts/insight-generator";

/**
 * v1.4.20 phase B4 — Weekly Report + Storyboard Annotations schema +
 * prompt validation.
 *
 * Acceptance covered here:
 *   1. PROMPT_VERSION matches `^4\.20\.\d+$` and is `4.20.2` (B4 bump).
 *   2. weeklyReportSchema enforces section caps (summary 10-800,
 *      bullet ≤280, ≤5 bullets, dataQualityNotes optional ≤280).
 *   3. storyboardAnnotationSchema enforces date / label / category /
 *      detail; the array is capped at 20.
 *   4. aiInsightResponseSchema treats both blocks as optional + nullable
 *      so legacy 4.20.1 caches round-trip.
 *   5. EN + DE prompts both contain GROUND RULE 10 (weeklyReport) +
 *      GROUND RULE 11 (storyboardAnnotations) with conservative
 *      phrasing + section-name match.
 */

const baseResponse: AIInsightResponse = {
  summary: "Things are trending well this week.",
  recommendations: [],
  citations: [],
  warnings: [],
};

describe("PROMPT_VERSION (B4 bump)", () => {
  it("stays on the 4.x train", () => {
    expect(PROMPT_VERSION).toMatch(/^4\.\d+\.\d+$/);
  });

  it("is bumped past 4.20.1 to signal weeklyReport + storyboardAnnotations", () => {
    expect(PROMPT_VERSION).not.toBe("4.20.0");
    expect(PROMPT_VERSION).not.toBe("4.20.1");
  });
});

describe("weeklyReportSchema", () => {
  const validReport = {
    weekISO: "2026-W19",
    summary:
      "Strong week — BP held under 130/85 on 9 of 10 readings and weight is down 0.6 kg.",
    goingWell: [
      "BP under 130/85 on 9 of 10 readings.",
      "Weight down 0.6 kg this week.",
      "Compliance 94 % over the past 7 days.",
    ],
    worthWatching: ["Monday-morning systolic +6 mmHg over 6 weeks."],
    tips: ["Consider a brief walk after dinner on Mondays."],
  };

  it("accepts a fully-populated report", () => {
    expect(weeklyReportSchema.safeParse(validReport).success).toBe(true);
  });

  it("accepts a report with optional dataQualityNotes", () => {
    const result = weeklyReportSchema.safeParse({
      ...validReport,
      dataQualityNotes: "Only 5 BP readings this week — n is borderline.",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a malformed weekISO", () => {
    expect(
      weeklyReportSchema.safeParse({ ...validReport, weekISO: "2026-W9" })
        .success,
    ).toBe(false);
    expect(
      weeklyReportSchema.safeParse({ ...validReport, weekISO: "2026/W19" })
        .success,
    ).toBe(false);
  });

  it("rejects a summary < 10 chars", () => {
    expect(
      weeklyReportSchema.safeParse({ ...validReport, summary: "short" })
        .success,
    ).toBe(false);
  });

  it("rejects a summary > 800 chars", () => {
    const tooLong = "x".repeat(801);
    expect(
      weeklyReportSchema.safeParse({ ...validReport, summary: tooLong })
        .success,
    ).toBe(false);
  });

  it("rejects a goingWell entry > 280 chars", () => {
    const tooLong = "x".repeat(281);
    expect(
      weeklyReportSchema.safeParse({
        ...validReport,
        goingWell: [tooLong],
      }).success,
    ).toBe(false);
  });

  it("rejects more than 5 entries in any bullet list", () => {
    const six = ["a", "b", "c", "d", "e", "f"];
    expect(
      weeklyReportSchema.safeParse({ ...validReport, goingWell: six }).success,
    ).toBe(false);
    expect(
      weeklyReportSchema.safeParse({ ...validReport, worthWatching: six })
        .success,
    ).toBe(false);
    expect(
      weeklyReportSchema.safeParse({ ...validReport, tips: six }).success,
    ).toBe(false);
  });

  it("accepts empty bullet arrays (a quiet week is allowed)", () => {
    const result = weeklyReportSchema.safeParse({
      ...validReport,
      goingWell: [],
      worthWatching: [],
      tips: [],
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty strings in bullet arrays", () => {
    expect(
      weeklyReportSchema.safeParse({ ...validReport, goingWell: [""] }).success,
    ).toBe(false);
  });
});

describe("storyboardAnnotationSchema", () => {
  const valid = {
    date: "2026-04-14",
    label: "Started Ramipril 5 mg",
    category: "medication" as const,
    detail:
      "Logged a new medication entry on April 14. Average systolic for the prior 7 days was 146 mmHg.",
  };

  it("accepts a fully-formed entry", () => {
    expect(storyboardAnnotationSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects a malformed date", () => {
    expect(
      storyboardAnnotationSchema.safeParse({ ...valid, date: "April 14" })
        .success,
    ).toBe(false);
    expect(
      storyboardAnnotationSchema.safeParse({ ...valid, date: "2026-4-14" })
        .success,
    ).toBe(false);
  });

  it("rejects an unknown category", () => {
    expect(
      storyboardAnnotationSchema.safeParse({
        ...valid,
        category: "celebration" as never,
      }).success,
    ).toBe(false);
  });

  it("rejects a label > 80 chars", () => {
    const tooLong = "x".repeat(81);
    expect(
      storyboardAnnotationSchema.safeParse({ ...valid, label: tooLong })
        .success,
    ).toBe(false);
  });

  it("rejects a detail > 400 chars", () => {
    const tooLong = "x".repeat(401);
    expect(
      storyboardAnnotationSchema.safeParse({ ...valid, detail: tooLong })
        .success,
    ).toBe(false);
  });

  it("accepts each of the four canonical categories", () => {
    for (const category of [
      "medication",
      "event",
      "milestone",
      "warning",
    ] as const) {
      expect(
        storyboardAnnotationSchema.safeParse({ ...valid, category }).success,
      ).toBe(true);
    }
  });

  it("array form caps at 20 entries", () => {
    const entry = valid;
    const ok = Array.from({ length: 20 }, () => entry);
    const tooMany = Array.from({ length: 21 }, () => entry);
    expect(storyboardAnnotationsSchema.safeParse(ok).success).toBe(true);
    expect(storyboardAnnotationsSchema.safeParse(tooMany).success).toBe(false);
  });
});

describe("aiInsightResponseSchema — weeklyReport + storyboardAnnotations", () => {
  it("legacy payload (no weeklyReport / storyboardAnnotations) still parses", () => {
    expect(aiInsightResponseSchema.safeParse(baseResponse).success).toBe(true);
  });

  it("payload with weeklyReport=null parses", () => {
    const result = aiInsightResponseSchema.safeParse({
      ...baseResponse,
      weeklyReport: null,
    });
    expect(result.success).toBe(true);
  });

  it("payload with a populated weeklyReport parses round-trip", () => {
    const result = aiInsightResponseSchema.safeParse({
      ...baseResponse,
      weeklyReport: {
        weekISO: "2026-W19",
        summary: "Things look good — BP held in target on 9 of 10 readings.",
        goingWell: ["Compliance 94 %."],
        worthWatching: [],
        tips: ["Keep the evening dose at the same time each day."],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.weeklyReport?.weekISO).toBe("2026-W19");
    }
  });

  it("payload with storyboardAnnotations parses round-trip", () => {
    const result = aiInsightResponseSchema.safeParse({
      ...baseResponse,
      storyboardAnnotations: [
        {
          date: "2026-04-14",
          label: "Started Ramipril 5 mg",
          category: "medication",
          detail: "Logged on April 14. 7-day avg systolic prior was 146 mmHg.",
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.storyboardAnnotations?.length).toBe(1);
    }
  });

  it("payload with both blocks parses round-trip", () => {
    const result = aiInsightResponseSchema.safeParse({
      ...baseResponse,
      weeklyReport: {
        weekISO: "2026-W19",
        summary: "Things look good across the board this week.",
        goingWell: [],
        worthWatching: [],
        tips: [],
      },
      storyboardAnnotations: [],
    });
    expect(result.success).toBe(true);
  });
});

describe("system prompt — GROUND RULE 10 (weeklyReport) + 11 (storyboardAnnotations)", () => {
  it("English prompt declares the weeklyReport rule with section-name match", () => {
    const prompt = getStrictInsightsSystemPrompt("en");
    expect(prompt).toContain("weeklyReport");
    expect(prompt).toMatch(/weekISO/);
    expect(prompt).toContain("goingWell");
    expect(prompt).toContain("worthWatching");
    expect(prompt).toContain("tips");
    expect(prompt).toContain("dataQualityNotes");
    // Conservative phrasing reminder.
    expect(prompt.toLowerCase()).toMatch(/no causal claims/);
  });

  it("English prompt declares the storyboardAnnotations rule", () => {
    const prompt = getStrictInsightsSystemPrompt("en");
    expect(prompt).toContain("storyboardAnnotations");
    expect(prompt).toMatch(/medication|event|milestone|warning/);
    expect(prompt).toMatch(/YYYY-MM-DD/);
    // Neutral / factual phrasing reminder.
    expect(prompt.toLowerCase()).toMatch(/neutral|factual/);
  });

  it("German prompt declares both blocks", () => {
    const prompt = getStrictInsightsSystemPrompt("de");
    expect(prompt).toContain("weeklyReport");
    expect(prompt).toContain("storyboardAnnotations");
    expect(prompt).toMatch(/Kausalbehauptungen/);
    expect(prompt).toContain("medication");
    expect(prompt).toContain("milestone");
  });

  it("both prompts spell the JSON shape with the correct keys", () => {
    for (const locale of ["en", "de"] as const) {
      const prompt = getStrictInsightsSystemPrompt(locale);
      expect(prompt).toMatch(/"weekISO":/);
      expect(prompt).toMatch(/"goingWell":/);
      expect(prompt).toMatch(/"worthWatching":/);
      expect(prompt).toMatch(/"tips":/);
      expect(prompt).toMatch(/"category":/);
    }
  });
});
