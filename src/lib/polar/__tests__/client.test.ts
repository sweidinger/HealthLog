import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  POLAR_OAUTH_SCOPE,
  exchangeCode,
  fetchCardioLoads,
  fetchNightlyRecharges,
  fetchSpo2,
  getAuthorizationUrl,
  getPolarCredentials,
  getPolarRedirectUri,
  mapActivity,
  mapCardioLoad,
  mapNightlyRecharge,
  mapSleep,
  mapSpo2,
  registerUser,
  type PolarActivity,
  type PolarCardioLoad,
  type PolarNightlyRecharge,
  type PolarSleep,
  type PolarSpo2,
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

  it("maps ans_charge to ANS_CHARGE (through-as-is, negative allowed)", () => {
    const mapped = mapNightlyRecharge({
      date: "2026-06-10",
      ans_charge: -3.42,
    });
    const ans = mapped.find((m) => m.type === "ANS_CHARGE");
    expect(ans?.value).toBe(-3.42);
    expect(ans?.unit).toBe("score");
    expect(ans?.fieldTag).toBe("ans_charge");
  });

  it("keeps a zero ans_charge (baseline is a valid reading)", () => {
    const mapped = mapNightlyRecharge({ date: "2026-06-10", ans_charge: 0 });
    expect(mapped.find((m) => m.type === "ANS_CHARGE")?.value).toBe(0);
  });

  it("omits ANS_CHARGE when ans_charge is absent", () => {
    const mapped = mapNightlyRecharge({
      date: "2026-06-10",
      nightly_recharge_status: 3,
    });
    expect(mapped.find((m) => m.type === "ANS_CHARGE")).toBeUndefined();
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
      sleep_start_time: "2026-06-09T23:00:00+02:00",
      sleep_end_time: "2026-06-10T07:00:00+02:00",
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

  it("lays a reconstructed END-instant timeline from the sleep window", () => {
    const start = "2026-06-09T23:00:00+02:00"; // 21:00 UTC
    const s: PolarSleep = {
      date: "2026-06-10",
      sleep_start_time: start,
      sleep_end_time: "2026-06-10T07:00:00+02:00", // 05:00 UTC
      light_sleep: 3600, // 60 min
      deep_sleep: 1800, // 30 min
      rem_sleep: 5400, // 90 min
      sleep_score: 82,
    };
    const mapped = mapSleep(s);
    const onset = Date.parse(start);
    const core = mapped.find((m) => m.sleepStage === "CORE")!;
    const deep = mapped.find((m) => m.sleepStage === "DEEP")!;
    const rem = mapped.find((m) => m.sleepStage === "REM")!;

    // Each segment ends at its own instant, laid contiguously from onset:
    // CORE ends at +60m, DEEP at +90m, REM at +180m.
    expect(core.measuredAt.getTime()).toBe(onset + 60 * 60_000);
    expect(deep.measuredAt.getTime()).toBe(onset + 90 * 60_000);
    expect(rem.measuredAt.getTime()).toBe(onset + 180 * 60_000);

    // Distinct instants → an ordered hypnogram (the F1 fix), not three
    // coincident midnight-UTC points.
    const instants = new Set(
      [core, deep, rem].map((m) => m.measuredAt.getTime()),
    );
    expect(instants.size).toBe(3);

    // Reconstructed flag + indexed externalId keep the segment rows distinct.
    expect(core.reconstructed).toBe(true);
    expect(core.externalId).toBe("sleep:2026-06-10:seg:sleep_core:0");
    expect(rem.externalId).toBe("sleep:2026-06-10:seg:sleep_rem:2");

    // IN_BED envelope + score stamp at the sleep END instant.
    const endMs = Date.parse("2026-06-10T07:00:00+02:00");
    const inBed = mapped.find((m) => m.sleepStage === "IN_BED")!;
    expect(inBed.measuredAt.getTime()).toBe(endMs);
    expect(inBed.value).toBe(480); // 8 h
    expect(
      mapped.find((m) => m.type === "SLEEP_PERFORMANCE")!.measuredAt.getTime(),
    ).toBe(endMs);
  });

  it("emits an AWAKE segment from total_interruption_duration", () => {
    const start = "2026-06-09T23:00:00+02:00"; // 21:00 UTC
    const s: PolarSleep = {
      date: "2026-06-10",
      sleep_start_time: start,
      sleep_end_time: "2026-06-10T07:00:00+02:00",
      total_interruption_duration: 900, // 15 min awake
      light_sleep: 3600, // 60 min
      deep_sleep: 1800, // 30 min
      rem_sleep: 5400, // 90 min
      sleep_score: 82,
    };
    const mapped = mapSleep(s);
    const onset = Date.parse(start);

    // AWAKE is laid first (leading settling-in block), so the asleep stages
    // partition the rest of the window and the night reader can surface real
    // awake time + efficiency rather than a fully consolidated night.
    const awake = mapped.find((m) => m.sleepStage === "AWAKE")!;
    expect(awake).toBeDefined();
    expect(awake.value).toBe(15);
    expect(awake.reconstructed).toBe(true);
    expect(awake.externalId).toBe("sleep:2026-06-10:seg:sleep_awake:0");
    // AWAKE ends at +15m; CORE then starts there and is index 1.
    expect(awake.measuredAt.getTime()).toBe(onset + 15 * 60_000);

    const core = mapped.find((m) => m.sleepStage === "CORE")!;
    expect(core.externalId).toBe("sleep:2026-06-10:seg:sleep_core:1");
    expect(core.measuredAt.getTime()).toBe(onset + (15 + 60) * 60_000);
  });

  it("omits AWAKE when no interruption time is reported", () => {
    const mapped = mapSleep({
      date: "2026-06-10",
      sleep_start_time: "2026-06-09T23:00:00+02:00",
      sleep_end_time: "2026-06-10T07:00:00+02:00",
      light_sleep: 3600,
      deep_sleep: 1800,
      rem_sleep: 5400,
    });
    expect(mapped.find((m) => m.sleepStage === "AWAKE")).toBeUndefined();
    // CORE stays index 0 when AWAKE is absent.
    expect(mapped.find((m) => m.sleepStage === "CORE")!.externalId).toBe(
      "sleep:2026-06-10:seg:sleep_core:0",
    );
  });

  it("falls back to a midnight-UTC anchor when the window is missing", () => {
    const mapped = mapSleep({
      date: "2026-06-10",
      light_sleep: 3600,
      sleep_score: 80,
    });
    const core = mapped.find((m) => m.sleepStage === "CORE")!;
    expect(core.measuredAt.toISOString()).toBe("2026-06-10T00:00:00.000Z");
    expect(core.reconstructed).toBeUndefined();
    // No IN_BED envelope without a window.
    expect(mapped.find((m) => m.sleepStage === "IN_BED")).toBeUndefined();
  });
});

