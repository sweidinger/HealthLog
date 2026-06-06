-- Optional 1-4 Likert intensity per symptom link. NULL preserves the
-- pre-severity presence-link contract for every existing row.
ALTER TABLE "cycle_symptom_links" ADD COLUMN "severity" INTEGER;
