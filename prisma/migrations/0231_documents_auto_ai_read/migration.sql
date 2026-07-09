-- Automatic AI reading of uploaded vault documents (per-user opt-in).
--
-- One additive, defaulted column on `users`. OFF by default: the document vault
-- stays local-first — a freshly uploaded document is only read by an external AI
-- provider when the user explicitly taps a per-document action (which still
-- requires an active consent receipt). When `true`, the auto-index-on-upload job
-- may read a new document through the user's configured external provider with
-- no per-document tap; flipping the toggle on is itself the standing consent
-- (the write that sets it also mints an `ai_full` consent receipt for the audit
-- trail).
--
-- The default `false` backfills every existing row onto the current behaviour
-- (local-first, per-document-explicit, consent-required), so this is a no-op for
-- anyone who never opts in.

ALTER TABLE "users"
  ADD COLUMN "documents_auto_ai_read" BOOLEAN NOT NULL DEFAULT false;
