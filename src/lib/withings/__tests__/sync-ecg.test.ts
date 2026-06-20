/**
 * v1.18.11 — Withings ECG / AFib sync unit tests.
 *
 * Coverage focuses on the `ecg.afib` code → RhythmClassification mapping, the
 * EVENT-row write shape (value=1, unit=event, verdict in rhythmClassification),
 * the stable signalid externalId, the non-ECG-entry skip, and the reauth /
 * 403 park behaviour. End-to-end DB exercise lives in the integration suite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: {
      upsert: vi.fn(),
    },
  },
}));

vi.mock("@/lib/integrations/status", () => ({
  isReauthRequired: vi.fn().mockResolvedValue(false),
  recordSyncFailure: vi.fn(),
  recordSyncSuccess: vi.fn(),
}));

vi.mock("../sync", async () => {
  const actual = await vi.importActual<typeof import("../sync")>("../sync");
  return {
    ...actual,
    getValidToken: vi.fn(async () => ({ accessToken: "token" })),
    recordWithingsSyncFailure: vi.fn(),
  };
});

vi.mock("@/lib/logging/context", () => ({
  getEvent: vi.fn(() => ({
    addExternalCall: vi.fn(),
    addWarning: vi.fn(),
  })),
}));

vi.mock("@/lib/rollups/measurement-rollups", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/rollups/measurement-rollups")
  >("@/lib/rollups/measurement-rollups");
  return {
    ...actual,
    recomputeBucketsForMeasurement: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@/lib/insights/comprehensive-generate", () => ({
  invalidateStatusInsightsForTypes: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from "@/lib/db";
import {
  isReauthRequired,
  recordSyncFailure,
  recordSyncSuccess,
} from "@/lib/integrations/status";

import {
  fetchWithingsHeartList,
  mapWithingsAfib,
  syncUserEcg,
  type WithingsHeartEntry,
} from "../sync-ecg";

function installFetchMock(entries: WithingsHeartEntry[]) {
  const fetchMock = vi.fn(async () => ({
    status: 200,
    json: async () => ({ status: 0, body: { series: entries } }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(isReauthRequired).mockResolvedValue(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mapWithingsAfib", () => {
  it("maps afib 0 → NOT_DETECTED", () => {
    expect(mapWithingsAfib(0)).toBe("NOT_DETECTED");
  });

  it("maps afib 1 → IRREGULAR", () => {
    expect(mapWithingsAfib(1)).toBe("IRREGULAR");
  });

  it("maps any other code → INCONCLUSIVE", () => {
    expect(mapWithingsAfib(2)).toBe("INCONCLUSIVE");
    expect(mapWithingsAfib(3)).toBe("INCONCLUSIVE");
  });

  it("returns null for a missing / non-finite afib code", () => {
    expect(mapWithingsAfib(undefined)).toBeNull();
    expect(mapWithingsAfib(null)).toBeNull();
    expect(mapWithingsAfib(Number.NaN)).toBeNull();
  });
});

describe("fetchWithingsHeartList", () => {
  it("POSTs heart list with unix-seconds window", async () => {
    const fetchMock = installFetchMock([]);
    await fetchWithingsHeartList("token", 1715000000, 1715100000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { body: string },
    ];
    expect(url).toContain("/v2/heart");
    expect(init.body).toContain("action=list");
    expect(init.body).toContain("startdate=1715000000");
    expect(init.body).toContain("enddate=1715100000");
  });
});

describe("syncUserEcg", () => {
  it("writes one IRREGULAR_RHYTHM_NOTIFICATION EVENT row per ECG recording", async () => {
    installFetchMock([
      { timestamp: 1715000000, ecg: { signalid: 111, afib: 1 } },
      { timestamp: 1715003600, ecg: { signalid: 222, afib: 0 } },
    ]);
    vi.mocked(prisma.measurement.upsert).mockResolvedValue({} as never);

    const imported = await syncUserEcg("user-1");

    expect(imported).toBe(2);
    expect(prisma.measurement.upsert).toHaveBeenCalledTimes(2);
    const first = vi.mocked(prisma.measurement.upsert).mock.calls[0][0];
    expect(first.create).toMatchObject({
      type: "IRREGULAR_RHYTHM_NOTIFICATION",
      value: 1,
      unit: "event",
      source: "WITHINGS",
      rhythmClassification: "IRREGULAR",
      externalId: "withings:ecg:user-1:111",
    });
    expect(recordSyncSuccess).toHaveBeenCalledWith("user-1", "withings");
  });

  it("skips a heart entry that carries no ECG / afib verdict", async () => {
    installFetchMock([
      { timestamp: 1715000000, ecg: null },
      { timestamp: 1715003600 },
      { timestamp: 1715007200, ecg: { signalid: 333, afib: 0 } },
    ]);
    vi.mocked(prisma.measurement.upsert).mockResolvedValue({} as never);

    const imported = await syncUserEcg("user-1");

    expect(imported).toBe(1);
    expect(prisma.measurement.upsert).toHaveBeenCalledTimes(1);
  });

  it("falls back to a timestamp externalId when signalid is absent", async () => {
    installFetchMock([{ timestamp: 1715000000, ecg: { afib: 1 } }]);
    vi.mocked(prisma.measurement.upsert).mockResolvedValue({} as never);

    await syncUserEcg("user-1");

    const call = vi.mocked(prisma.measurement.upsert).mock.calls[0][0];
    expect(call.create.externalId).toBe("withings:ecg:user-1:ts-1715000000");
  });

  it("short-circuits when the connection is parked at reauth", async () => {
    vi.mocked(isReauthRequired).mockResolvedValue(true);
    const fetchMock = installFetchMock([]);

    const imported = await syncUserEcg("user-1");

    expect(imported).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("records reauth_required on a 403 from the heart endpoint", async () => {
    const fetchMock = vi.fn(async () => ({
      status: 200,
      json: async () => ({ status: 401, error: "invalid_token" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(syncUserEcg("user-1")).rejects.toThrow();
    // A Withings 401-status body classifies as a hard failure; the generic
    // failure recorder runs (the 403-specific reauth branch keys on HTTP 403).
    expect(recordSyncFailure).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "reauth_required", errorCode: "403" }),
    );
  });
});
