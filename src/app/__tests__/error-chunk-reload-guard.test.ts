/**
 * Unit tests for the chunk-error auto-reload guard in `src/app/error.tsx`.
 *
 * The guard is keyed on the running shell's build version: one reload
 * attempt per BROKEN SHELL, not one per session. After a successful
 * heal the reloaded page carries the new version and the guard re-arms
 * by construction; the pre-v1.16.8 once-per-session key exhausted on
 * multi-deploy days and stranded the user on the error page.
 */

import { describe, expect, it } from "vitest";

import { chunkReloadGuardValue, shouldAttemptChunkReload } from "../error";

describe("shouldAttemptChunkReload", () => {
  it("reloads when no attempt is recorded", () => {
    expect(shouldAttemptChunkReload(null, "1.16.8")).toBe(true);
  });

  it("suppresses a second reload for the SAME shell version", () => {
    const stored = chunkReloadGuardValue("1.16.8");
    expect(shouldAttemptChunkReload(stored, "1.16.8")).toBe(false);
  });

  it("re-arms after a deploy — the reloaded shell carries a NEW version", () => {
    const stored = chunkReloadGuardValue("1.16.8");
    expect(shouldAttemptChunkReload(stored, "1.16.9")).toBe(true);
  });

  it("treats a legacy timestamp guard value as no attempt", () => {
    // Pre-v1.16.8 sessions stored `String(Date.now())`; it never matches
    // a guard value, so a stranded session heals on its next chunk error.
    expect(shouldAttemptChunkReload("1765400000000", "1.16.8")).toBe(true);
  });

  it("degrades to once-per-shell-lifetime when no version is injected", () => {
    expect(chunkReloadGuardValue("")).toBe("unversioned");
    expect(shouldAttemptChunkReload(null, "")).toBe(true);
    expect(shouldAttemptChunkReload("unversioned", "")).toBe(false);
  });
});