describe("mapActivity — distance", () => {
  it("maps distance_from_steps to WALKING_RUNNING_DISTANCE in metres", () => {
    const a: PolarActivity = {
      date: "2026-06-10",
      "active-steps": 8000,
      distance_from_steps: 4590.53,
    };
    const dist = mapActivity(a).find(
      (m) => m.type === "WALKING_RUNNING_DISTANCE",
    );
    expect(dist?.value).toBe(4590.53);
    expect(dist?.unit).toBe("meters");
  });
});

describe("mapCardioLoad", () => {
  it("maps cardio_load to CARDIO_LOAD", () => {
    const c: PolarCardioLoad = { date: "2026-06-10", cardio_load: 123.45 };
    const mapped = mapCardioLoad(c);
    expect(mapped[0]?.type).toBe("CARDIO_LOAD");
    expect(mapped[0]?.value).toBe(123.45);
    expect(mapped[0]?.unit).toBe("score");
  });
  it("keeps a zero cardio_load and skips a missing one", () => {
    expect(mapCardioLoad({ date: "2026-06-10", cardio_load: 0 })[0]?.value).toBe(
      0,
    );
    expect(mapCardioLoad({ date: "2026-06-10" })).toEqual([]);
  });
});

describe("mapSpo2", () => {
  it("maps blood_oxygen_percentage to OXYGEN_SATURATION (percent)", () => {
    const r: PolarSpo2 = { date: "2026-06-10", blood_oxygen_percentage: 96.4 };
    const mapped = mapSpo2(r);
    expect(mapped[0]?.type).toBe("OXYGEN_SATURATION");
    expect(mapped[0]?.value).toBe(96.4);
    expect(mapped[0]?.unit).toBe("%");
  });
  it("rejects out-of-range readings", () => {
    expect(mapSpo2({ date: "2026-06-10", blood_oxygen_percentage: 0 })).toEqual(
      [],
    );
    expect(
      mapSpo2({ date: "2026-06-10", blood_oxygen_percentage: 120 }),
    ).toEqual([]);
  });
});

describe("fetchCardioLoads", () => {
  it("unwraps the cardio-loads array", async () => {
    installFetchMock([
      { status: 200, body: { "cardio-loads": [{ date: "2026-06-10" }] } },
    ]);
    const r = await fetchCardioLoads("tok", "42");
    expect(r).toHaveLength(1);
  });
});

describe("fetchSpo2", () => {
  it("unwraps the tests array", async () => {
    installFetchMock([
      { status: 200, body: { tests: [{ date: "2026-06-10" }] } },
    ]);
    const r = await fetchSpo2("tok", "42");
    expect(r).toHaveLength(1);
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
