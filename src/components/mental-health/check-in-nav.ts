/**
 * v1.25.3 — pure step grammar for the one-question-at-a-time check-in.
 *
 * The PHQ-9 / GAD-7 screeners are LINEAR (no mode/cadence branching like the
 * medication wizard), so the step list is a fixed `[1..itemCount, review]` and
 * the reachability ceiling is just "the question you are currently working on"
 * — you can always step backward to change an answer, never skip ahead onto an
 * unanswered question. Keeping the navigation here (mirroring the medication
 * wizard's `wizard-payload.ts`) makes the advance/back/reachability contract
 * unit-testable without driving a DOM.
 *
 * Step numbers are 1-based and run `1..itemCount` for the questions; the review
 * step is `itemCount + 1`. The optional functional-difficulty control folds
 * into the review step (it is unscored), so the dot count stays at
 * `itemCount + 1` rather than gaining its own dot.
 *
 * An unanswered item carries the sentinel `-1`.
 */

export const UNANSWERED = -1;

/** The 1-based review step number for an instrument of `itemCount` items. */
export function reviewStep(itemCount: number): number {
  return itemCount + 1;
}

/** Ordered raw step numbers fed straight to `WizardStepper`: questions + review. */
export function buildStepList(itemCount: number): number[] {
  return Array.from({ length: itemCount + 1 }, (_, i) => i + 1);
}

/** Index (into the step list) of the highest forward-reachable slot. */
export function reachableUntilIndex(items: readonly number[]): number {
  const firstUnanswered = items.findIndex((v) => v < 0);
  // All answered → the review slot (last index) is reachable.
  if (firstUnanswered === -1) return items.length;
  // Otherwise the frontier is the question currently being answered; its index
  // in the step list equals its 0-based item index.
  return firstUnanswered;
}

/** Every item answered (0–3) — gates the review step + submit. */
export function isComplete(items: readonly number[]): boolean {
  return items.length > 0 && items.every((v) => v >= 0);
}

/** How many items carry a real answer (for the review recap). */
export function answeredCount(items: readonly number[]): number {
  return items.filter((v) => v >= 0).length;
}

/**
 * The next step after `step`. A question advances to the next question, the
 * last question advances to the review step, and the review step stays put
 * (submit, not advance).
 */
export function nextStep(step: number, itemCount: number): number {
  const review = reviewStep(itemCount);
  if (step >= review) return review;
  return step + 1;
}

/** The previous step, clamped at the first question. */
export function prevStep(step: number): number {
  return step > 1 ? step - 1 : 1;
}

/** Whether `step` is the review step for this instrument. */
export function isReviewStep(step: number, itemCount: number): boolean {
  return step >= reviewStep(itemCount);
}
