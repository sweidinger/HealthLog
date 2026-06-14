-- v1.17.0 — reorder lead time for the medication low-stock alert.
--
-- The low-stock alert previously fired only when the projected runway fell
-- below the user's threshold (default 7 days). For a sparse cadence (e.g. a
-- weekly injection) 7 days is barely one dose-interval, so the warning landed
-- with about one dose left — too late to reorder before the supply ran out.
--
-- `medications.reorder_lead_days` carries an OPTIONAL per-medication reorder
-- lead time (days between placing an order and the new supply arriving). The
-- alert engine adds it, plus one dose-interval, on top of the user threshold
-- so the warning lands before the LAST dose for any cadence. NULL = inherit
-- the per-user `notificationPrefs.medication.reorderLeadDays` default.
--
-- Additive + back-compatible: the column is nullable with no backfill; every
-- existing row keeps NULL and inherits the global default. iOS picks the field
-- up without a migration of its own.

ALTER TABLE "medications"
  ADD COLUMN "reorder_lead_days" INTEGER;
