-- v1.17.1 — persist the onboarding goal selection.
--
-- The GoalsChipPicker step let the user toggle goal slugs, but both
-- Skip and Next discarded the selection — the picker was decorative.
-- This adds the `onboarding_goals` text array the dead code already
-- referenced, so the selection can seed dashboard tile pinning and
-- reminder suggestions.
--
-- Purely-additive: one new column on `users`, NOT NULL with a `'{}'`
-- (empty array) default, so every existing row keeps "no preference"
-- without a backfill pass. The column is a personalization seed, not a
-- clinical target store.

ALTER TABLE "users"
  ADD COLUMN "onboarding_goals" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
