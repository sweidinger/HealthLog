import { describe, expect, it } from "vitest";

import {
  countAdopted,
  deriveThreadItems,
  GUIDED_IDLE,
  guidedReducer,
  type GuidedEvent,
  type GuidedState,
} from "../guided-questions-machine";

/**
 * v1.16.5 — guided clarifying-questions state machine.
 *
 * Pure-reducer coverage for the in-chat guided flow: start / later /
 * answer / skip / exit / dismiss transitions, adoption settling, and
 * the thread-item derivation the conversation surface renders from.
 */

const QUESTIONS = [
  "Do you have any chronic conditions?",
  "What should the Coach focus on?",
  "Any allergies worth noting?",
];

function run(events: GuidedEvent[], from: GuidedState = GUIDED_IDLE) {
  return events.reduce(guidedReducer, from);
}

describe("guidedReducer — entry", () => {
  it("START snapshots the questions and asks the first", () => {
    const state = run([{ type: "START", questions: QUESTIONS }]);
    expect(state).toEqual({
      phase: "asking",
      questions: QUESTIONS,
      index: 0,
      outcomes: [],
    });
  });

  it("START with no questions is a no-op", () => {
    expect(run([{ type: "START", questions: [] }])).toEqual(GUIDED_IDLE);
  });

  it("START mid-flow is ignored (no sequence restart)", () => {
    const asking = run([{ type: "START", questions: QUESTIONS }]);
    expect(guidedReducer(asking, { type: "START", questions: ["x"] })).toBe(
      asking,
    );
  });

  it("LATER from idle hides the offer for the session", () => {
    expect(run([{ type: "LATER" }])).toEqual({ phase: "done" });
  });

  it("LATER mid-flow is ignored — the bubble actions own the exits", () => {
    const asking = run([{ type: "START", questions: QUESTIONS }]);
    expect(guidedReducer(asking, { type: "LATER" })).toBe(asking);
  });
});

describe("guidedReducer — answering", () => {
  it("ANSWER_SUBMITTED records the outcome and waits for the turn", () => {
    const state = run([
      { type: "START", questions: QUESTIONS },
      { type: "ANSWER_SUBMITTED", answer: "Hypertension." },
    ]);
    expect(state.phase).toBe("answered");
    if (state.phase !== "answered") throw new Error("unreachable");
    expect(state.outcomes).toEqual([
      {
        index: 0,
        question: QUESTIONS[0],
        answer: "Hypertension.",
        adoption: "pending",
      },
    ]);
  });

  it("TURN_COMPLETE advances to the next question", () => {
    const state = run([
      { type: "START", questions: QUESTIONS },
      { type: "ANSWER_SUBMITTED", answer: "Hypertension." },
      { type: "TURN_COMPLETE" },
    ]);
    expect(state).toMatchObject({ phase: "asking", index: 1 });
  });

  it("TURN_COMPLETE after the last question lands on the summary", () => {
    const state = run([
      { type: "START", questions: ["only one"] },
      { type: "ANSWER_SUBMITTED", answer: "An answer." },
      { type: "TURN_COMPLETE" },
    ]);
    expect(state.phase).toBe("summary");
    if (state.phase !== "summary") throw new Error("unreachable");
    expect(state.outcomes).toHaveLength(1);
  });

  it("composer submits outside the asking phase change nothing", () => {
    const summary = run([
      { type: "START", questions: ["only one"] },
      { type: "ANSWER_SUBMITTED", answer: "An answer." },
      { type: "TURN_COMPLETE" },
    ]);
    expect(
      guidedReducer(summary, { type: "ANSWER_SUBMITTED", answer: "more" }),
    ).toBe(summary);
  });
});

