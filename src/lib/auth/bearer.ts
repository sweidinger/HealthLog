/**
 * Canonical Bearer-token validation — the single source of truth for resolving
 * a raw `hlk_<hex>` token to a user.
 *
 * Extracted from `api-handler.ts` so it can be reused outside a Next.js request
 * scope (the local MCP stdio transport runs in a plain Node process and must not
 * drag `next/server` / `next/headers` / the Wide-Event machinery into its import
 * graph). The HTTP edge (`requireAuth` → `authenticateBearer`) and the MCP edge
 * both call this one function, so the revoked / expired / scope / `lastUsedAt`
 * semantics can never drift between the two wires.
 *
 * This module is deliberately lean: it depends only on the HMAC hasher and
 * Prisma. Audit-log emission + Wide-Event annotation stay with each caller (the
 * HTTP path keeps its existing `auth.bearer.*` audit trail), so this layer adds
 * no I/O beyond the two reads the validation needs.
 */
import type { User } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { hashToken } from "@/lib/auth/hmac";

/** Why a Bearer token was rejected. Stable handles for audit details. */
export type BearerAuthReason =
  | "unknown_token"
  | "revoked"
  | "expired"
  | "insufficient_permissions"
  | "user_missing";

/**
 * Thrown when a token fails validation. Carries the HTTP status the HTTP edge
 * should surface plus the machine `reason` (and, when known, the owning
 * `userId` / `tokenId`) so a caller can write a faithful audit entry without
 * re-deriving them.
 */
export class BearerAuthError extends Error {
  constructor(
    public readonly statusCode: 401 | 403,
    public readonly reason: BearerAuthReason,
    public readonly userId?: string,
    public readonly tokenId?: string,
  ) {
    super(reason);
    this.name = "BearerAuthError";
  }
}

/** The validated identity behind a Bearer token. */
export interface BearerResolution {
  user: User;
  /** The `ApiToken` row id (the token-id half of the `<user>:<token>` binding). */
  tokenId: string;
  /** The token's granted scopes (`["*"]` = wildcard). */
  permissions: string[];
  /** Token expiry, or a 30-day fallback window when the token has no fixed expiry. */
  expiresAt: Date;
}

/**
 * Resolve a raw `hlk_<hex>` token to its user, or throw `BearerAuthError`.
 *
 * Lookups are by HMAC hash only — the plaintext token is never compared against
 * a stored value. When `requiredPermission` is set, a non-wildcard token must
 * list it; an unset `requiredPermission` admits any valid token (matching the
 * "route declares no scope ⇒ authentication alone is sufficient" contract).
 *
 * `lastUsedAt` is refreshed fire-and-forget on success.
 */
export async function resolveBearerToken(
  rawToken: string,
  requiredPermission?: string,
): Promise<BearerResolution> {
  const tokenHashValue = hashToken(rawToken);

  const apiToken = await prisma.apiToken.findUnique({
    where: { tokenHash: tokenHashValue },
    select: {
      id: true,
      userId: true,
      permissions: true,
      revoked: true,
      expiresAt: true,
    },
  });

  if (!apiToken) {
    throw new BearerAuthError(401, "unknown_token");
  }

  if (apiToken.revoked) {
    throw new BearerAuthError(401, "revoked", apiToken.userId, apiToken.id);
  }

  if (apiToken.expiresAt && apiToken.expiresAt <= new Date()) {
    throw new BearerAuthError(401, "expired", apiToken.userId, apiToken.id);
  }

  // `["*"]` is the wildcard scope. A route that declares no `requiredPermission`
  // accepts any valid token; one that declares a scope accepts wildcard tokens
  // and narrow-scope tokens that list that scope.
  const hasWildcardPermission = apiToken.permissions.includes("*");
  if (
    requiredPermission &&
    !hasWildcardPermission &&
    !apiToken.permissions.includes(requiredPermission)
  ) {
    throw new BearerAuthError(
      403,
      "insufficient_permissions",
      apiToken.userId,
      apiToken.id,
    );
  }

  const user = await prisma.user.findUnique({
    where: { id: apiToken.userId },
  });

  if (!user) {
    throw new BearerAuthError(
      401,
      "user_missing",
      apiToken.userId,
      apiToken.id,
    );
  }

  // Fire-and-forget: refresh lastUsedAt without blocking the caller.
  prisma.apiToken
    .update({
      where: { id: apiToken.id },
      data: { lastUsedAt: new Date() },
    })
    .catch(() => {});

  const expiresAt =
    apiToken.expiresAt ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  return {
    user,
    tokenId: apiToken.id,
    permissions: apiToken.permissions,
    expiresAt,
  };
}
