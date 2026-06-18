-- v1.18.6 (DISC-02) — one-time medical-disclaimer acknowledgment.
--
-- Two nullable columns on `users` recording that the user acknowledged, once
-- at the start of onboarding, that HealthLog is a private tracking tool — not
-- a clinical assessment or diagnosis — and that they should talk to a doctor
-- if worried. The `*_version` pins exactly which copy was read (mirrors the
-- `research_mode_acknowledged_*` pair), so a future material wording change
-- can re-prompt without a schema change.
--
-- Both nullable with no default: NULL = never acknowledged. The prompt only
-- gates fresh onboarding, so existing accounts (backfilled to NULL) are never
-- re-walled. This replaces the per-page / per-chart disclaimer banners that
-- were removed app-wide in the same release; the acknowledged legal text
-- stays reachable on the public privacy page.

ALTER TABLE "users"
  ADD COLUMN "disclaimer_acknowledged_at" TIMESTAMP(3),
  ADD COLUMN "disclaimer_acknowledged_version" TEXT;