describe("guidedReducer — skip / exit / reset", () => {
  it("SKIP advances without an outcome (question stays pending)", () => {
    const state = run([
      { type: "START", questions: QUESTIONS },
      { type: "SKIP" },
    ]);
    expect(state).toMatchObject({ phase: "asking", index: 1, outcomes: [] });
  });

  it("skipping every question ends without a summary", () => {
    const state = run([
      { type: "START", questions: QUESTIONS },
      { type: "SKIP" },
      { type: "SKIP" },
      { type: "SKIP" },
    ]);
    expect(state).toEqual({ phase: "done" });
  });

  it("SKIP on the last question shows the summary when answers exist", () => {
    const state = run([
      { type: "START", questions: QUESTIONS },
      { type: "ANSWER_SUBMITTED", answer: "Hypertension." },
      { type: "TURN_COMPLETE" },
      { type: "SKIP" },
      { type: "SKIP" },
    ]);
    expect(state.phase).toBe("summary");
  });

  it("EXIT with answers lands on the summary; without answers it just ends", () => {
    const withAnswer = run([
      { type: "START", questions: QUESTIONS },
      { type: "ANSWER_SUBMITTED", answer: "Hypertension." },
      { type: "TURN_COMPLETE" },
      { type: "EXIT" },
    ]);
    expect(withAnswer.phase).toBe("summary");

    const withoutAnswer = run([
      { type: "START", questions: QUESTIONS },
      { type: "EXIT" },
    ]);
    expect(withoutAnswer).toEqual({ phase: "done" });
  });

  it("RESET drops any session back to idle", () => {
    const state = run([
      { type: "START", questions: QUESTIONS },
      { type: "ANSWER_SUBMITTED", answer: "Hypertension." },
      { type: "RESET" },
    ]);
    expect(state).toEqual(GUIDED_IDLE);
  });
});

describe("guidedReducer — adoption settling", () => {
  const answeredOne: GuidedEvent[] = [
    { type: "START", questions: QUESTIONS },
    { type: "ANSWER_SUBMITTED", answer: "Hypertension." },
    { type: "TURN_COMPLETE" },
  ];

  it("settles the matching pending outcome", () => {
    const state = run([
      ...answeredOne,
      { type: "ADOPTION_SETTLED", index: 0, adoption: "adopted" },
    ]);
    if (state.phase !== "asking") throw new Error("unreachable");
    expect(state.outcomes[0].adoption).toBe("adopted");
  });

  it("never resettles an already-settled outcome", () => {
    const state = run([
      ...answeredOne,
      { type: "ADOPTION_SETTLED", index: 0, adoption: "declined" },
      { type: "ADOPTION_SETTLED", index: 0, adoption: "adopted" },
    ]);
    if (state.phase !== "asking") throw new Error("unreachable");
    expect(state.outcomes[0].adoption).toBe("declined");
  });

  it("still settles outcomes while the summary is showing", () => {
    const state = run([
      { type: "START", questions: ["only one"] },
      { type: "ANSWER_SUBMITTED", answer: "An answer." },
      { type: "TURN_COMPLETE" },
      { type: "ADOPTION_SETTLED", index: 0, adoption: "adopted" },
    ]);
    if (state.phase !== "summary") throw new Error("unreachable");
    expect(countAdopted(state.outcomes)).toBe(1);
  });
});

