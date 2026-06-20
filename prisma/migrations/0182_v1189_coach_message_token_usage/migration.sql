-- v1.18.9 — per-message Coach token usage + model.
--
-- The streaming chat endpoint already computes the per-turn token count
-- (`result.tokensUsed`) and the model that produced the reply, but until
-- now neither reached the client. Two additive nullable columns let the
-- quiet per-message token footer survive a conversation reload: the live
-- turn paints from the `done.usage` SSE frame, persisted history paints
-- from these columns.
--
-- Both NULL by default. No backfill: existing rows (and every user turn
-- or refusal, which never carries a token count) simply render no footer.
ALTER TABLE "coach_messages"
  ADD COLUMN "tokens_used" INTEGER,
  ADD COLUMN "model" TEXT;
