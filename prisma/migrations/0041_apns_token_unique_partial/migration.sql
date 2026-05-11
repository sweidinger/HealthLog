-- v1.4.23 W6 reconcile — global uniqueness for `devices.apns_token`.
--
-- Apple's APNs contract guarantees one token per (device, app) — two
-- Device rows pointing at the same `apns_token` would mean the same
-- physical iPhone is registered twice and `sendViaApns()` would fan a
-- single notification out twice, double-charging APNs quota and
-- spamming the user.
--
-- Pair this DDL with the route-side fix in `POST /api/devices` that
-- drops `NOT: { userId }` from the cross-user-hijack guard so the
-- same-user collision path returns the existing 200 idempotent upsert
-- response, and the cross-user collision path keeps its existing 409.
--
-- Strictly additive at the rolling-upgrade boundary:
--   * The new partial unique index covers ONLY `apns_token IS NOT NULL`,
--     so the historical reality of multiple Device rows with NULL
--     `apns_token` (legacy iOS builds without the APNs handshake) stays
--     valid.
--   * The old non-unique `devices_apns_token_idx` is dropped because
--     the partial unique index supersedes it for the dispatcher's
--     per-user lookup.
--   * The CHECK from migration 0037 (token + environment paired) is
--     unaffected.
--
-- If a duplicate row exists in production at upgrade time the migration
-- will fail loudly — that's the intended signal that an iOS install
-- collision is already corrupting deliveries.

CREATE UNIQUE INDEX "devices_apns_token_unique"
  ON "devices" ("apns_token")
  WHERE "apns_token" IS NOT NULL;

DROP INDEX IF EXISTS "devices_apns_token_idx";
