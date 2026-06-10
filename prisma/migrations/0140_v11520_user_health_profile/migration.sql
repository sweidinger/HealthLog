-- v1.15.20 — user-authored "about me" self-description for the AI surfaces.
--
-- 1:1 with users, lazily created on first save. The free text is encrypted
-- at rest (AES-256-GCM through the shared Bytes codec, the CoachFact
-- precedent) — `about_me_encrypted` carries the `"<keyId>.<base64>"`
-- ciphertext as UTF-8 bytes and is NULL when the user cleared (or never
-- wrote) the text. Additive + non-destructive.
CREATE TABLE "user_health_profiles" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "about_me_encrypted" BYTEA,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_health_profiles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_health_profiles_user_id_key" ON "user_health_profiles"("user_id");

ALTER TABLE "user_health_profiles"
  ADD CONSTRAINT "user_health_profiles_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
