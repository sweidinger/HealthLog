/**
 * v1.32.9 (Coach Guard II / G3) — the schedule-gated dose continuation
 * exemption (M6/D7 end state) and the fr/es/it/pl risk-bank parity.
 */
import { describe, it, expect } from "vitest";

import {
  screenModelOutput,
  CONVERSATIONAL_CONTRACTS,
} from "@/lib/ai/safety/outbound-screen";

describe("screenModelOutput — dose exemption gated on the schedule", () => {
  it("passes a continuation dose that MATCHES the user's schedule", () => {
    const d = screenModelOutput(
      "You should keep taking your prescribed 7.5 mg exactly as directed.",
      "en",
      CONVERSATIONAL_CONTRACTS,
      { scheduleDoses: [7.5] },
    );
    expect(d.block).toBe(false);
  });

  it("BLOCKS a continuation dose that does NOT match the schedule (closes the M6 window)", () => {
    // The schedule says 7.5; "keep taking your 15 mg" is a wrong maintenance
    // dose and must not ride the continuation exemption.
    const d = screenModelOutput(
      "You should keep taking your 15 mg as prescribed.",
      "en",
      CONVERSATIONAL_CONTRACTS,
      { scheduleDoses: [7.5] },
    );
    expect(d.block).toBe(true);
    expect(d.reason).toBe("dose_prescription");
  });

  it("keeps the Guard I phrase-anchored exemption when NO schedule is supplied", () => {
    const d = screenModelOutput(
      "You should keep taking your 7.5 mg as prescribed.",
      "en",
      CONVERSATIONAL_CONTRACTS,
    );
    expect(d.block).toBe(false);
  });

  it("still blocks a titration even when the change lands on a scheduled value", () => {
    // A change stem voids the exemption regardless of schedule membership.
    const d = screenModelOutput(
      "You should continue tapering to 7.5 mg next week.",
      "en",
      CONVERSATIONAL_CONTRACTS,
      { scheduleDoses: [7.5] },
    );
    expect(d.block).toBe(true);
  });

  it("matches a comma-decimal scheduled dose (DE reader)", () => {
    const d = screenModelOutput(
      "Nimm weiterhin deine 7,5 mg wie verordnet.",
      "de",
      CONVERSATIONAL_CONTRACTS,
      { scheduleDoses: [7.5] },
    );
    expect(d.block).toBe(false);
  });
});

// ── fr / es / it / pl risk-bank parity ──────────────────────────────────────

describe("screenModelOutput — fabricated risk blocks in fr/es/it/pl", () => {
  const DIGIT_RISK: Record<string, string> = {
    fr: "Votre risque cardiovasculaire est d'environ 14 %.",
    es: "Su riesgo cardiovascular es de aproximadamente 14 %.",
    it: "Il suo rischio cardiovascolare è di circa 14 %.",
    pl: "Twoje ryzyko sercowo-naczyniowe wynosi około 14 %.",
  };
  for (const [locale, text] of Object.entries(DIGIT_RISK)) {
    it(`blocks a digit risk percentage in ${locale}`, () => {
      const d = screenModelOutput(
        text,
        locale as never,
        CONVERSATIONAL_CONTRACTS,
      );
      expect(d.block).toBe(true);
      expect(d.reason).toBe("risk_score");
    });
  }

  it("blocks a spelled-out risk percentage in fr", () => {
    const d = screenModelOutput(
      "Votre risque est d'environ quatorze pour cent selon vos chiffres.",
      "fr",
      CONVERSATIONAL_CONTRACTS,
    );
    expect(d.block).toBe(true);
  });

  it("blocks a named-engine result in es", () => {
    const d = screenModelOutput(
      "Según Framingham, un 14 % en diez años.",
      "es",
      CONVERSATIONAL_CONTRACTS,
    );
    expect(d.block).toBe(true);
  });

  it("blocks a categorical engine verdict (numberless) in it", () => {
    const d = screenModelOutput(
      "SCORE2 la colloca in una fascia ad alto rischio.",
      "it",
      CONVERSATIONAL_CONTRACTS,
    );
    expect(d.block).toBe(true);
  });

  it("does not over-block an ordinary wellness sentence in fr", () => {
    const d = screenModelOutput(
      "Votre sommeil s'est amélioré cette semaine, continuez comme ça.",
      "fr",
      CONVERSATIONAL_CONTRACTS,
    );
    expect(d.block).toBe(false);
  });
});
