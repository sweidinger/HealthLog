-- v1.23 — new-device sign-in alert dedupe ledger.
--
-- One row per (user, coarse device fingerprint). The fingerprint
-- (`device_hash`) is a one-way SHA-256 hash of
-- `userId | normalised-User-Agent | coarse-location-or-asn`. The raw
-- User-Agent and IP are NEVER stored — the table holds only the salted hash
-- (the userId is part of the digest input, so the same browser on two
-- accounts produces two unrelated hashes) plus an optional coarse,
-- human-readable `label` for the security-activity surface (e.g.
-- "Firefox on macOS — Berlin, DE"; the label omits the IP).
--
-- A successful sign-in upserts on (user_id, device_hash): the first sighting
-- of a hash inserts the row and fires one new-device notification through the
-- dispatcher; subsequent sightings only bump `last_seen_at` and stay silent.

CREATE TABLE "user_known_devices" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "device_hash" TEXT NOT NULL,
    "label" TEXT,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_known_devices_pkey" PRIMARY KEY ("id")
);

-- Dedupe is per-user: a coarse fingerprint can never be inserted twice for
-- one account, so "first sighting → alert" is a single unique-constrained
-- upsert with no race window.
CREATE UNIQUE INDEX "user_known_devices_user_id_device_hash_key" ON "user_known_devices"("user_id", "device_hash");
CREATE INDEX "user_known_devices_user_id_idx" ON "user_known_devices"("user_id");

ALTER TABLE "user_known_devices" ADD CONSTRAINT "user_known_devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
