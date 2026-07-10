-- v1.28.16 — explicit `document_only` flag on a clinician share link.
--
-- Until now "this link serves only documents, no health record" was DERIVED at
-- read time as "are all report sections off?" (`hasAnyReportSection`). That
-- coupling is fragile: the day a new report section is added to the prefs shape,
-- an OLD documents-only link — whose frozen `sections_json` never mentions the
-- new key — would resolve the new key from the defaults (ON), the derived check
-- would flip to "has a section", and the link would start serving that section's
-- data. This column makes the guarantee authoritative and frozen at creation, so
-- no future section can silently re-open an existing documents-only link.
ALTER TABLE "clinician_share_links"
  ADD COLUMN "document_only" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: freeze the flag ON for every existing link whose sections are
-- EXPLICITLY all-off (a non-empty object with NO `true` value at ANY depth — the
-- shape the documents-only create flow persisted as `EMPTY_DOCTOR_REPORT_PREFS`).
-- The recursive `$.** ? (@ == true)` JSONPath is deliberate: a record share can
-- store a GROUPED shape (e.g. `{"vitals":{"bp":true}}`) whose only `true` sits in
-- a nested object, so a top-level-only scan would misread it as empty and
-- wrongly pin it documents-only. Checking every depth marks ONLY links that truly
-- enable no section — so this can never remove report access a viewer legitimately
-- had, only pin an already-empty report against a future schema growth. The `{}`
-- case is excluded (empty object = "full-record defaults", NOT documents-only).
-- Safe on a populated table (non-volatile default, no rewrite) and idempotent.
UPDATE "clinician_share_links"
SET "document_only" = true
WHERE jsonb_typeof("sections_json") = 'object'
  AND "sections_json" <> '{}'::jsonb
  AND NOT jsonb_path_exists("sections_json", '$.** ? (@ == true)');
