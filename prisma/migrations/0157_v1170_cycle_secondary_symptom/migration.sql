-- v1.17.0 — symptothermal SECONDARY-symptom choice: cervical mucus (default)
-- OR cervix observation, mirroring the Sensiplan/NFP double-check where the
-- temperature primary sign pairs with one chosen second indicator.
--
-- `cycle_profiles.secondary_symptom` picks which second sign the engine uses
-- (MUCUS default | CERVIX); the casual user keeps temperature + mucus and never
-- sees the choice (it lives behind the advanced cycle settings).
--
-- `cycle_day_logs` gains the three standard Sensiplan cervix signs — position
-- (LOW/HIGH), firmness (FIRM/SOFT), opening/os (CLOSED/OPEN) — used as the
-- secondary indicator when secondary_symptom = CERVIX. Fertile = HIGH+SOFT+OPEN;
-- infertile (closure) = LOW+FIRM+CLOSED.
--
-- Additive + back-compatible: every existing profile backfills MUCUS (the prior
-- behaviour) and every existing day-log row keeps NULL cervix signs. iOS
-- inherits the fields without a migration of its own.

CREATE TYPE "secondary_symptom" AS ENUM ('MUCUS', 'CERVIX');
CREATE TYPE "cervix_position" AS ENUM ('LOW', 'HIGH');
CREATE TYPE "cervix_firmness" AS ENUM ('FIRM', 'SOFT');
CREATE TYPE "cervix_opening" AS ENUM ('CLOSED', 'OPEN');

ALTER TABLE "cycle_profiles"
  ADD COLUMN "secondary_symptom" "secondary_symptom" NOT NULL DEFAULT 'MUCUS';

ALTER TABLE "cycle_day_logs"
  ADD COLUMN "cervix_position" "cervix_position",
  ADD COLUMN "cervix_firmness" "cervix_firmness",
  ADD COLUMN "cervix_opening" "cervix_opening";
