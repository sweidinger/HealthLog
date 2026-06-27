-- v1.23 — remove the bug-report integration.
--
-- The in-app bug-report / feedback surface (user form, admin inbox, optional
-- GitHub-issue escalation) is retired. This migration drops the dedicated
-- feedback table, its enums, and the three AppSettings columns that held the
-- GitHub-issue credentials and the enable toggle.
--
-- Destructive by design: the feature is gone, so its stored data goes with it.
DROP TABLE IF EXISTS "feedback";

DROP TYPE IF EXISTS "feedback_status";
DROP TYPE IF EXISTS "feedback_category";

ALTER TABLE "app_settings"
  DROP COLUMN IF EXISTS "github_issue_token_encrypted",
  DROP COLUMN IF EXISTS "github_issue_repo",
  DROP COLUMN IF EXISTS "bug_report_enabled";
