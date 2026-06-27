/**
 * MCP scope model.
 *
 * The MCP wire reuses the existing `hlk_<hex>` Bearer tokens as its auth
 * substrate (no parallel identity system). Two scope handles frame the
 * least-privilege contract:
 *
 *   - `health:read`  — read the user's own health data. The default MCP posture.
 *   - `health:write` — mutate (log a measurement / intake / mood). Reserved for
 *     the write tools, which are NOT registered in this milestone phase.
 *
 * Read tools impose no scope requirement of their own: every underlying read
 * path is already an unscoped authenticated route, so a narrow-scope token works
 * and a wildcard token is never required (REQ-SEC-5). The strong "read-only by
 * default" guarantee (REQ-SEC-1 / ADR-003) is structural — only read tools are
 * registered — not a runtime flag a future token could flip. Write registration
 * (a later phase) gates on `health:write` via `tokenAllowsWrite`.
 */

/** Wildcard scope — grants every capability the token model can express. */
export const SCOPE_WILDCARD = "*";

/** Read the authenticated user's own health data over MCP. */
export const SCOPE_HEALTH_READ = "health:read";

/** Mutate the authenticated user's data over MCP (reserved; no write tools yet). */
export const SCOPE_HEALTH_WRITE = "health:write";

/**
 * Whether a token's scopes admit the read surface. Any valid token qualifies —
 * the underlying reads are unscoped — so this is permissive by design and exists
 * to document the contract and to give a single place to tighten later.
 */
export function tokenAllowsRead(): boolean {
  return true;
}

/**
 * Whether a token's scopes admit the write surface. A token must carry the
 * explicit `health:write` scope (or the wildcard). Used to decide whether write
 * tools are registered for a session.
 */
export function tokenAllowsWrite(permissions: readonly string[]): boolean {
  return (
    permissions.includes(SCOPE_WILDCARD) ||
    permissions.includes(SCOPE_HEALTH_WRITE)
  );
}

/**
 * The `<user_id>:<token_id>` binding (REQ-SEC-11). Identifies a session by the
 * user AND the specific token presented — never the user alone — so audit,
 * annotation, and (later phases) rate-limit buckets are keyed to the credential
 * actually in use.
 */
export function sessionBinding(userId: string, tokenId: string): string {
  return `${userId}:${tokenId}`;
}
