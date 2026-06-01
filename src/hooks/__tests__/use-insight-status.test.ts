import { describe, it, expect } from "vitest";

import {
  nextStatusPollInterval,
  STATUS_POLL_MAX_ATTEMPTS,
} from "../use-insight-status";

/**
 * v1.8.4 — the preparing poll must stop after a bounded number of
 * attempts. A provider can be configured yet have generation fail
 * persistently; without a ceiling the status card polls an open page
 * forever (battery / network waste). `nextStatusPollInterval` is the
 * shared decision both the hook and the inline medication-compliance
 * query route through, so locking its contract covers both sites.
 */
describe("nextStatusPollInterval — v1.8.4 poll ceiling", () => {
  it("does not poll a terminal payload (preparing absent/false)", () => {
    expect(nextStatusPollInterval(undefined, 1)).toBe(false);
    expect(nextStatusPollInterval(false, 1)).toBe(false);
    // A terminal `no-provider` / settled payload never carries preparing,
    // so it stops immediately regardless of attempt count.
    expect(nextStatusPollInterval(false, 0)).toBe(false);
  });

  it("keeps polling while preparing and below the cap", () => {
    expect(nextStatusPollInterval(true, 0)).toBeTypeOf("number");
    expect(nextStatusPollInterval(true, 1)).toBeTypeOf("number");
    expect(
      nextStatusPollInterval(true, STATUS_POLL_MAX_ATTEMPTS - 1),
    ).toBeTypeOf("number");
  });

  it("stops polling once the attempt cap is reached", () => {
    expect(nextStatusPollInterval(true, STATUS_POLL_MAX_ATTEMPTS)).toBe(false);
    expect(
      nextStatusPollInterval(true, STATUS_POLL_MAX_ATTEMPTS + 5),
    ).toBe(false);
  });

  it("returns a positive interval while it polls", () => {
    const interval = nextStatusPollInterval(true, 0);
    expect(interval).not.toBe(false);
    expect(interval as number).toBeGreaterThan(0);
  });
});
