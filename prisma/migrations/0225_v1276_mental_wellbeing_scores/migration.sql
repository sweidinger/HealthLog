-- v1.27.6 — mental-wellbeing score rows become server-owned.
--
-- The `PHQ9_SCORE` / `GAD7_SCORE` enum values exist since 0213; the screener
-- route has projected each completed administration onto a Measurement row
-- from the start. Those rows were attributed `MANUAL`, which is a
-- client-writable source — the projection is a server-derived value (the sum
-- over the encrypted item answers), so it now writes `COMPUTED`, the same
-- server-owned source RECOVERY_SCORE uses. Clients cannot attribute COMPUTED
-- on any write surface, so a forged score trend point cannot enter through
-- the measurement POST.
--
-- Re-attribute the existing projection rows so the trend is uniformly
-- server-owned. Scoped to the `assessment:` externalId prefix the route
-- stamps: a hand-entered score row a user may have logged deliberately
-- through the generic measurement form keeps its MANUAL attribution.
-- Idempotent, forward-only.
UPDATE "measurements"
SET "source" = 'COMPUTED'
WHERE "type" IN ('PHQ9_SCORE', 'GAD7_SCORE')
  AND "source" = 'MANUAL'
  AND "external_id" LIKE 'assessment:%';
