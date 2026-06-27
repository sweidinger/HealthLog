-- MCP Phase 3 security fix (H2) — revocable, theft-detectable refresh chains.
--
-- The remote MCP OAuth bridge minted stateless `hlrt_` refresh tokens that
-- referenced no server row: they could not be revoked (the settings "revoke"
-- only killed the 60-minute access token) and a replayed, already-rotated
-- refresh token was not treated as theft. This migration adds the persistent
-- anchor the refresh artifact lacked.
--
-- `mcp_oauth_connections` is the revocable unit: one row per connector
-- connection that requested `offline_access`. `current_jti` is the only refresh
-- `jti` valid at any moment — every rotation advances it, so a presented `jti`
-- that is not `current_jti` is a replay (theft signal) that revokes the row.
-- `revoked_at` is the kill switch the settings card flips; revoking the row
-- stops every future refresh.
CREATE TABLE "mcp_oauth_connections" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_name" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "current_jti" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "mcp_oauth_connections_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "mcp_oauth_connections_user_id_idx" ON "mcp_oauth_connections"("user_id");

ALTER TABLE "mcp_oauth_connections" ADD CONSTRAINT "mcp_oauth_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Link each OAuth-minted access token back to its connection so a connection
-- revoke kills every access row it issued, and so the connector token list can
-- exclude the transient access rows (they would otherwise flood it — M2).
ALTER TABLE "api_tokens" ADD COLUMN "mcp_connection_id" TEXT;

CREATE INDEX "api_tokens_mcp_connection_id_idx" ON "api_tokens"("mcp_connection_id");

ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_mcp_connection_id_fkey" FOREIGN KEY ("mcp_connection_id") REFERENCES "mcp_oauth_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;
