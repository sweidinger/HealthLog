import { describe, expect, it } from "vitest";

import { isChannelInCooldown } from "@/lib/notifications/channel-state";

describe("channel-state: isChannelInCooldown", () => {
  const now = new Date("2026-05-09T12:00:00.000Z");

  it("returns false when nextRetryAt is null", () => {
    expect(isChannelInCooldown({ nextRetryAt: null }, now)).toBe(false);
  });

  it("returns true when nextRetryAt is in the future", () => {
    expect(
      isChannelInCooldown(
        { nextRetryAt: new Date(now.getTime() + 60_000) },
        now,
      ),
    ).toBe(true);
  });

  it("returns false when nextRetryAt is in the past", () => {
    expect(
      isChannelInCooldown(
        { nextRetryAt: new Date(now.getTime() - 60_000) },
        now,
      ),
    ).toBe(false);
  });

  it("returns false when nextRetryAt is exactly now (boundary: cooldown is over)", () => {
    expect(isChannelInCooldown({ nextRetryAt: now }, now)).toBe(false);
  });
});
