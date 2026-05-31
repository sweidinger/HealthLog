import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Provider-timeout fallback for the pulse-status route. When the
 * provider chain does not resolve inside `STATUS_PROVIDER_TIMEOUT_MS`
 * the route returns the deterministic no-key fallback so the
 * InsightStatusCard renders instead of spinning — but it must NOT
 * persist the fallback. The earlier behaviour cached a `timeout-stub`
 * row keyed to today; that stub stuck until midnight and hid the real
 * data-driven assessment. The fix treats a timeout as a transient miss:
 * serve the fallback for this render, write nothing, re-attempt next
 * mount.
 */

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    auditLog: { findFirst: vi.fn(), create: vi.fn() },
    measurement: { findMany: vi.fn() },
    measurementRollup: { findMany: vi.fn() },
    moodEntry: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/insights/status-provider", () => ({
  runStatusCompletion: vi.fn(),
}));

vi.mock("@/lib/insights/memory", () => ({
  getPreviousInsightContext: vi.fn().mockResolvedValue(null),
  formatPreviousContextForPrompt: vi.fn().mockReturnValue(""),
}));

import { prisma } from "@/lib/db";
import { runStatusCompletion } from "@/lib/insights/status-provider";
import { generatePulseStatusForUser } from "../pulse-status";

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.measurementRollup.findMany).mockResolvedValue([] as never);
});

describe("generatePulseStatusForUser — provider timeout fallback", () => {
  it("returns the fallback without persisting a cache row on timeout", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dateOfBirth: null,
      gender: null,
    } as never);
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { value: 72, measuredAt: new Date() },
    ] as never);
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);

    vi.mocked(runStatusCompletion).mockResolvedValue({
      kind: "timeout",
    } as never);

    const result = await generatePulseStatusForUser("user-1", {
      locale: "en",
    });

    expect(result.hasProvider).toBe(true);
    expect(result.cached).toBe(true);
    expect(typeof result.text).toBe("string");
    expect(result.text?.length ?? 0).toBeGreaterThan(0);
    // No persisted row — the sticky-stub bug is gone.
    expect(result.updatedAt).toBeNull();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
