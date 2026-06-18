-- v1.18.6 (CCH-03) — Coach "last seen" stamp for the FAB unread dot.
--
-- A single nullable timestamp on `users`. The proactive Coach nudge now
-- lands as an ASSISTANT message in the conversation rail (CCH-02); the
-- Coach FAB shows a discreet unread dot when the newest Coach message is
-- newer than this stamp, and clears it once the user opens the Coach
-- (the open writes the current time here via POST
-- /api/insights/coach/seen).
--
-- NULL backfills every existing row to "never opened" — harmless: the
-- dot only paints when an actual newer Coach message exists, so a user
-- with no proactive nudge yet sees nothing. No data migration needed.

ALTER TABLE "users"
  ADD COLUMN "coach_last_seen_at" TIMESTAMP(3);
