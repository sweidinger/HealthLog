import { describe, it, expect, vi, beforeEach } from "vitest";

// The queue send is inspected through a fake global boss so the debounce key +
// payload can be asserted without a running worker.
const sendMock = vi.fn();
let bossInstance: { send: typeof sendMock } | null = { send: sendMock };
vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: () => bossInstance,
}));

// Module gate + tz resolver are stubbed; the tz FORMAT helpers stay real so the
// "last night in the profile tz" logic is exercised for real.
const resolveModuleMapMock = vi.fn(
  async (): Promise<Record<string, boolean>> => ({}),
);
vi.mock("@/lib/modules/gate", () => ({
  resolveModuleMap: () => resolveModuleMapMock(),
}));

let tz = "America/Los_Angeles";
vi.mock("@/lib/tz/resolver", () => ({
  resolveUserTimezone: async () => tz,
}));

const userFindUniqueMock = vi.fn(
  async (): Promise<{ morningDigestRefreshedOn: string | null } | null> => ({
    morningDigestRefreshedOn: null,
  }),
);
vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: () => userFindUniqueMock() } },
}));

import {
  isLastNightLocal,
  maybeEnqueueMorningRefresh,
} from "../morning-refresh-trigger";

describe("isLastNightLocal", () => {
  it("counts a segment whose LOCAL date is yesterday but whose UTC date is today", () => {
    // LA (UTC-7 in July). now = 07:00 local on the 16th.
    const now = new Date("2026-07-16T14:00:00Z");
    // 06:00Z = 23:00 local on the 15th → yesterday LOCALLY, but the 16th in UTC.
    const measuredAt = new Date("2026-07-16T06:00:00Z");
    expect(isLastNightLocal(measuredAt, now, "America/Los_Angeles")).toBe(true);
  });

  it("counts a this-morning segment across the UTC date line (Auckland)", () => {
    // Auckland (UTC+12). now = 12:30 local on the 16th; the segment is 06:00
    // local on the 16th (this morning) but 15th in UTC — a naive UTC-day check
    // would wrongly reject it.
    const now = new Date("2026-07-16T00:30:00Z");
    const measuredAt = new Date("2026-07-15T18:00:00Z");
    expect(isLastNightLocal(measuredAt, now, "Pacific/Auckland")).toBe(true);
  });

  it("rejects an old backfilled segment", () => {
    const now = new Date("2026-07-16T14:00:00Z");
    const measuredAt = new Date("2026-07-10T06:00:00Z");
    expect(isLastNightLocal(measuredAt, now, "America/Los_Angeles")).toBe(
      false,
    );
  });

  it("rejects a future-dated sample", () => {
    const now = new Date("2026-07-16T14:00:00Z");
    const measuredAt = new Date("2026-07-16T20:00:00Z");
    expect(isLastNightLocal(measuredAt, now, "America/Los_Angeles")).toBe(
      false,
    );
  });
});

describe("maybeEnqueueMorningRefresh", () => {
  const NOW = new Date("2026-07-16T14:00:00Z"); // 07:00 on the 16th in LA
  const lastNight = new Date("2026-07-16T06:00:00Z"); // 23:00 on the 15th, LA
  const oldNight = new Date("2026-07-10T06:00:00Z");

  beforeEach(() => {
    sendMock.mockReset();
    bossInstance = { send: sendMock };
    tz = "America/Los_Angeles";
    resolveModuleMapMock.mockReset();
    resolveModuleMapMock.mockResolvedValue({});
    userFindUniqueMock.mockReset();
    userFindUniqueMock.mockResolvedValue({ morningDigestRefreshedOn: null });
  });

  it("enqueues exactly one debounced refresh for many last-night samples", async () => {
    await maybeEnqueueMorningRefresh(
      "u1",
      [lastNight, lastNight, lastNight, lastNight],
      NOW,
    );
    expect(sendMock).toHaveBeenCalledTimes(1);
    const [queue, payload, opts] = sendMock.mock.calls[0]!;
    expect(queue).toBe("morning-digest-refresh");
    // The debounce key + payload date are the user's LOCAL date (the 16th),
    // not the UTC date of the samples.
    expect(payload).toMatchObject({ userId: "u1", localDate: "2026-07-16" });
    expect((opts as { singletonKey: string }).singletonKey).toBe(
      "morning-refresh:u1:2026-07-16",
    );
  });

  it("does NOT trigger for an old/backfilled sleep only", async () => {
    await maybeEnqueueMorningRefresh("u1", [oldNight, oldNight], NOW);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("no-ops when the sleep module is off", async () => {
    resolveModuleMapMock.mockResolvedValue({ sleep: false });
    await maybeEnqueueMorningRefresh("u1", [lastNight], NOW);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("skips the enqueue when the day is already finalised (marker == today)", async () => {
    userFindUniqueMock.mockResolvedValue({
      morningDigestRefreshedOn: "2026-07-16",
    });
    await maybeEnqueueMorningRefresh("u1", [lastNight], NOW);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("no-ops with no sleep samples", async () => {
    await maybeEnqueueMorningRefresh("u1", [], NOW);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("never throws when a dependency fails", async () => {
    resolveModuleMapMock.mockRejectedValue(new Error("db down"));
    await expect(
      maybeEnqueueMorningRefresh("u1", [lastNight], NOW),
    ).resolves.toBeUndefined();
    expect(sendMock).not.toHaveBeenCalled();
  });
});
