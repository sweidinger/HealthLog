import { describe, it, expect } from "vitest";

import {
  UNANSWERED,
  answeredCount,
  buildStepList,
  isComplete,
  isReviewStep,
  nextStep,
  prevStep,
  reachableUntilIndex,
  reviewStep,
} from "../check-in-nav";

/**
 * The one-question-at-a-time check-in is LINEAR: the step list is
 * `[1..itemCount, review]`, backward navigation is always allowed, and the
 * forward ceiling never lets a user skip ahead onto an unanswered question.
 * These are the contracts the wizard's advance / back / reachability behaviour
 * rests on (the SSR-only test convention can't drive the clicks, so the pure
 * grammar is pinned here — the medication wizard's `wizard-payload` precedent).
 */

const PHQ9 = 9;
const GAD7 = 7;

function blank(count: number): number[] {
  return Array(count).fill(UNANSWERED);
}

describe("check-in step grammar", () => {
  it("builds questions + a single review dot (itemCount + 1)", () => {
    expect(buildStepList(PHQ9)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(buildStepList(GAD7)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(reviewStep(PHQ9)).toBe(10);
    expect(reviewStep(GAD7)).toBe(8);
  });

  it("advances forward on a question and into review from the last question", () => {
    expect(nextStep(1, PHQ9)).toBe(2);
    expect(nextStep(8, PHQ9)).toBe(9);
    // last question (9) → review (10)
    expect(nextStep(9, PHQ9)).toBe(10);
    // review stays put (submit, not advance)
    expect(nextStep(10, PHQ9)).toBe(10);
  });

  it("steps back, clamped at the first question", () => {
    expect(prevStep(10)).toBe(9);
    expect(prevStep(2)).toBe(1);
    expect(prevStep(1)).toBe(1);
  });

  it("identifies the review step", () => {
    expect(isReviewStep(9, PHQ9)).toBe(false);
    expect(isReviewStep(10, PHQ9)).toBe(true);
    expect(isReviewStep(7, GAD7)).toBe(false);
    expect(isReviewStep(8, GAD7)).toBe(true);
  });
});

describe("reachability ceiling (never skip ahead to an unanswered question)", () => {
  it("with nothing answered, only the first question is reachable", () => {
    expect(reachableUntilIndex(blank(PHQ9))).toBe(0);
  });

  it("the frontier follows the first unanswered item", () => {
    const items = blank(PHQ9);
    items[0] = 2; // Q1 answered → can reach Q2 (index 1)
    expect(reachableUntilIndex(items)).toBe(1);
    items[1] = 0;
    items[2] = 3; // Q3 answered too → frontier at the first gap (index 3)
    expect(reachableUntilIndex(items)).toBe(3);
  });

  it("once every item is answered the review slot (last index) is reachable", () => {
    const items = blank(GAD7).map(() => 1);
    // step list length is itemCount + 1; review index == itemCount
    expect(reachableUntilIndex(items)).toBe(GAD7);
    expect(buildStepList(GAD7).length - 1).toBe(GAD7);
  });
});

describe("completeness + recap", () => {
  it("isComplete requires every item answered", () => {
    expect(isComplete(blank(PHQ9))).toBe(false);
    const partial = blank(PHQ9).map((_, i) => (i < 5 ? 1 : UNANSWERED));
    expect(isComplete(partial)).toBe(false);
    expect(isComplete(blank(PHQ9).map(() => 0))).toBe(true);
  });

  it("answeredCount counts only real (0–3) answers", () => {
    const items = blank(PHQ9);
    items[0] = 0;
    items[1] = 3;
    expect(answeredCount(items)).toBe(2);
  });
});
