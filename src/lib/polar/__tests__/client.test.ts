import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  POLAR_OAUTH_SCOPE,
  exchangeCode,
  fetchNightlyRecharges,
  getAuthorizationUrl,
  getPolarCredentials,
  getPolarRedirectUri,
  mapActivity,
  mapNightlyRecharge,
  mapSleep,
  registerUser,
  type PolarActivity,
  type PolarNightlyRecharge,
  type PolarSleep,
} from "../client";
import { PolarApiError } from "../response-classifier";

const CREDS = { clientId: "cid", clientSecret: "csecret" };

function installFetchMock(pages: Array<{ status: number; body?: unknown }>) {
  let i = 0;
  const fetchMock = vi.fn(async (...args: [string, RequestInit?]) => {
    void args;
    const page = pages[Math.min(i, pages.length - 1)]!;
    i += 1;
    return {
      status: page.status,
      json: async () => page.body ?? null,
    };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  process.env.POLAR_CLIENT_ID = "env-cid";
  process.env.POLAR_CLIENT_SECRET = "env-secret";
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example";
  delete process.env.POLAR_REDIRECT_URI;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("getPolarCredentials", () => {
  it("reads from env", () => {
    expect(getPolarCredentials()).toEqual({
      clientId: "env-cid",
      clientSecret: "env-secret",
    });
  });
  it("returns null when unconfigured", () => {
    delete process.env.POLAR_CLIENT_ID;
    expect(getPolarCredentials()).toBeNull();
  });
});

describe("getAuthorizationUrl", () => {
  it("builds the Polar authorize URL with scope + state", () => {
    const url = getAuthorizationUrl("signed-state", CREDS);
    expect(url).toContain("flow.polar.com/oauth2/authorization");
    expect(url).toContain("response_type=code");
    expect(url).toContain("scope=accesslink.read_all");
    expect(url).toContain("state=signed-state");
    expect(url).toContain("client_id=cid");
  });
});

describe("getPolarRedirectUri", () => {
  it("derives from app URL when override absent", () => {
    expect(getPolarRedirectUri()).toBe(
      "https://app.example/api/polar/callback",
    );
  });
  it("honours the explicit override", () => {
    process.env.POLAR_REDIRECT_URI = "https://custom/cb";
    expect(getPolarRedirectUri()).toBe("https://custom/cb");
  });
});

describe("exchangeCode", () => {
  it("posts Basic-auth + returns the token and x_user_id", async () => {
    const fetchMock = installFetchMock([
      {
        status: 200,
        body: { access_token: "tok", token_type: "bearer", x_user_id: 42 },
      },
    ]);
    const tok = await exchangeCode("code123", CREDS);
    expect(tok.access_token).toBe("tok");
    expect(tok.x_user_id).toBe(42);
    const [, init] = fetchMock.mock.calls[0]!;
    const headers = init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from("cid:csecret").toString("base64")}`,
    );
    expect(init!.body).toContain("grant_type=authorization_code");
  });

  it("throws a classified PolarApiError on a 401", async () => {
    installFetchMock([{ status: 401, body: { error: "invalid_grant" } }]);
    await expect(exchangeCode("bad", CREDS)).rejects.toBeInstanceOf(
      PolarApiError,
    );
  });
});

describe("registerUser", () => {
  it("treats a 409 (already registered) as success", async () => {
    installFetchMock([{ status: 409, body: {} }]);
    await expect(registerUser("tok", "42")).resolves.toBeUndefined();
  });
  it("succeeds on a 200", async () => {
    installFetchMock([{ status: 200, body: {} }]);
    await expect(registerUser("tok", "42")).resolves.toBeUndefined();
  });
  it("throws on a 500", async () => {
    installFetchMock([{ status: 500 }]);
    await expect(registerUser("tok", "42")).rejects.toBeInstanceOf(
      PolarApiError,
    );
  });
});

describe("fetchNightlyRecharges", () => {
  it("returns [] on a 204 No Content", async () => {
    installFetchMock([{ status: 204 }]);
    expect(await fetchNightlyRecharges("tok", "42")).toEqual([]);
  });
  it("unwraps the recharges array", async () => {
    installFetchMock([
      { status: 200, body: { recharges: [{ date: "2026-06-10" }] } },
    ]);
    const r = await fetchNightlyRecharges("tok", "42");
    expect(r).toHaveLength(1);
    expect(r[0]!.date).toBe("2026-06-10");
  });
});

describe("mapNightlyRecharge", () => {
  it("maps the recovery band to a 0-100 RECOVERY_SCORE", () => {
    const rec: PolarNightlyRecharge = {
      date: "2026-06-10",
      nightly_recharge_status: 6,
      hrv_avg: 55,
      heart_rate_avg: 52.4,
      breathing_rate_avg: 14.2,
    };
    const mapped = mapNightlyRecharge(rec);
    const recovery = mapped.find((m) => m.type === "RECOVERY_SCORE");
    expect(recovery?.value).toBe(100);
    expect(mapped.find((m) => m.type === "HRV_RMSSD")?.value).toBe(55);
    expect(mapped.find((m) => m.type === "RESTING_HEART_RATE")?.value).toBe(52);
    expect(mapped.find((m) => m.type === "RESPIRATORY_RATE")?.value).toBe(14.2);
  });

  it("rescales status 1 -> 0", () => {
    const mapped = mapNightlyRecharge({
      date: "2026-06-10",
      nightly_recharge_status: 1,
    });
    expect(mapped.find((m) => m.type === "RECOVERY_SCORE")?.value).toBe(0);
  });

  it("skips a bad date", () => {
    expect(mapNightlyRecharge({ date: "not-a-date" })).toEqual([]);
  });
});

describe("mapSleep", () => {
  it("maps per-stage durations s->min and the sleep score", () => {
    const s: PolarSleep = {
      date: "2026-06-10",
      light_sleep: 3600,
      deep_sleep: 1800,
      rem_sleep: 5400,
      sleep_score: 82,
    };
    const mapped = mapSleep(s);
    const core = mapped.find((m) => m.sleepStage === "CORE");
    expect(core?.value).toBe(60);
    expect(mapped.find((m) => m.sleepStage === "DEEP")?.value).toBe(30);
    expect(mapped.find((m) => m.sleepStage === "REM")?.value).toBe(90);
    expect(mapped.find((m) => m.type === "SLEEP_PERFORMANCE")?.value).toBe(82);
  });
});

describe("mapActivity", () => {
  it("maps steps and active energy to canonical MeasurementType enum values", () => {
    const a: PolarActivity = {
      date: "2026-06-10",
      "active-steps": 8123,
      "active-calories": 540.6,
      calories: 2400,
    };
    const mapped = mapActivity(a);
    expect(mapped.find((m) => m.type === "ACTIVITY_STEPS")?.value).toBe(8123);
    // ACTIVE portion only — NOT the total `calories` (2400, incl. BMR).
    expect(mapped.find((m) => m.type === "ACTIVE_ENERGY_BURNED")?.value).toBe(
      540.6,
    );
  });
});

describe("POLAR_OAUTH_SCOPE", () => {
  it("is the read-all scope", () => {
    expect(POLAR_OAUTH_SCOPE).toBe("accesslink.read_all");
  });
});
