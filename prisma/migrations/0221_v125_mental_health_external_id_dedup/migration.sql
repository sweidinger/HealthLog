-- v1.25 — iOS parity: durable dedup for mental-health screener administrations.
--
-- The native client queues completed check-ins in an outbox and replays them on
-- reconnect. The 24h idempotency-key window covers a fast retry, but a queued
-- entry can replay long after that window closes. Without a stable client key
-- the replay would mint a duplicate administration AND a duplicate *_SCORE trend
-- point.
--
-- The `source` + `external_id` columns already exist (migration 0213). This adds
-- the DB-level backstop: a partial UNIQUE index over `(user_id, external_id)`
-- restricted to non-NULL externalIds. It deduplicates across sources (a repeat
-- externalId collides regardless of WEB vs IOS), while NULL externalIds (the
-- web path that supplies none) stay unconstrained by the partial predicate.
--
-- The route pre-checks `(user_id, external_id)` and returns the existing row;
-- this index is the race backstop (a concurrent insert surfaces P2002, which
-- the route catches and resolves to the winning row). Idempotent + forward-only;
-- reversible with `DROP INDEX IF EXISTS "mental_health_assessments_user_external_id_unique"`.

CREATE UNIQUE INDEX IF NOT EXISTS "mental_health_assessments_user_external_id_unique"
  ON "mental_health_assessments" ("user_id", "external_id")
  WHERE "external_id" IS NOT NULL;
