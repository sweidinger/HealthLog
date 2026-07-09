-- Medication efficacy tracking ("Wirkung"): persist ONLY the user's explicit
-- target override.
--
--   `medication_efficacy_targets` — a lean child of `medications`. The
--   drug-class → outcome resolution (WHO ATC-prefix → whole-word name
--   inference) is computed each read from the closed in-repo lookup table, so
--   nothing about a class→outcome association is denormalised (it cannot drift
--   as the map improves). The ONE thing that must survive is the user's own
--   pick when they retarget a medication or choose a target for a med the
--   resolver could not classify — that is this table.
--
--   Exactly one of `measurement_type` (a first-class metric series) /
--   `biomarker_id` (a lab analyte) is set per row; `primary` marks the
--   storyline-leading target when several are pinned. `medication_id`
--   cascades (the override dies with the medication); `biomarker_id` sets
--   null (a deleted biomarker leaves an orphan row the resolver treats as no
--   override). `user_id` is never a column here — ownership is narrowed
--   through the parent medication, never a body field.
--
-- Additive; applies clean on a 0231 database and on a fresh database as part
-- of the ordered migration chain.

CREATE TABLE "medication_efficacy_targets" (
  "id" TEXT NOT NULL,
  "medication_id" TEXT NOT NULL,
  "measurement_type" "measurement_type",
  "biomarker_id" TEXT,
  "primary" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "medication_efficacy_targets_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "medication_efficacy_targets_medication_id_idx"
  ON "medication_efficacy_targets" ("medication_id");

CREATE INDEX "medication_efficacy_targets_biomarker_id_idx"
  ON "medication_efficacy_targets" ("biomarker_id");

ALTER TABLE "medication_efficacy_targets"
  ADD CONSTRAINT "medication_efficacy_targets_medication_id_fkey"
  FOREIGN KEY ("medication_id") REFERENCES "medications" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "medication_efficacy_targets"
  ADD CONSTRAINT "medication_efficacy_targets_biomarker_id_fkey"
  FOREIGN KEY ("biomarker_id") REFERENCES "biomarkers" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
