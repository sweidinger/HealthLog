/**
 * v1.4.15 Phase B2, criterion 3 — admin Telegram alert formatting.
 *
 * The state-machine threshold tests live in `status.test.ts` (when
 * does the alert fire?). This file proves WHAT the alert looks like
 * — the message body the maintainer sees on Telegram when an integration
 * starts crashing for one of his users.
 *
 * The formatter is a pure function so we can test deterministically
 * without touching Prisma or the dispatcher.
 */
import { describe, it, expect } from "vitest";

import { formatAdminAlertPayload } from "../status";

describe("formatAdminAlertPayload — Withings re-auth", () => {
  it("uses the integration display name (Withings, not 'withings')", () => {
    const out = formatAdminAlertPayload({
      userId: "u-1",
      integration: "withings",
      kind: "reauth_required",
      message: "Withings refresh error: 100 - invalid_grant",
      errorCode: "100",
      consecutiveFailures: 3,
      subjectLabel: "user@example.com",
    });
    expect(out.title).toBe("Withings sync failing for user@example.com");
    expect(out.message).toContain("Withings sync has failed 3 times in a row");
    expect(out.message).toContain("re-auth required");
    expect(out.message).toContain("(100)");
    expect(out.message).toContain(
      "Action: ask the user to reconnect the integration.",
    );
  });

  it("falls back to userId when no email/subjectLabel provided", () => {
    const out = formatAdminAlertPayload({
      userId: "user-no-email",
      integration: "withings",
      kind: "transient",
      message: "Withings refresh error: 503 - upstream",
      errorCode: "503",
      consecutiveFailures: 5,
    });
    expect(out.title).toBe("Withings sync failing for user-no-email");
  });
});

describe("formatAdminAlertPayload — moodLog transient", () => {
  it("uses 'moodLog' display name and the 'investigate the upstream service.' action", () => {
    const out = formatAdminAlertPayload({
      userId: "u-2",
      integration: "moodlog",
      kind: "transient",
      message: "moodLog sync HTTP 502",
      errorCode: "http_502",
      consecutiveFailures: 4,
      subjectLabel: "marc@example.com",
    });
    expect(out.title).toBe("moodLog sync failing for marc@example.com");
    expect(out.message).toContain("Action: investigate the upstream service.");
    expect(out.message).toContain("(http_502)");
  });
});

describe("formatAdminAlertPayload — message trimming", () => {
  it("trims a 4 KB stack trace down to 280 chars + ellipsis", () => {
    const longMessage = "stack: " + "x".repeat(4000);
    const out = formatAdminAlertPayload({
      userId: "u-3",
      integration: "withings",
      kind: "transient",
      message: longMessage,
      errorCode: undefined,
      consecutiveFailures: 3,
      subjectLabel: "user@example.com",
    });
    // Body line includes the trimmed message — full 4 KB MUST NOT
    // appear, but the start of the message MUST.
    expect(out.message).toContain("stack: ");
    expect(out.message).not.toContain("x".repeat(280));
    expect(out.message).toContain("...");
    // Whole message under 4096 (Telegram cap).
    expect(out.message.length).toBeLessThan(4096);
  });

  it("does NOT add an ellipsis when message is under the trim threshold", () => {
    const out = formatAdminAlertPayload({
      userId: "u-4",
      integration: "withings",
      kind: "transient",
      message: "short error",
      errorCode: undefined,
      consecutiveFailures: 3,
      subjectLabel: "user@example.com",
    });
    expect(out.message).toContain("short error");
    expect(out.message).not.toMatch(/short error\.\.\./);
  });
});

describe("formatAdminAlertPayload — metadata payload", () => {
  it("returns the metadata block with affectedUserId, consecutiveFailures, errorCode (or null)", () => {
    const withCode = formatAdminAlertPayload({
      userId: "u-5",
      integration: "withings",
      kind: "transient",
      message: "503",
      errorCode: "503",
      consecutiveFailures: 3,
    });
    expect(withCode.metadata).toEqual({
      integration: "withings",
      affectedUserId: "u-5",
      consecutiveFailures: 3,
      errorCode: "503",
    });

    const withoutCode = formatAdminAlertPayload({
      userId: "u-6",
      integration: "moodlog",
      kind: "transient",
      message: "blip",
      errorCode: undefined,
      consecutiveFailures: 7,
    });
    expect(withoutCode.metadata).toEqual({
      integration: "moodlog",
      affectedUserId: "u-6",
      consecutiveFailures: 7,
      errorCode: null,
    });
  });
});

describe("formatAdminAlertPayload — omits errorCode parens when undefined", () => {
  it("does not render '(undefined)' when no errorCode is supplied", () => {
    const out = formatAdminAlertPayload({
      userId: "u-7",
      integration: "withings",
      kind: "transient",
      message: "network reset",
      errorCode: undefined,
      consecutiveFailures: 3,
      subjectLabel: "user@example.com",
    });
    expect(out.message).not.toContain("(undefined)");
    expect(out.message).toContain("transient error — network reset");
  });
});