describe("guidedReducer — reaction-then-adopt sequencing (v1.16.6)", () => {
  // With a provider, the turn streams a Coach reaction and the flow
  // waits in `answered` until the adopt offer settles; the settle of
  // the CURRENT outcome is what advances the sequence.
  it("ADOPTION_SETTLED for the current outcome advances to the next question", () => {
    const state = run([
      { type: "START", questions: QUESTIONS },
      { type: "ANSWER_SUBMITTED", answer: "Hypertension." },
      { type: "ADOPTION_SETTLED", index: 0, adoption: "adopted" },
    ]);
    if (state.phase !== "asking") throw new Error("unreachable");
    expect(state.index).toBe(1);
    expect(state.outcomes[0].adoption).toBe("adopted");
  });

  it("ADOPTION_SETTLED on the last answer lands on the summary", () => {
    const state = run([
      { type: "START", questions: ["only one"] },
      { type: "ANSWER_SUBMITTED", answer: "An answer." },
      { type: "ADOPTION_SETTLED", index: 0, adoption: "declined" },
    ]);
    expect(state.phase).toBe("summary");
    if (state.phase !== "summary") throw new Error("unreachable");
    expect(state.outcomes[0].adoption).toBe("declined");
  });

  it("a late settle for an older outcome does not advance", () => {
    // Silent (provider-less) flow already advanced via TURN_COMPLETE;
    // question 2 is answered and streaming when outcome 0 settles.
    const state = run([
      { type: "START", questions: QUESTIONS },
      { type: "ANSWER_SUBMITTED", answer: "Hypertension." },
      { type: "TURN_COMPLETE" },
      { type: "ANSWER_SUBMITTED", answer: "Sleep." },
      { type: "ADOPTION_SETTLED", index: 0, adoption: "adopted" },
    ]);
    if (state.phase !== "answered") throw new Error("unreachable");
    expect(state.index).toBe(1);
    expect(state.outcomes[0].adoption).toBe("adopted");
  });

  it("the silent flow still advances on TURN_COMPLETE alone", () => {
    const state = run([
      { type: "START", questions: QUESTIONS },
      { type: "ANSWER_SUBMITTED", answer: "Hypertension." },
      { type: "TURN_COMPLETE" },
    ]);
    if (state.phase !== "asking") throw new Error("unreachable");
    expect(state.index).toBe(1);
  });
});

describe("deriveThreadItems", () => {
  it("idle and done contribute nothing", () => {
    expect(deriveThreadItems(GUIDED_IDLE)).toEqual([]);
    expect(deriveThreadItems({ phase: "done" })).toEqual([]);
  });

  it("asking renders answered questions anchored + the current at the tail", () => {
    const state = run([
      { type: "START", questions: QUESTIONS },
      { type: "ANSWER_SUBMITTED", answer: "Hypertension." },
      { type: "TURN_COMPLETE" },
    ]);
    const items = deriveThreadItems(state);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      kind: "question",
      question: QUESTIONS[0],
      progress: { current: 1, total: 3 },
      anchorAnswer: "Hypertension.",
    });
    expect(items[1]).toMatchObject({
      kind: "question",
      question: QUESTIONS[1],
      progress: { current: 2, total: 3 },
      anchorAnswer: null,
      current: true,
    });
  });

  it("a skipped question keeps the original numbering on the next one", () => {
    const state = run([
      { type: "START", questions: QUESTIONS },
      { type: "SKIP" },
    ]);
    const items = deriveThreadItems(state);
    expect(items).toHaveLength(1);
    expect(items[0].progress).toEqual({ current: 2, total: 3 });
  });

  it("answered phase has no current item (the turn is streaming)", () => {
    const state = run([
      { type: "START", questions: QUESTIONS },
      { type: "ANSWER_SUBMITTED", answer: "Hypertension." },
    ]);
    const items = deriveThreadItems(state);
    expect(items).toHaveLength(1);
    expect(items[0].anchorAnswer).toBe("Hypertension.");
  });

  it("summary carries answered / adopted / total counts", () => {
    const state = run([
      { type: "START", questions: QUESTIONS },
      { type: "ANSWER_SUBMITTED", answer: "Hypertension." },
      { type: "TURN_COMPLETE" },
      { type: "ADOPTION_SETTLED", index: 0, adoption: "adopted" },
      { type: "ANSWER_SUBMITTED", answer: "Sleep." },
      { type: "TURN_COMPLETE" },
      { type: "ADOPTION_SETTLED", index: 1, adoption: "declined" },
      { type: "SKIP" },
    ]);
    const items = deriveThreadItems(state);
    const summary = items.at(-1);
    expect(summary).toMatchObject({
      kind: "summary",
      anchorAnswer: null,
      summary: { answered: 2, adopted: 1, total: 3 },
    });
  });
});
