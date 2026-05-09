import { describe, expect, it } from "vitest";

import {
  BACKOFF_SCHEDULE_MS,
  MAX_CONSECUTIVE_FAILURES,
  classifyHttpStatus,
  classifyTelegramError,
  nextRetryAt,
  shouldAutoDisableAfterTransient,
} from "@/lib/notifications/retry-policy";

describe("retry-policy: BACKOFF_SCHEDULE_MS", () => {
  it("matches the spec [30s, 5min, 30min, 2h]", () => {
    expect(BACKOFF_SCHEDULE_MS).toEqual([
      30 * 1_000,
      5 * 60 * 1_000,
      30 * 60 * 1_000,
      2 * 60 * 60 * 1_000,
    ]);
  });

  it("is frozen so callers can't mutate the schedule at runtime", () => {
    expect(Object.isFrozen(BACKOFF_SCHEDULE_MS)).toBe(true);
  });
});

describe("retry-policy: nextRetryAt", () => {
  const now = new Date("2026-05-09T12:00:00.000Z");

  it("returns null for the 0th failure (no failure yet → no cooldown)", () => {
    expect(nextRetryAt(0, now)).toBeNull();
  });

  it("schedules 30s after the 1st failure", () => {
    const next = nextRetryAt(1, now);
    expect(next?.getTime()).toBe(now.getTime() + 30 * 1_000);
  });

  it("schedules 5min after the 2nd failure", () => {
    const next = nextRetryAt(2, now);
    expect(next?.getTime()).toBe(now.getTime() + 5 * 60 * 1_000);
  });

  it("schedules 30min after the 3rd failure", () => {
    const next = nextRetryAt(3, now);
    expect(next?.getTime()).toBe(now.getTime() + 30 * 60 * 1_000);
  });

  it("schedules 2h after the 4th failure", () => {
    const next = nextRetryAt(4, now);
    expect(next?.getTime()).toBe(now.getTime() + 2 * 60 * 60 * 1_000);
  });

  it("returns null at the 5th failure (give-up threshold)", () => {
    expect(nextRetryAt(MAX_CONSECUTIVE_FAILURES, now)).toBeNull();
  });

  it("returns null beyond the threshold (defence-in-depth)", () => {
    expect(nextRetryAt(99, now)).toBeNull();
  });
});

describe("retry-policy: shouldAutoDisableAfterTransient", () => {
  it("does not give up before the 5th in-a-row failure", () => {
    expect(shouldAutoDisableAfterTransient(1)).toBe(false);
    expect(shouldAutoDisableAfterTransient(4)).toBe(false);
  });

  it("gives up at exactly the 5th failure", () => {
    expect(shouldAutoDisableAfterTransient(5)).toBe(true);
  });

  it("stays in give-up mode for any larger value", () => {
    expect(shouldAutoDisableAfterTransient(99)).toBe(true);
  });
});

describe("retry-policy: classifyTelegramError", () => {
  it("maps 'chat not found' to a hard reject", () => {
    expect(classifyTelegramError("Bad Request: chat not found")).toEqual({
      hardReject: true,
      reason: "telegram_chat_not_found",
    });
  });

  it("maps 'bot was blocked by the user' to a hard reject", () => {
    expect(
      classifyTelegramError("Forbidden: bot was blocked by the user"),
    ).toEqual({ hardReject: true, reason: "telegram_blocked_by_user" });
  });

  it("maps 'user is deactivated' to a hard reject", () => {
    expect(classifyTelegramError("Forbidden: user is deactivated")).toEqual({
      hardReject: true,
      reason: "telegram_blocked_by_user",
    });
  });

  it("treats undefined / empty descriptions as soft", () => {
    expect(classifyTelegramError(undefined)).toEqual({
      hardReject: false,
      reason: "telegram_send_failed",
    });
    expect(classifyTelegramError("")).toEqual({
      hardReject: false,
      reason: "telegram_send_failed",
    });
  });

  it("treats unrecognized descriptions (5xx-style blips) as soft", () => {
    expect(classifyTelegramError("Internal Server Error")).toEqual({
      hardReject: false,
      reason: "telegram_send_failed",
    });
  });
});

describe("retry-policy: classifyHttpStatus", () => {
  it("treats web-push 410 as a hard reject", () => {
    expect(classifyHttpStatus(410, "web-push")).toEqual({
      hardReject: true,
      reason: "web_push_410_gone",
    });
  });

  it("treats web-push 404 as a hard reject (endpoint deleted)", () => {
    expect(classifyHttpStatus(404, "web-push")).toEqual({
      hardReject: true,
      reason: "web_push_404_endpoint",
    });
  });

  it("treats web-push 429 as a soft reject (so the channel keeps retrying)", () => {
    expect(classifyHttpStatus(429, "web-push")).toEqual({
      hardReject: false,
      reason: "web-push_429",
    });
  });

  it("treats web-push 500 as a soft reject", () => {
    expect(classifyHttpStatus(500, "web-push")).toEqual({
      hardReject: false,
      reason: "web-push_500",
    });
  });

  it("treats ntfy 410 as a hard reject (topic invalidated)", () => {
    expect(classifyHttpStatus(410, "ntfy")).toEqual({
      hardReject: true,
      reason: "ntfy_410_gone",
    });
  });

  it("treats ntfy 404 as soft (could be a wrong topic name, not gone-forever)", () => {
    expect(classifyHttpStatus(404, "ntfy")).toEqual({
      hardReject: false,
      reason: "ntfy_404",
    });
  });

  it("treats undefined status (network error) as a soft reject", () => {
    expect(classifyHttpStatus(undefined, "ntfy")).toEqual({
      hardReject: false,
      reason: "ntfy_network_error",
    });
    expect(classifyHttpStatus(undefined, "web-push")).toEqual({
      hardReject: false,
      reason: "web-push_network_error",
    });
  });
});
