-- v1.4.3: explicit on/off switch for the bug-report surface.
--
-- Until this release the bug-report feature was implicitly gated on
-- "is the GitHub token + repo configured?". That coupling meant an
-- admin who wanted to *temporarily* hide the bug-report button (e.g.
-- during a deploy freeze) had to clear the encrypted token, which
-- forced a re-entry on resume — destructive for a reversible
-- intent.
--
-- Default `true` so existing instances with credentials configured
-- keep the feature visible after the upgrade. Admins who want it off
-- flip the switch in `/admin/integrations` (or whichever section
-- mounts the bug-report card).

ALTER TABLE "app_settings"
  ADD COLUMN "bug_report_enabled" BOOLEAN NOT NULL DEFAULT TRUE;
