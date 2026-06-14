import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  OURA_OAUTH_SCOPE,
  exchangeCode,
  fetchReadiness,
  getAuthorizationUrl,
  getOuraCredentials,
  mapDailyActivity,
  mapDailySleep,
  mapDailySpo2,
  mapReadiness,
  mapSleep,
  refreshAccessToken,
  type OuraDailyActivity,
  type OuraDailySleep,
  type OuraDailySpo2,
  type OuraReadiness,
  type OuraSleep,
} from "../client";
import { OuraApiError } from "../response-classifier";

const CREDS = { clientId: "cid", clientSecret: "csecret" };

function installFetchMock(pages: Array<{ status: number; body?: unknown }>) {
  let i = 0;
  const fetchMock = vi.fn(async (...args: [string, RequestInit?]) => {
    void args;
    const page = pages[Math.min(i, pages.length - 1)]!;
    i += 1;
    return { status: page.status, json: async () => page.body ?? null };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  process.env.OURA_CLIENT_ID = "env-cid";
  process.env.OURA_CLIENT_SECRET = "env-secret";
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example";
  delete process.env.OURA_REDIRECT_URI;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("getOuraCredentials", () => {
  it("reads env", () => {
    expect(getOuraCredentials()).toEqual({
      clientId: "env-cid",
      clientSecret: "env-secret",
    });
  });
  it("null when unconfigured", () => {
    delete process.env.OURA_CLIENT_SECRET;
    expect(getOuraCredentials()).toBeNull();
  });
});

describe("getAuthorizationUrl", () => {
  it("builds the Oura authorize URL", () => {
    const url = getAuthorizationUrl("signed", CREDS);
    expect(url).toContain("cloud.ouraring.com/oauth/authorize");
    expect(url).toContain("scope=daily+personal");
    expect(url).toContain("state=signed");
  });
});

describe("exchangeCode / refreshAccessToken", () => {
  it("exchanges a code for an access + refresh token", async () => {
    installFetchMock([
      {
        status: 200,
        body: { access_token: "a", refresh_token: "r", expires_in: 86400 },
      },
    ]);
    const t = await exchangeCode("code", CREDS);
    expect(t.access_token).toBe("a");
    expect(t.refresh_token).toBe("r");
  });

  it("rotates tokens on refresh", async () => {
    const fetchMock = installFetchMock([
      {
        status: 200,
        body: { access_token: "a2", refresh_token: "r2", expires_in: 86400 },
      },
    ]);
    const t = await refreshAccessToken("r1", CREDS);
    expect(t.refresh_token).toBe("r2");
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init!.body).toContain("grant_type=refresh_token");
  });

  it("throws OuraApiError on a 400 invalid_grant", async () => {
    installFetchMock([{ status: 400, body: { error: "invalid_grant" } }]);
    await expect(refreshAccessToken("dead", CREDS)).rejects.toBeInstanceOf(
      OuraApiError,
    );
  });
});

describe("fetchReadiness pagination", () => {
  it("walks next_token across pages", async () => {
    installFetchMock([
      {
        status: 200,
        body: { data: [{ id: "1", day: "2026-06-09", score: 70 }], next_token: "abc" },
      },
      {
        status: 200,
        body: { data: [{ id: "2", day: "2026-06-10", score: 80 }], next_token: null },
      },
    ]);
    const r = await fetchReadiness("tok", {
      startDate: "2026-06-01",
      endDate: "2026-06-10",
    });
    expect(r).toHaveLength(2);
  });
});

describe("mapReadiness", () => {
  it("maps score -> RECOVERY_SCORE", () => {
    const r: OuraReadiness = { id: "1", day: "2026-06-10", score: 84 };
    const mapped = mapReadiness(r);
    expect(mapped.find((m) => m.type === "RECOVERY_SCORE")).toMatchObject({
      value: 84,
      fieldTag: "recovery",
    });
  });
  it("maps temperature_deviation -> BODY_TEMPERATURE_DEVIATION (signed °C)", () => {
    const r: OuraReadiness = {
      id: "1",
      day: "2026-06-10",
      score: 70,
      temperature_deviation: -0.42,
    };
    const mapped = mapReadiness(r);
    const dev = mapped.find((m) => m.type === "BODY_TEMPERATURE_DEVIATION");
    expect(dev).toMatchObject({ value: -0.42, unit: "celsius", fieldTag: "temp_deviation" });
  });
  it("emits the temperature deviation even when the score is absent", () => {
    const mapped = mapReadiness({
      id: "1",
      day: "2026-06-10",
      score: null,
      temperature_deviation: 0.3,
    });
    expect(mapped).toHaveLength(1);
    expect(mapped[0].type).toBe("BODY_TEMPERATURE_DEVIATION");
  });
  it("skips a record with no score and no temperature", () => {
    expect(mapReadiness({ id: "1", day: "2026-06-10", score: null })).toEqual([]);
  });
});

describe("mapSleep", () => {
  it("falls back to stage totals (no hypnogram) and record-scopes the externalId", () => {
    const s: OuraSleep = {
      id: "rec-9",
      day: "2026-06-10",
      light_sleep_duration: 3600,
      deep_sleep_duration: 1800,
      rem_sleep_duration: 5400,
      awake_time: 600,
      efficiency: 91,
      average_hrv: 48,
      lowest_heart_rate: 49,
      average_breath: 14.5,
    };
    const mapped = mapSleep(s);
    expect(mapped.find((m) => m.sleepStage === "CORE")?.value).toBe(60);
    expect(mapped.find((m) => m.sleepStage === "AWAKE")?.value).toBe(10);
    expect(mapped.find((m) => m.type === "SLEEP_EFFICIENCY")?.value).toBe(91);
    expect(mapped.find((m) => m.type === "HRV_RMSSD")?.value).toBe(48);
    expect(mapped.find((m) => m.type === "RESTING_HEART_RATE")?.value).toBe(49);
    expect(mapped.find((m) => m.type === "RESPIRATORY_RATE")?.value).toBe(14.5);
    // B2 — every sleep row is record-scoped so a nap never overwrites the main.
    expect(
      mapped.every((m) => m.externalId?.startsWith("sleep:rec-9:")),
    ).toBe(true);
  });

  it("emits a real timed timeline from sleep_phase_5_min (reconstructed=false)", () => {
    // 2× deep (1), 3× light (2), 1× rem (3), 1× awake (4) = 7 five-min intervals.
    const s: OuraSleep = {
      id: "rec-T",
      day: "2026-06-10",
      bedtime_start: "2026-06-09T23:00:00.000Z",
      bedtime_end: "2026-06-10T07:00:00.000Z",
      sleep_phase_5_min: "1122234",
    };
    const mapped = mapSleep(s).filter((m) => m.type === "SLEEP_DURATION");
    // Four contiguous runs → four segments, in onset order.
    expect(mapped.map((m) => m.sleepStage)).toEqual([
      "DEEP",
      "CORE",
      "REM",
      "AWAKE",
    ]);
    // Run lengths × 5 min: 2→10, 3→15, 1→5, 1→5.
    expect(mapped.map((m) => m.value)).toEqual([10, 15, 5, 5]);
    // Each segment stamped at its own END instant relative to bedtime_start.
    const onset = new Date("2026-06-09T23:00:00.000Z").getTime();
    expect(mapped[0].measuredAt.getTime()).toBe(onset + 10 * 60_000);
    expect(mapped[1].measuredAt.getTime()).toBe(onset + 25 * 60_000);
    // Distinct, record-scoped, segment-indexed externalIds (no collapse).
    const ids = mapped.map((m) => m.externalId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe("sleep:rec-T:seg:0");
  });

  it("ignores an empty / malformed hypnogram and uses stage totals", () => {
    const s: OuraSleep = {
      id: "rec-E",
      day: "2026-06-10",
      bedtime_start: "2026-06-09T23:00:00.000Z",
      sleep_phase_5_min: "",
      deep_sleep_duration: 1800,
    };
    const mapped = mapSleep(s).filter((m) => m.type === "SLEEP_DURATION");
    expect(mapped).toHaveLength(1);
    expect(mapped[0].sleepStage).toBe("DEEP");
    expect(mapped[0].fieldTag).toBe("sleep_deep");
  });
});

describe("mapDailyActivity", () => {
  it("maps steps, active energy, and equivalent walking distance (m)", () => {
    const a: OuraDailyActivity = {
      id: "1",
      day: "2026-06-10",
      steps: 9001,
      active_calories: 412,
      equivalent_walking_distance: 6543,
    };
    const mapped = mapDailyActivity(a);
    expect(mapped.find((m) => m.type === "ACTIVITY_STEPS")?.value).toBe(9001);
    expect(mapped.find((m) => m.type === "ACTIVE_ENERGY_BURNED")?.value).toBe(
      412,
    );
    const dist = mapped.find((m) => m.type === "WALKING_RUNNING_DISTANCE");
    expect(dist).toMatchObject({ value: 6543, unit: "m", fieldTag: "distance" });
  });
});

describe("mapDailySleep", () => {
  it("maps the Sleep Score -> SLEEP_SCORE", () => {
    const d: OuraDailySleep = { id: "1", day: "2026-06-10", score: 82 };
    const mapped = mapDailySleep(d);
    expect(mapped).toHaveLength(1);
    expect(mapped[0]).toMatchObject({
      type: "SLEEP_SCORE",
      value: 82,
      unit: "score",
      fieldTag: "sleep_score",
    });
  });
  it("skips a record with no score", () => {
    expect(mapDailySleep({ id: "1", day: "2026-06-10", score: null })).toEqual(
      [],
    );
  });
});

describe("mapDailySpo2", () => {
  it("maps the average SpO2 -> OXYGEN_SATURATION", () => {
    const s: OuraDailySpo2 = {
      id: "1",
      day: "2026-06-10",
      spo2_percentage: { average: 96.8 },
    };
    const mapped = mapDailySpo2(s);
    expect(mapped).toHaveLength(1);
    expect(mapped[0]).toMatchObject({
      type: "OXYGEN_SATURATION",
      value: 96.8,
      unit: "%",
      fieldTag: "spo2",
    });
  });
  it("skips a record with no average", () => {
    expect(
      mapDailySpo2({ id: "1", day: "2026-06-10", spo2_percentage: { average: null } }),
    ).toEqual([]);
  });
});

describe("OURA_OAUTH_SCOPE", () => {
  it("requests daily + personal", () => {
    expect(OURA_OAUTH_SCOPE).toBe("daily personal");
  });
});
