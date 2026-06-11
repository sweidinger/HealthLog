/**
 * v1.16.5 — guided clarifying-questions flow, the V2 of the v1.16.0
 * composer chips.
 *
 * After the user saves Settings → AI → "About me", up to 3 pending
 * clarifying questions live encrypted on the profile
 * (`/api/coach/about-me/questions`). V1 surfaced them as loose chips
 * the user had to pick apart; V2 walks them one at a time inside the
 * chat: an entry card offers the sequence, the Coach asks each
 * question as a deterministic bubble (no model call), the user answers
 * in the normal composer, the existing `/adopt` offer folds the answer
 * into the matching self-context field, and a closing summary says
 * what was taken over.
 *
 * This module is the whole client-side state machine, kept pure so the
 * transitions can be unit-tested without a DOM:
 *
 *   idle ──START──▶ asking ──ANSWER_SUBMITTED──▶ answered
 *     │               │  ▲                          │
 *   LATER           SKIP└──────TURN_COMPLETE────────┘
 *     │               │      (next question, or…)
 *     ▼               ├──EXIT/SKIP-on-last──▶ summary (answers exist)
 *   done ◀────────────┴──────────────────────▶ done   (none answered)
 *
 * Server contract stays additive-free: answering dismisses that one
 * question (existing DELETE), "skip" / "later" leave questions pending
 * for the next session, "don't ask again" dismisses all (existing
 * DELETE with empty body). No new schema, no new endpoint.
 */

/** Lifecycle of one answered question's adopt offer. */
export type GuidedAdoption =
  | "pending"
  | "adopted"
  | "duplicate"
  | "declined"
  | "failed";

export interface GuidedOutcome {
  /** Index of the question in the session snapshot (progress label). */
  index: number;
  question: string;
  /** The composer message that answered it (thread anchor). */
  answer: string;
  adoption: GuidedAdoption;
}

export type GuidedState =
  | { phase: "idle" }
  | { phase: "done" }
  | {
      /**
       * `asking` — the current question bubble is live and the next
       * composer submit answers it. `answered` — the answer was sent
       * and the assistant turn is still streaming; no current bubble.
       */
      phase: "asking" | "answered";
      /** Snapshot taken at START; pending-question edits mid-flow don't reshuffle the sequence. */
      questions: string[];
      index: number;
      outcomes: GuidedOutcome[];
    }
  | { phase: "summary"; questions: string[]; outcomes: GuidedOutcome[] };

export const GUIDED_IDLE: GuidedState = { phase: "idle" };

export type GuidedEvent =
  | { type: "START"; questions: string[] }
  /** Entry-card "later": hide the offer for this session, keep questions pending. */
  | { type: "LATER" }
  /** Composer submit while `asking` — the message answers the current question. */
  | { type: "ANSWER_SUBMITTED"; answer: string }
  /** The assistant turn for the answer finished; advance the sequence. */
  | { type: "TURN_COMPLETE" }
  /** Skip the current question (stays pending server-side). */
  | { type: "SKIP" }
  /** Leave the flow ("later" / "don't ask again" mid-sequence). */
  | { type: "EXIT" }
  /** The adopt offer for an answered question settled. */
  | {
      type: "ADOPTION_SETTLED";
      index: number;
      adoption: Exclude<GuidedAdoption, "pending">;
    }
  /** New chat / conversation switch / drawer close — drop the session. */
  | { type: "RESET" };

/**
 * Close the sequence: answered questions earn the summary bubble;
 * a flow abandoned before any answer just ends (the entry card will
 * re-offer the still-pending questions next session).
 */
function finish(state: {
  questions: string[];
  outcomes: GuidedOutcome[];
}): GuidedState {
  return state.outcomes.length > 0
    ? { phase: "summary", questions: state.questions, outcomes: state.outcomes }
    : { phase: "done" };
}

export function guidedReducer(
  state: GuidedState,
  event: GuidedEvent,
): GuidedState {
  switch (event.type) {
    case "RESET":
      return GUIDED_IDLE;

    case "START": {
      if (state.phase !== "idle" && state.phase !== "done") return state;
      if (event.questions.length === 0) return state;
      return {
        phase: "asking",
        questions: [...event.questions],
        index: 0,
        outcomes: [],
      };
    }

    case "LATER":
      return state.phase === "idle" ? { phase: "done" } : state;

    case "ANSWER_SUBMITTED": {
      if (state.phase !== "asking") return state;
      return {
        ...state,
        phase: "answered",
        outcomes: [
          ...state.outcomes,
          {
            index: state.index,
            question: state.questions[state.index],
            answer: event.answer,
            adoption: "pending",
          },
        ],
      };
    }

    case "TURN_COMPLETE": {
      if (state.phase !== "answered") return state;
      const next = state.index + 1;
      if (next < state.questions.length) {
        return { ...state, phase: "asking", index: next };
      }
      return finish(state);
    }

    case "SKIP": {
      if (state.phase !== "asking") return state;
      const next = state.index + 1;
      if (next < state.questions.length) {
        return { ...state, index: next };
      }
      return finish(state);
    }

    case "EXIT": {
      if (state.phase !== "asking") return state;
      return finish(state);
    }

    case "ADOPTION_SETTLED": {
      if (
        state.phase !== "asking" &&
        state.phase !== "answered" &&
        state.phase !== "summary"
      ) {
        return state;
      }
      const outcomes = state.outcomes.map((o) =>
        o.index === event.index && o.adoption === "pending"
          ? { ...o, adoption: event.adoption }
          : o,
      );
      return { ...state, outcomes };
    }
  }
}

/** Count of answers actually written into the self-context. */
export function countAdopted(outcomes: GuidedOutcome[]): number {
  return outcomes.filter((o) => o.adoption === "adopted").length;
}

/**
 * One in-thread bubble the guided flow contributes. Answered questions
 * anchor immediately BEFORE the user message that answered them
 * (`anchorAnswer` = that message's content) so the transcript reads
 * question → answer → reply; the current question and the summary
 * carry `anchorAnswer: null` and render at the thread tail.
 */
export interface GuidedThreadItem {
  key: string;
  kind: "question" | "summary";
  /** kind=question */
  question?: string;
  progress?: { current: number; total: number };
  /** kind=question: live question — render actions + typing reveal. */
  current?: boolean;
  /** kind=summary */
  summary?: { answered: number; adopted: number; total: number };
  anchorAnswer: string | null;
}

export function deriveThreadItems(state: GuidedState): GuidedThreadItem[] {
  if (state.phase === "idle" || state.phase === "done") return [];

  const total = state.questions.length;
  const items: GuidedThreadItem[] = state.outcomes.map((o) => ({
    key: `guided-q-${o.index}`,
    kind: "question",
    question: o.question,
    progress: { current: o.index + 1, total },
    anchorAnswer: o.answer,
  }));

  if (state.phase === "asking") {
    items.push({
      key: `guided-q-${state.index}`,
      kind: "question",
      question: state.questions[state.index],
      progress: { current: state.index + 1, total },
      current: true,
      anchorAnswer: null,
    });
  }

  if (state.phase === "summary") {
    items.push({
      key: "guided-summary",
      kind: "summary",
      summary: {
        answered: state.outcomes.length,
        adopted: countAdopted(state.outcomes),
        total,
      },
      anchorAnswer: null,
    });
  }

  return items;
}
