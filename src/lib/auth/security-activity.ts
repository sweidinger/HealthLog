/**
 * v1.23 — security-activity feed. The SHARED read both the account-security
 * surface and the data-sovereignty privacy dashboard consume: a user-scoped,
 * read-only window onto the `AuditLog` rows that matter for account security —
 * logins, MFA events, password changes, token/session revocations, exports,
 * and deletions. No new storage: it reuses the existing
 * `@@index([userId, action, createdAt(sort: Desc)])`.
 */

/**
 * Whether an audit action belongs in the user-facing security-activity feed.
 * Pure so the contract can be unit-tested without a DB:
 *   - every `auth.*` event (login, mfa, password, token, bearer, session,
 *     register),
 *   - every export action (`export.download`, `health-record.export`,
 *     `user.export.*` — all contain "export"),
 *   - the two erasure actions (`user.account.delete`, `user.data.clear`).
 */
export function matchesSecurityActivity(action: string): boolean {
  return (
    action.startsWith("auth.") ||
    action.includes("export") ||
    action === "user.account.delete" ||
    action === "user.data.clear"
  );
}

/**
 * Prisma `where` mirror of `matchesSecurityActivity`, scoped to one user. Kept
 * alongside the predicate so the two never drift.
 */
export function securityActivityWhere(userId: string) {
  return {
    userId,
    OR: [
      { action: { startsWith: "auth." } },
      { action: { contains: "export" } },
      { action: { in: ["user.account.delete", "user.data.clear"] } },
    ],
  };
}
