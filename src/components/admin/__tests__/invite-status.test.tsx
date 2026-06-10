/**
 * v1.16.0 — admin invite table: status-derivation precedence.
 *
 * revoked > exhausted > expired > active. Revocation must win even on
 * a row that is also expired/exhausted, because the badge documents
 * the admin's action; exhaustion beats expiry because "it was fully
 * used" is the more informative fact.
 */
import { describe, expect, it } from "vitest";

import { deriveInviteStatus } from "../invite-tokens-section";

const NOW = new Date("2026-06-10T12:00:00Z");
const FUTURE = new Date(NOW.getTime() + 86_400_000).toISOString();
const PAST = new Date(NOW.getTime() - 86_400_000).toISOString();

describe("deriveInviteStatus", () => {
  it("revoked wins over every other state", () => {
    expect(
      deriveInviteStatus(
        { uses: 5, maxUses: 1, expiresAt: PAST, revokedAt: PAST },
        NOW,
      ),
    ).toBe("revoked");
  });

  it("exhausted beats expired", () => {
    expect(
      deriveInviteStatus(
        { uses: 1, maxUses: 1, expiresAt: PAST, revokedAt: null },
        NOW,
      ),
    ).toBe("exhausted");
  });

  it("expired when past expiry with uses left", () => {
    expect(
      deriveInviteStatus(
        { uses: 0, maxUses: 1, expiresAt: PAST, revokedAt: null },
        NOW,
      ),
    ).toBe("expired");
  });

  it("active otherwise", () => {
    expect(
      deriveInviteStatus(
        { uses: 0, maxUses: 1, expiresAt: FUTURE, revokedAt: null },
        NOW,
      ),
    ).toBe("active");
  });
});
