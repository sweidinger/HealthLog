-- v1.17.1 — Polar pull-completeness: two native Polar signals get their own
-- MeasurementType so they stop being read off the wire and dropped at the mapper.
--
--   1. `ANS_CHARGE`  — Polar Nightly Recharge `ans_charge`, the HRV-based
--      autonomic-nervous-system charge. The primary differentiated recovery
--      component, distinct from the 1–6 recovery band already mapped to
--      RECOVERY_SCORE.
--   2. `CARDIO_LOAD` — Polar Training Load Pro `cardio_load`, the device-native
--      cardiovascular-strain figure (Polar's WHOOP-day-strain analogue). Kept
--      distinct from DAY_STRAIN (WHOOP 0–21) and the COMPUTED STRAIN_SCORE so
--      each native value keeps its own bucket and scale.
--
-- Purely additive: two enum-extensions on `measurement_type`. No backfill, no
-- column change, no existing row touched. Idempotent (`IF NOT EXISTS`); reruns
-- are safe. Forward-only — Postgres cannot remove an enum value, and with no
-- rows carrying them before the app ships they are inert until the Polar sync
-- writes them.

ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'ANS_CHARGE';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'CARDIO_LOAD';
