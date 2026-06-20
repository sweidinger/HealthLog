import { describe, it, expect } from "vitest";

import {
  screenCoachReply,
  coachOutboundFallback,
  COACH_OUTBOUND_DOSE_BLOCK_EN,
  COACH_OUTBOUND_DOSE_BLOCK_DE,
  COACH_OUTBOUND_RISK_BLOCK_EN,
} from "@/lib/ai/coach/outbound-guard";

describe("screenCoachReply — dose-prescription", () => {
  const blocked = [
    "You should step up to 2.4 mg next week.",
    "Consider increasing to 10 mg.",
    "I'd recommend a 0.5 mg dose to start.",
    "Erhöhe auf 7,5 mg, sobald du dich daran gewöhnt hast.",
    "Du kannst die nächste Stufe 5 mg ausprobieren.",
    "Lower your dose to 1.0 mg.",
  ];
  for (const reply of blocked) {
    it(`blocks: ${reply.slice(0, 32)}`, () => {
      const d = screenCoachReply(reply);
      expect(d.block).toBe(true);
      expect(d.reason).toBe("dose_prescription");
    });
  }

  const allowed = [
    "You're on week 3 of 7.5 mg, and your weight is tracking down.",
    "Your snapshot shows you take 5 mg daily — adherence looks steady.",
    "Dein Snapshot zeigt 7,5 mg in Woche 3 — die Einnahmetreue ist gut.",
    "Talk to your prescriber about whether your dose is still right.",
  ];
  for (const reply of allowed) {
    it(`allows factual mention: ${reply.slice(0, 32)}`, () => {
      expect(screenCoachReply(reply).block).toBe(false);
    });
  }
});

describe("screenCoachReply — risk score", () => {
  const blocked = [
    "Your 10-year cardiovascular risk is about 12%.",
    "That puts your stroke risk at 8%.",
    "Your ASCVD score suggests elevated risk.",
    "Dein 10-Jahres-Risiko liegt bei etwa 14%.",
    "Das ergibt ein Risiko von 12% in den nächsten Jahren.",
  ];
  for (const reply of blocked) {
    it(`blocks: ${reply.slice(0, 32)}`, () => {
      const d = screenCoachReply(reply);
      expect(d.block).toBe(true);
      expect(d.reason).toBe("risk_score");
    });
  }

  it("allows a plain percentage that is not a risk claim", () => {
    expect(
      screenCoachReply("Your adherence was 92% over the last 30 days.").block,
    ).toBe(false);
  });
});

describe("screenCoachReply — clean replies", () => {
  it("passes a grounded, non-prescriptive reply", () => {
    const reply =
      "Your systolic is averaging 128 mmHg this week, 4 below your monthly mean. Nice and steady — keep the routine going.";
    expect(screenCoachReply(reply).block).toBe(false);
  });
  it("passes an empty reply through (handled upstream)", () => {
    expect(screenCoachReply("").block).toBe(false);
  });
});

describe("coachOutboundFallback", () => {
  it("returns localised dose-block copy", () => {
    expect(coachOutboundFallback("dose_prescription", "en")).toBe(
      COACH_OUTBOUND_DOSE_BLOCK_EN,
    );
    expect(coachOutboundFallback("dose_prescription", "de")).toBe(
      COACH_OUTBOUND_DOSE_BLOCK_DE,
    );
  });
  it("returns risk-block copy and rides EN for non-de locales", () => {
    expect(coachOutboundFallback("risk_score", "en")).toBe(
      COACH_OUTBOUND_RISK_BLOCK_EN,
    );
    expect(coachOutboundFallback("risk_score", "fr")).toBe(
      COACH_OUTBOUND_RISK_BLOCK_EN,
    );
  });
});
