import { describe, it, expect } from "vitest";

import {
  UNANSWERED,
  isComplete,
  isLastStep,
  nextStep,
  prevStep,
} from "../check-in-nav";

/**
 * The one-question-at-a-time check-in is LINEAR: the steps are exactly the
 * questions `1..itemCount`, backward navigation is always allowed, and the
 * last question arms the submit directly (v1.27.6 — no review/summary step).
 * These are the contracts the wizard's advance / back behaviour rests on
 * (the SSR-only test convention can't drive the clicks, so the pure grammar
 * is pinned here — the medication wizard's `wizard-payload` precedent).
 */

const PHQ9 = 9;
const GAD7 = 7;

function blank(count: number): number[] {
  return Array(count).fill(UNANSWERED);
}

describe("check-in step grammar (v1.27.6 — questions only, no review step)", () => {
  it("advances forward and stays put on the last question (submit, not advance)", () => {
    expect(nextStep(1, PHQ9)).toBe(2);
    expect(nextStep(8, PHQ9)).toBe(9);
    // The last question is the end of the line — no review step behind it.
    expect(nextStep(9, PHQ9)).toBe(9);
    expect(nextStep(7, GAD7)).toBe(7);
  });

  it("steps back, clamped at the first question", () => {
    expect(prevStep(9)).toBe(8);
    expect(prevStep(2)).toBe(1);
    expect(prevStep(1)).toBe(1);
  });

  it("identifies the last question per instrument", () => {
    expect(isLastStep(8, PHQ9)).toBe(false);
    expect(isLastStep(9, PHQ9)).toBe(true);
    expect(isLastStep(6, GAD7)).toBe(false);
    expect(isLastStep(7, GAD7)).toBe(true);
  });
});

describe("completeness (gates the submit on the last question)", () => {
  it("isComplete requires every item answered", () => {
    expect(isComplete(blank(PHQ9))).toBe(false);
    const partial = blank(PHQ9).map((_, i) => (i < 5 ? 1 : UNANSWERED));
    expect(isComplete(partial)).toBe(false);
    expect(isComplete(blank(PHQ9).map(() => 0))).toBe(true);
    expect(isComplete(blank(GAD7).map(() => 3))).toBe(true);
  });
});
