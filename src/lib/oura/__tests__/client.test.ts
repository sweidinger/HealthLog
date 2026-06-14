import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  OURA_OAUTH_SCOPE,
  exchangeCode,
  fetchReadiness,
  getAuthorizationUrl,
  getOuraCredentials,
  mapDailyActivity,
  mapReadiness,
  mapSleep,
  refreshAccessToken,
  type OuraDailyActivity,
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
    expect(mapped).toHaveLength(1);
    expect(mapped[0]).toMatchObject({ type: "RECOVERY_SCORE", value: 84, fieldTag: "recovery" });
  });
  it("skips a record with no score", () => {
    expect(mapReadiness({ id: "1", day: "2026-06-10", score: null })).toEqual([]);
  });
});

describe("mapSleep", () => {
  it("maps stages s->min, efficiency, hrv, rhr, breath", () => {
    const s: OuraSleep = {
      id: "1",
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
  });
});

describe("mapDailyActivity", () => {
  it("maps steps and active energy", () => {
    const a: OuraDailyActivity = {
      id: "1",
      day: "2026-06-10",
      steps: 9001,
      active_calories: 412,
    };
    const mapped = mapDailyActivity(a);
    expect(mapped.find((m) => m.type === "ACTIVITY_STEPS")?.value).toBe(9001);
    expect(mapped.find((m) => m.type === "ACTIVE_ENERGY_BURNED")?.value).toBe(
      412,
    );
  });
});

describe("OURA_OAUTH_SCOPE", () => {
  it("requests daily + personal", () => {
    expect(OURA_OAUTH_SCOPE).toBe("daily personal");
  });
});
