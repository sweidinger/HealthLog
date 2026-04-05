-- AlterTable: Remove openai_key_encrypted, add Codex OAuth fields to users
ALTER TABLE "users" DROP COLUMN "openai_key_encrypted";

ALTER TABLE "users" ADD COLUMN "codex_access_token_encrypted" TEXT;
ALTER TABLE "users" ADD COLUMN "codex_refresh_token_encrypted" TEXT;
ALTER TABLE "users" ADD COLUMN "codex_token_expires_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "codex_connected_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "codex_connection_status" TEXT NOT NULL DEFAULT 'disconnected';

-- AlterTable: Add admin AI provider fields to app_settings
ALTER TABLE "app_settings" ADD COLUMN "admin_ai_key_encrypted" TEXT;
ALTER TABLE "app_settings" ADD COLUMN "admin_ai_model" TEXT NOT NULL DEFAULT 'gpt-4o-mini';
ALTER TABLE "app_settings" ADD COLUMN "admin_ai_base_url" TEXT NOT NULL DEFAULT 'https://api.openai.com/v1';
