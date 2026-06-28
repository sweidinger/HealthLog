/**
 * v1.25 — the briefing failure marker drives the read path's "couldn't
 * refresh" signal WITHOUT touching the cached briefing text. These tests pin
 * that a marker newer than the last successful generation reads as a failure,
 * an older one is treated as superseded, and a write failure never throws.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const findFirst = vi.fn();
const create = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    auditLog: {
      findFirst: (...a: unknown[]) => findFirst(...a),
      create: (...a: unknown[]) => create(...a),
    },
  },
}));

import {
  readBriefingFailure,
  recordBriefingFailure,
  BRIEFING_FAILURE_ACTION,
} from "../briefing-failure-marker";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("readBriefingFailure", () => {
  it("returns the failure when the marker is newer than the last success", async () => {
    findFirst.mockResolvedValue({
      createdAt: new Date("2026-06-28T10:00:00Z"),
      details: JSON.stringify({ reason: "provider-error" }),
    });

    const result = await readBriefingFailure({
      userId: "u1",
      since: new Date("2026-06-28T09:00:00Z"),
    });

    expect(result).toEqual(
      expect.objectContaining({ reason: "provider-error" }),
    );
  });

  it("treats a marker older than the last success as superseded", async () => {
    findFirst.mockResolvedValue({
      createdAt: new Date("2026-06-28T08:00:00Z"),
      details: JSON.stringify({ reason: "provider-error" }),
    });

    const result = await readBriefingFailure({
      userId: "u1",
      since: new Date("2026-06-28T09:00:00Z"),
    });

    expect(result).toBeNull();
  });

  it("returns null when no marker exists", async () => {
    findFirst.mockResolvedValue(null);
    expect(await readBriefingFailure({ userId: "u1", since: null })).toBeNull();
  });
});

describe("recordBriefingFailure", () => {
  it("writes an append-only marker row under the failure action", async () => {
    create.mockResolvedValue({});
    await recordBriefingFailure({
      userId: "u1",
      reason: "timeout",
      locale: "en",
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "u1",
          action: BRIEFING_FAILURE_ACTION,
        }),
      }),
    );
  });

  it("never throws when the write fails", async () => {
    create.mockRejectedValue(new Error("db down"));
    await expect(
      recordBriefingFailure({ userId: "u1", reason: "timeout" }),
    ).resolves.toBeUndefined();
  });
});
