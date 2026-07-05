/**
 * v1.25.3 — pure step grammar for the one-question-at-a-time check-in.
 *
 * The PHQ-9 / GAD-7 screeners are LINEAR (no mode/cadence branching like the
 * medication wizard), so the steps are exactly the questions `1..itemCount`:
 * you can always step backward to change an answer, and never skip ahead past
 * an unanswered question. Keeping the navigation here (mirroring the
 * medication wizard's `wizard-payload.ts`) makes the advance/back contract
 * unit-testable without driving a DOM.
 *
 * v1.27.6 — the review/summary step is gone: answering the last question
 * arms the submit directly (no "9 of 9 answered" interstitial demanding one
 * more decision). Step numbers are 1-based and run `1..itemCount`.
 *
 * An unanswered item carries the sentinel `-1`.
 */

export const UNANSWERED = -1;

/** Every item answered (0–3) — gates the submit on the last question. */
export function isComplete(items: readonly number[]): boolean {
  return items.length > 0 && items.every((v) => v >= 0);
}

/**
 * The next step after `step`: a question advances to the next question; the
 * last question stays put (submit, not advance).
 */
export function nextStep(step: number, itemCount: number): number {
  if (step >= itemCount) return itemCount;
  return step + 1;
}

/** The previous step, clamped at the first question. */
export function prevStep(step: number): number {
  return step > 1 ? step - 1 : 1;
}

/** Whether `step` is the last question for this instrument. */
export function isLastStep(step: number, itemCount: number): boolean {
  return step >= itemCount;
}
