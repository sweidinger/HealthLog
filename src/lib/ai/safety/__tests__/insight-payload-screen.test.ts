import { describe, it, expect } from "vitest";

import {
  collectInsightProse,
  screenInsightPayloadProse,
} from "@/lib/ai/safety/insight-payload-screen";
import { locales } from "@/lib/i18n/config";

/**
 * The briefing's number-grounding gate covers `paragraph`, `signalsOfDay[]`
 * and `keyFindings[]`, and it grades NUMBERS only — so a digit-free risk
 * assertion passed it, and `recommendations[]` / `summary` were not graded at
 * all. These tests pin that the safety screen reaches every prose field.
 */

const CLEAN_PAYLOAD = {
  summary: "Your tracked metrics held steady over the last 30 days.",
  recommendations: [
    { id: "r1", text: "Keep logging your morning readings at the same time." },
  ],
  dailyBriefing: {
    paragraph: "Weight and sleep both moved with your usual weekday rhythm.",
    signalsOfDay: [{ headline: "Steady week", nudge: "Keep it going." }],
    keyFindings: [{ headline: "Sleep", detail: "In line with your baseline." }],
  },
};

describe("collectInsightProse", () => {
  it("reaches summary, recommendations and every briefing sub-field", () => {
    const prose = collectInsightProse(CLEAN_PAYLOAD);
    expect(prose).toContain(CLEAN_PAYLOAD.summary);
    expect(prose).toContain(CLEAN_PAYLOAD.recommendations[0].text);
    expect(prose).toContain(CLEAN_PAYLOAD.dailyBriefing.paragraph);
    expect(prose).toContain("Steady week");
    expect(prose).toContain("In line with your baseline.");
  });

  it("handles the legacy bare-string recommendation shape", () => {
    const prose = collectInsightProse({
      recommendations: ["Drink water with each dose."],
    });
    expect(prose).toContain("Drink water with each dose.");
  });

  it("returns nothing for a non-object payload", () => {
    expect(collectInsightProse(null)).toEqual([]);
    expect(collectInsightProse("nope")).toEqual([]);
  });
});

describe("screenInsightPayloadProse — clean payload", () => {
  for (const locale of locales) {
    it(`passes a grounded payload for a ${locale} reader`, () => {
      expect(screenInsightPayloadProse(CLEAN_PAYLOAD, locale)).toBeNull();
    });
  }
});

describe("screenInsightPayloadProse — fields the number gate never graded", () => {
  it("catches a digit-free risk assertion in the briefing paragraph", () => {
    // The exact shape the number-only gate lets through: no digit anywhere the
    // grounding check could grade. It trips the RISK contract rather than the
    // dose one -- "stepping your dose up" carries no number+unit, so the dose
    // bank (deliberately tight, to protect factual restatements) does not fire.
    const reason = screenInsightPayloadProse(
      {
        recommendations: [],
        dailyBriefing: {
          paragraph:
            "Your 10-year cardiovascular risk is elevated — consider stepping your dose up.",
        },
      },
      "en",
    );
    expect(reason).toBe("risk_score");
  });

  it("catches a dose imperative in recommendations[]", () => {
    const reason = screenInsightPayloadProse(
      {
        recommendations: [
          { id: "r1", text: "Increase to 10 mg starting next week." },
        ],
      },
      "en",
    );
    expect(reason).toBe("dose_prescription");
  });

  it("catches a causal claim in summary", () => {
    const reason = screenInsightPayloadProse(
      {
        summary: "Your weight fell because you slept more.",
        recommendations: [],
      },
      "en",
    );
    expect(reason).toBe("causal_claim");
  });
});

describe("screenInsightPayloadProse — non-EN/DE locales", () => {
  const VIOLATIONS: Record<string, string> = {
    fr: "Augmentez votre dose à 2,4 mg la semaine prochaine.",
    es: "Aumente su dosis a 2,4 mg la próxima semana.",
    it: "Aumenti la sua dose a 2,4 mg la prossima settimana.",
    pl: "Proszę zwiększyć dawkę do 2,4 mg w przyszłym tygodniu.",
  };

  for (const [locale, text] of Object.entries(VIOLATIONS)) {
    it(`catches a ${locale} dose imperative in recommendations[]`, () => {
      const reason = screenInsightPayloadProse(
        { recommendations: [{ id: "r1", text }] },
        locale as (typeof locales)[number],
      );
      expect(reason).toBe("dose_prescription");
    });
  }
});
