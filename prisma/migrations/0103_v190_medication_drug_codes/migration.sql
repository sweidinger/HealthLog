-- v1.9.0 — optional drug-classification codes on the medication row.
--
-- Two additive, nullable, NULL-defaulted columns on `medications`:
--
--   * `atc_code`    — the WHO ATC active-substance class (e.g. "A10BX10").
--                     Emitted on the FHIR `MedicationStatement` /
--                     `MedicationAdministration` `medicationCodeableConcept`
--                     under the system URI `http://www.whocc.no/atc`.
--   * `rxnorm_code` — the RxNorm RxCUI (US identifier). Secondary coding
--                     under `http://www.nlm.nih.gov/research/umls/rxnorm`.
--
-- Both are user/clinician-asserted, never machine-guessed: a wrong code
-- is a clinical-safety problem, an absent code is merely a (conformant)
-- text-only concept. The application validates the format on write
-- (ATC `^[A-Z]\d{2}[A-Z]{2}\d{2}$`, RxCUI `^\d+$`) and 422s on a
-- malformed value; the DB column is a plain nullable TEXT field.
--
-- No backfill — pre-v1.9.0 rows read NULL, which the exporter treats
-- identically to an absent value (the medicationCodeableConcept stays
-- text-only, the pre-v1.9.0 shape).
--
-- Idempotent guards (`IF NOT EXISTS`) make reruns safe. Forward-only.
--
-- Reversibility:
--   ALTER TABLE "medications" DROP COLUMN IF EXISTS "atc_code";
--   ALTER TABLE "medications" DROP COLUMN IF EXISTS "rxnorm_code";
-- A roll-back loses the captured codes; the FHIR export falls back to the
-- text-only medicationCodeableConcept and the application reads tolerate a
-- missing column / NULL value.
--
-- No index — reads are per-user at request time (`WHERE user_id = $1`),
-- matching the other display-identity columns on the same table.

ALTER TABLE "medications"
    ADD COLUMN IF NOT EXISTS "atc_code" TEXT;

ALTER TABLE "medications"
    ADD COLUMN IF NOT EXISTS "rxnorm_code" TEXT;
