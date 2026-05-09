-- v1.4.15 Phase B5: track completion of the post-onboarding spotlight
-- tour that overlays the dashboard for first-time users.
--
-- Distinct from `onboarding_completed_at` (the 3-step wizard at
-- `/onboarding`). Once the wizard finishes the user lands on the
-- dashboard; this column tracks whether the spotlight tour that walks
-- the user through the tile strip / quick-add menu / insights /
-- integrations has been seen-or-dismissed. Default false so existing
-- users who never saw the tour will see it on next dashboard load
-- (acceptable: it's a 4-6 step tooltip overlay with a Skip button on
-- every step, not a forced flow). Users can replay it from
-- Settings → Account → "Restart onboarding tour".
ALTER TABLE "users"
    ADD COLUMN "onboarding_tour_completed" BOOLEAN NOT NULL DEFAULT false;
