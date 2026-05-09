-- v1.4.16 phase B5e: per-recommendation thumbs-up/thumbs-down feedback.
--
-- Each row captures one rating event from one user against one
-- recommendation. The dedup key (userId, recommendationId,
-- recommendationText) lets a regeneration that rewrites the same id
-- with new text re-rate cleanly while preventing accidental double-
-- submission of the same (id + text) pair.
--
-- Provider attribution (providerType + promptVersion) is filled
-- server-side from the user's most recent cached insight payload, so
-- the client can't tamper with which provider / prompt version a
-- thumbs-down is attributed to. The aggregator slices on these to
-- power the admin AI quality dashboard.
--
-- Indexes:
--   (userId, createdAt)             — per-user timeline lookups
--   (severity, helpful, createdAt)  — aggregator's cross-user slice
-- The unique key doubles as a (userId, recommendationId, text) lookup.
--
-- GDPR: ON DELETE CASCADE through users → personal data follows the
-- account; covered in tests/integration/cascade-delete.test.ts.

CREATE TABLE "recommendation_feedback" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "recommendation_id" TEXT NOT NULL,
  "recommendation_text" TEXT NOT NULL,
  "recommendation_severity" TEXT NOT NULL,
  "metric_source_type" TEXT NOT NULL,
  "metric_source_time_range" TEXT NOT NULL,
  "helpful" BOOLEAN NOT NULL,
  "provider_type" TEXT NOT NULL,
  "prompt_version" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "recommendation_feedback_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "rec_feedback_user_rec_text_key"
  ON "recommendation_feedback" ("user_id", "recommendation_id", "recommendation_text");

CREATE INDEX "recommendation_feedback_user_id_created_at_idx"
  ON "recommendation_feedback" ("user_id", "created_at");

CREATE INDEX "recommendation_feedback_recommendation_severity_helpful_cre_idx"
  ON "recommendation_feedback" ("recommendation_severity", "helpful", "created_at");

ALTER TABLE "recommendation_feedback"
  ADD CONSTRAINT "recommendation_feedback_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- v1.4.16 phase B5e: daily-aggregated feedback summary written by the
-- pg-boss `feedback-aggregator` job. Read by /admin/ai-quality.
ALTER TABLE "app_settings"
  ADD COLUMN "admin_ai_insights_feedback_summary" JSONB;
