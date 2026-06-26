/**
 * Query keys — Coach preferences, facts, about-me, and nudge state.
 * Part of the centralized factory; aggregated in `./index.ts`.
 */
export const coachKeys = {
  coachPrefs: () => ["coach-prefs"] as const,
  coachFacts: () => ["coach-facts"] as const,
  /** v1.15.20 — Settings → AI "about me" self-description. */
  coachAboutMe: () => ["coach-about-me"] as const,
  /** v1.16.0 — pending clarifying questions (Coach composer chips). */
  coachAboutMeQuestions: () => ["coach-about-me", "questions"] as const,
  /** v1.16.1 — unseen proactive-nudge state for the floating Coach bubble. */
  coachNudgeStatus: () => ["coach-nudge-status"] as const,
  /** v1.18.6 (CCH-03) — mark-Coach-seen mutation (clears the FAB unread dot). */
  coachMarkSeen: () => ["coach-mark-seen"] as const,
  /**
   * v1.18.7 — the Coach conversation rail list (`GET /api/insights/chat`).
   * Previously a hook-local bare `["coachConversations"]`; centralised so
   * the optimistic delete and the streaming hook's post-turn invalidation
   * share one factory-routed key.
   */
  coachConversations: () => ["coachConversations"] as const,
  /**
   * v1.18.7 — one decrypted Coach conversation (`GET /api/insights/chat/[id]`).
   * Keyed on the conversation id so two open threads never share a cache slot;
   * the streaming hook invalidates this slot once the persisted twin lands.
   */
  coachConversation: (id: string | null) => ["coachConversation", id] as const,
  /**
   * v1.21.2 (A3) — today's most notable derived signal, resolved into the
   * Coach hero's pre-seeded relevance opener
   * (`GET /api/insights/coach/seeded-question`).
   */
  coachSeededQuestion: () => ["coach-seeded-question"] as const,
};
