-- 0098_app_settings_global_toggles_drift_fix
-- Four `app_settings` columns have been on `prisma/schema.prisma` since the
-- per-channel global notification toggles + admin default-locale work but
-- never landed in the migration history (applied via `prisma db push` to
-- existing environments but not committed as a migration). The drift is
-- invisible on a database kept in sync via `db push`, but a database built
-- from migrations alone is missing the columns — and the admin settings
-- read path (`/api/admin/settings`) selects `default_locale`, so a fresh
-- deploy reports `column "default_locale" does not exist` on first read.
--
-- Same class of drift as 0025_user_locale_drift_fix. Each add uses
-- `IF NOT EXISTS` with the schema default, so the migration is a safe no-op
-- against any environment already carrying the columns and a clean add
-- against one built strictly from this migrations directory (CI test
-- containers, fresh deploys, demo seeds).
ALTER TABLE "app_settings"
  ADD COLUMN IF NOT EXISTS "default_locale" TEXT NOT NULL DEFAULT 'de',
  ADD COLUMN IF NOT EXISTS "telegram_global" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "ntfy_global" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "web_push_global" BOOLEAN NOT NULL DEFAULT true;
