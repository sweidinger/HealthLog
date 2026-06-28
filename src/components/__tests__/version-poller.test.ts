/**
 * Unit tests for the version-poller decision.
 *
 * The guard is keyed on the TARGET (live) version: a repeat mismatch
 * against the SAME version is suppressed (no loop on a misset server),
 * but a SECOND deploy in one session moves the live version past the
 * recorded one and the flow re-arms.
 *
 * The runtime behaviour — a detected bump surfaces a Reload toast and
 * never reloads the page on its own — lives in `version-poller.tsx`:
 * the service-worker eviction + `location.reload()` run only from the
 * toast action's `onClick`, so an in-progress form or chat draft is
 * never destroyed unprompted.
 */

import { describe, expect, it } from "vitest";

import { resolveVersionPollDecision } from "../version-poller";

describe("resolveVersionPollDecision", () => {
  it("is up-to-date when live matches the shell", () => {
    expect(resolveVersionPollDecision("1.16.8", "1.16.8", null)).toBe(
      "up-to-date",
    );
  });

  it("is up-to-date when the live version cannot be read", () => {
    expect(resolveVersionPollDecision(null, "1.16.8", null)).toBe("up-to-date");
  });

  it("reloads on a mismatch with no prior attempt", () => {
    expect(resolveVersionPollDecision("1.16.9", "1.16.8", null)).toBe("reload");
  });

  it("suppresses a repeat reload for the SAME target version", () => {
    expect(resolveVersionPollDecision("1.16.9", "1.16.8", "1.16.9")).toBe(
      "already-attempted",
    );
  });

  it("re-arms when a SECOND deploy moves the live version past the recorded one", () => {
    expect(resolveVersionPollDecision("1.16.10", "1.16.8", "1.16.9")).toBe(
      "reload",
    );
  });

  it("treats a legacy timestamp guard value as no attempt", () => {
    // Pre-v1.16.8 sessions stored `String(Date.now())`; it never matches
    // a real version string, so a stranded session heals on its next poll.
    expect(
      resolveVersionPollDecision("1.16.9", "1.16.8", "1765400000000"),
    ).toBe("reload");
  });
});
