-- v1.22.0 — Biomarker catalog: per-marker "hidden" flag.
--
-- A marker the user no longer needs is hidden rather than deleted: it leaves
-- the active catalog list and the lab-entry pickers, but its readings and its
-- canonical unit/reference-range definition survive (unhide restores it). A
-- plain additive boolean column with a server-side default; no existing row is
-- touched (every back-filled row defaults to visible). `IF NOT EXISTS` makes
-- the rerun safe.
ALTER TABLE "biomarkers" ADD COLUMN IF NOT EXISTS "hidden" BOOLEAN NOT NULL DEFAULT false;
