/**
 * v1.4.15 H4 — sessionStorage keys used by the dashboard tour
 * launcher must be scoped per user id. Without scoping, an admin
 * impersonating a second user (or a family member sharing the
 * browser) inherited the first user's "tour dismissed for this
 * session" flag and the tour silently no-op'd for the second user.
 *
 * The two key-builders are exported so this lock-test pins the wire
 * format. Changing them is a soft compatibility break — every
 * already-rendered tab would re-fire the tour for the user once,
 * because the un-prefixed legacy keys are never read again. We
 * accept that one-off tax in exchange for the multi-tenant
 * correctness.
 */
import { describe, expect, it } from "vitest";
import { tourReferrerKey, tourSessionDismissedKey } from "../tour-launcher";

describe("tour-launcher sessionStorage key scoping", () => {
  it("scopes the dismiss key by user id", () => {
    expect(tourSessionDismissedKey("u_abc")).toBe(
      "healthlog-tour-session-dismissed:u_abc",
    );
  });

  it("scopes the referrer key by user id", () => {
    expect(tourReferrerKey("u_abc")).toBe("healthlog-tour-referrer:u_abc");
  });

  it("returns distinct keys for distinct users", () => {
    expect(tourSessionDismissedKey("u_alice")).not.toBe(
      tourSessionDismissedKey("u_bob"),
    );
    expect(tourReferrerKey("u_alice")).not.toBe(tourReferrerKey("u_bob"));
  });

  it("does not collide with the legacy un-scoped keys", () => {
    expect(tourSessionDismissedKey("u_x")).not.toBe(
      "healthlog-tour-session-dismissed",
    );
    expect(tourReferrerKey("u_x")).not.toBe("healthlog-tour-referrer");
  });
});
