import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FITBIT_API_BASE,
  FITBIT_FIELD_MAP,
  FITBIT_OAUTH_SCOPE,
  exchangeCode,
  fetchSleepRange,
  fetchSpo2Range,
  fetchWeightRange,
  generatePkcePair,
  getAuthorizationUrl,
  mapActiveCalories,
  mapBodyFat,
  mapDistance,
  mapFitbitSleepStage,
  mapFitbitSportType,
  mapFloors,
  mapHeartRateVariability,
  mapOxygenSaturation,
  mapRespiratoryRate,
  mapRestingHeartRate,
  mapSleepSession,
  mapSteps,
  mapVo2Max,
  mapWeight,
  mapWorkout,
  parseVo2Max,
  readActivityList,
  readSleepSessions,
  refreshAccessToken,
  resolveFitbitUserId,
} from "../client";

const CREDS = { clientId: "cid", clientSecret: "csecret" };

/** Stub global fetch with a queue of `{ status, body }` responses. */
function installFetchMock(pages: Array<{ status: number; body: unknown }>) {
  let i = 0;
  const fetchMock = vi.fn(async () => {
    const page = pages[Math.min(i, pages.length - 1)]!;
    i += 1;
    return {
      status: page.status,
      json: async () => page.body,
    };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// The redirect_uri allowlist requires a configured, absolute https app origin.
const PRIOR_APP_URL = process.env.NEXT_PUBLIC_APP_URL;
beforeEach(() => {
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.test";
});

afterEach(() => {
  if (PRIOR_APP_URL === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = PRIOR_APP_URL;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("generatePkcePair", () => {
  it("mints a high-entropy verifier and the matching S256 challenge", () => {
    const { verifier, challenge } = generatePkcePair();
    // 64 random bytes → 86 base64url chars; inside Fitbit's 43–128 range.
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    // challenge = BASE64URL(SHA256(verifier)).
    const expected = createHash("sha256").update(verifier).digest("base64url");
    expect(challenge).toBe(expected);
  });

  it("mints a fresh pair each call", () => {
    expect(generatePkcePair().verifier).not.toBe(generatePkcePair().verifier);
  });
});

describe("getAuthorizationUrl", () => {
  it("builds the classic Fitbit authorize URL with PKCE S256", () => {
    const url = getAuthorizationUrl("nonce123", CREDS, "chal-xyz");
    expect(url).toContain("www.fitbit.com/oauth2/authorize");
    expect(url).toContain("response_type=code");
    expect(url).toContain("client_id=cid");
    expect(url).toContain("state=nonce123");
    const parsed = new URL(url);
    expect(parsed.searchParams.get("code_challenge")).toBe("chal-xyz");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("scope")).toBe(FITBIT_OAUTH_SCOPE);
  });

  it("requests the classic self-serve scopes and omits temperature", () => {
    const scopes = FITBIT_OAUTH_SCOPE.split(" ");
    expect(scopes).toContain("activity");
    expect(scopes).toContain("heartrate");
    expect(scopes).toContain("sleep");
    expect(scopes).toContain("weight");
    expect(scopes).toContain("oxygen_saturation");
    expect(scopes).toContain("respiratory_rate");
    expect(scopes).toContain("cardio_fitness");
    expect(scopes).toContain("profile");
    // temperature deliberately omitted — the classic skin-temp reading is a
    // baseline delta with no honest absolute slot.
    expect(FITBIT_OAUTH_SCOPE).not.toContain("temperature");
    expect(FITBIT_OAUTH_SCOPE).not.toContain("nutrition");
    expect(FITBIT_OAUTH_SCOPE).not.toContain("location");
  });

  it("carries the configured app origin in the redirect_uri", () => {
    const url = getAuthorizationUrl("nonce123", CREDS, "c");
    const redirect = new URL(url).searchParams.get("redirect_uri");
    expect(redirect).toBe("https://app.example.test/api/fitbit/callback");
  });
});

describe("redirect_uri allowlist", () => {
  const PRIOR_REDIRECT = process.env.FITBIT_REDIRECT_URI;
  afterEach(() => {
    if (PRIOR_REDIRECT === undefined) delete process.env.FITBIT_REDIRECT_URI;
    else process.env.FITBIT_REDIRECT_URI = PRIOR_REDIRECT;
  });

  it("rejects a non-https app origin", () => {
    process.env.NEXT_PUBLIC_APP_URL = "http://app.example.test";
    expect(() => getAuthorizationUrl("n", CREDS, "c")).toThrow(/must be https/);
  });

  it("allows http on localhost (dev)", () => {
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
    const url = getAuthorizationUrl("n", CREDS, "c");
    expect(new URL(url).searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/api/fitbit/callback",
    );
  });

  it("rejects an explicit redirect that targets the wrong path", () => {
    process.env.FITBIT_REDIRECT_URI = "https://app.example.test/evil";
    expect(() => getAuthorizationUrl("n", CREDS, "c")).toThrow(
      /must target \/api\/fitbit\/callback/,
    );
  });

  it("rejects an explicit redirect whose origin differs from NEXT_PUBLIC_APP_URL", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.test";
    process.env.FITBIT_REDIRECT_URI =
      "https://attacker.example.test/api/fitbit/callback";
    expect(() => getAuthorizationUrl("n", CREDS, "c")).toThrow(
      /does not match/,
    );
  });
});

describe("token exchange + refresh", () => {
  it("exchanges an authorization code WITH the PKCE verifier via Basic auth", async () => {
    const fetchMock = installFetchMock([
      {
        status: 200,
        body: {
          access_token: "at",
          refresh_token: "rt",
          expires_in: 28800,
          scope: "activity sleep weight",
          user_id: "ABC123",
        },
      },
    ]);
    const tok = await exchangeCode("code", "verifier-123", CREDS);
    expect(tok.access_token).toBe("at");
    expect(tok.refresh_token).toBe("rt");
    expect(tok.expires_in).toBe(28800);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(url).toContain("api.fitbit.com/oauth2/token");
    expect(init.body).toContain("grant_type=authorization_code");
    expect(init.body).toContain("code_verifier=verifier-123");
    const expected = `Basic ${Buffer.from("cid:csecret").toString("base64")}`;
    expect(init.headers.Authorization).toBe(expected);
  });

  it("refreshes and returns the ROTATED refresh token (classic rotates)", async () => {
    const fetchMock = installFetchMock([
      {
        status: 200,
        body: {
          access_token: "at2",
          refresh_token: "rt2",
          expires_in: 28800,
        },
      },
    ]);
    const tok = await refreshAccessToken("rt1", CREDS);
    expect(tok.access_token).toBe("at2");
    // Classic Fitbit rotates: a fresh refresh token is returned every time.
    expect(tok.refresh_token).toBe("rt2");
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { body: string },
    ];
    expect(init.body).toContain("grant_type=refresh_token");
    expect(init.body).toContain("refresh_token=rt1");
    // The grant's scope is preserved — no scope param re-sent.
    expect(init.body).not.toContain("scope=");
  });

  it("throws a classified FitbitApiError on a 401 token response", async () => {
    installFetchMock([
      { status: 401, body: { errors: [{ errorType: "invalid_grant" }] } },
    ]);
    await expect(exchangeCode("bad", "v", CREDS)).rejects.toMatchObject({
      name: "FitbitApiError",
      classification: "reauth_required",
    });
  });
});

describe("fetchProfile + resolveFitbitUserId", () => {
  it("resolves the external user id from the profile encodedId", () => {
    expect(resolveFitbitUserId({ user: { encodedId: "ABC123" } })).toBe(
      "ABC123",
    );
    expect(resolveFitbitUserId({})).toBe("me");
    expect(resolveFitbitUserId({ user: {} })).toBe("me");
  });
});

describe("date-range fetchers", () => {
  it("encodes the weight endpoint path with the metric Accept-Language", async () => {
    const fetchMock = installFetchMock([{ status: 200, body: { weight: [] } }]);
    await fetchWeightRange(
      "at",
      new Date("2026-05-01T00:00:00Z"),
      new Date("2026-05-30T00:00:00Z"),
    );
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string> },
    ];
    expect(url).toBe(
      `${FITBIT_API_BASE}/1/user/-/body/log/weight/date/2026-05-01/2026-05-30.json`,
    );
    expect(init.headers["Accept-Language"]).toBe("en_GB");
    expect(init.headers.Authorization).toBe("Bearer at");
  });

  it("encodes the sleep endpoint on the 1.2 version path", async () => {
    const fetchMock = installFetchMock([{ status: 200, body: { sleep: [] } }]);
    await fetchSleepRange(
      "at",
      new Date("2026-05-01T00:00:00Z"),
      new Date("2026-05-30T00:00:00Z"),
    );
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe(
      `${FITBIT_API_BASE}/1.2/user/-/sleep/date/2026-05-01/2026-05-30.json`,
    );
  });

  it("throws a classified FitbitApiError on a 403 page", async () => {
    installFetchMock([{ status: 403, body: {} }]);
    await expect(
      fetchSpo2Range("at", new Date(), new Date()),
    ).rejects.toMatchObject({
      name: "FitbitApiError",
      classification: "reauth_required",
      httpStatus: 403,
    });
  });
});

describe("metric mappers (classic shapes)", () => {
  it("maps weight in kg, anchoring the externalId on the logId", () => {
    const out = mapWeight({
      weight: [
        {
          date: "2026-05-10",
          time: "07:30:00",
          weight: 81.46,
          logId: 1551080804000,
          source: "Aria",
        },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "WEIGHT", value: 81.46, unit: "kg" });
    expect(out[0]!.measuredAt.toISOString()).toBe("2026-05-10T07:30:00.000Z");
    expect(out[0]!.fieldTag).toBe("1551080804000:weight");
  });

  it("maps body fat percentage from the fat array", () => {
    const out = mapBodyFat({
      fat: [{ date: "2026-05-10", time: "07:30:00", fat: 18.2, logId: 42 }],
    });
    expect(out[0]).toMatchObject({ type: "BODY_FAT", value: 18.2, unit: "%" });
    expect(out[0]!.fieldTag).toBe("42:body_fat");
  });

  it("maps daily SpO2 from value.avg with a day-keyed externalId (bare array)", () => {
    const out = mapOxygenSaturation([
      { dateTime: "2026-05-10", value: { avg: 97.4, min: 94, max: 100 } },
    ]);
    expect(out[0]).toMatchObject({
      type: "OXYGEN_SATURATION",
      value: 97.4,
      unit: "%",
    });
    expect(out[0]!.fieldTag).toBe("2026-05-10:spo2");
  });

  it("maps HRV dailyRmssd into the canonical HEART_RATE_VARIABILITY slot", () => {
    const out = mapHeartRateVariability({
      hrv: [
        { dateTime: "2026-05-10", value: { dailyRmssd: 42.7, deepRmssd: 50 } },
      ],
    });
    expect(out[0]!.type).toBe("HEART_RATE_VARIABILITY");
    expect(out[0]).toMatchObject({ value: 42.7, unit: "ms" });
    expect(out[0]!.fieldTag).toBe("2026-05-10:hrv");
  });

  it("maps resting HR from the activities-heart value.restingHeartRate", () => {
    const out = mapRestingHeartRate({
      "activities-heart": [
        { dateTime: "2026-05-10", value: { restingHeartRate: 54 } },
      ],
    });
    expect(out[0]).toMatchObject({ type: "RESTING_HEART_RATE", value: 54 });
  });

  it("maps respiratory rate from value.breathingRate", () => {
    const out = mapRespiratoryRate({
      br: [{ dateTime: "2026-05-10", value: { breathingRate: 17.8 } }],
    });
    expect(out[0]).toMatchObject({
      type: "RESPIRATORY_RATE",
      value: 17.8,
      unit: "breaths/min",
    });
  });

  it("drops a garbage / non-positive / absent reading rather than minting a row", () => {
    expect(
      mapWeight({ weight: [{ date: "2026-05-10", weight: 0 }] }),
    ).toHaveLength(0);
    expect(mapWeight({ weight: [] })).toHaveLength(0);
    expect(mapWeight({})).toHaveLength(0);
    expect(
      mapOxygenSaturation([{ dateTime: "2026-05-10", value: {} }]),
    ).toHaveLength(0);
  });
});

describe("VO2 max", () => {
  it("parses a single numeric string and a range midpoint", () => {
    expect(parseVo2Max("45")).toBe(45);
    expect(parseVo2Max("44-48")).toBe(46);
    expect(parseVo2Max(50)).toBe(50);
    expect(parseVo2Max("not-a-number")).toBeNull();
  });

  it("maps cardioScore value.vo2Max (range → midpoint) with a day-keyed stats externalId", () => {
    const out = mapVo2Max({
      cardioScore: [
        { dateTime: "2026-05-10", value: { vo2Max: "44-48" } },
        { dateTime: "2026-05-11", value: { vo2Max: "45" } },
      ],
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ type: "VO2_MAX", value: 46 });
    expect(out[0]!.cumulativeDaily).toBe(true);
    expect(out[0]!.fieldTag).toBe("vo2_max:2026-05-10");
    expect(out[1]!.value).toBe(45);
  });
});

describe("activity mappers (cumulative daily)", () => {
  it("maps steps from the string value, preserving a zero, with a day-keyed externalId", () => {
    const out = mapSteps({
      "activities-steps": [
        { dateTime: "2026-05-10", value: "8421" },
        { dateTime: "2026-05-11", value: "0" },
      ],
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      type: "ACTIVITY_STEPS",
      value: 8421,
      unit: "steps",
      cumulativeDaily: true,
    });
    expect(out[0]!.fieldTag).toBe("steps:2026-05-10");
    // A rest day of 0 steps is real data.
    expect(out[1]!.value).toBe(0);
  });

  it("maps distance km → metres", () => {
    const out = mapDistance({
      "activities-distance": [{ dateTime: "2026-05-10", value: "6.2" }],
    });
    expect(out[0]).toMatchObject({
      type: "WALKING_RUNNING_DISTANCE",
      value: 6200,
      unit: "m",
    });
  });

  it("maps the ACTIVE-calories portion into ACTIVE_ENERGY_BURNED", () => {
    const out = mapActiveCalories({
      "activities-activityCalories": [{ dateTime: "2026-05-10", value: "540" }],
    });
    expect(out[0]).toMatchObject({
      type: "ACTIVE_ENERGY_BURNED",
      value: 540,
      unit: "kcal",
    });
  });

  it("maps floors and preserves a zero", () => {
    const out = mapFloors({
      "activities-floors": [
        { dateTime: "2026-05-10", value: "12" },
        { dateTime: "2026-05-11", value: "0" },
      ],
    });
    expect(out[0]).toMatchObject({ type: "FLIGHTS_CLIMBED", value: 12 });
    expect(out[1]!.value).toBe(0);
  });
});

describe("sleep mapping (1.2 levels.data)", () => {
  it("harmonises classic Fitbit level labels onto the shared SleepStage enum", () => {
    expect(mapFitbitSleepStage("light")).toBe("CORE"); // Fitbit light ↔ Apple core
    expect(mapFitbitSleepStage("deep")).toBe("DEEP");
    expect(mapFitbitSleepStage("rem")).toBe("REM");
    expect(mapFitbitSleepStage("wake")).toBe("AWAKE");
    expect(mapFitbitSleepStage("awake")).toBe("AWAKE");
    expect(mapFitbitSleepStage("restless")).toBe("AWAKE");
    expect(mapFitbitSleepStage("asleep")).toBe("ASLEEP");
    expect(mapFitbitSleepStage("snoring")).toBeNull();
    expect(mapFitbitSleepStage(42)).toBeNull();
  });

  it("maps a session into per-SEGMENT rows with measuredAt = segment END (real timeline)", () => {
    const sessions = readSleepSessions({
      sleep: [
        {
          logId: 999,
          startTime: "2026-05-10T22:00:00.000",
          endTime: "2026-05-11T06:00:00.000",
          levels: {
            data: [
              {
                dateTime: "2026-05-10T22:00:00.000",
                level: "light",
                seconds: 1800,
              },
              {
                dateTime: "2026-05-10T22:30:00.000",
                level: "deep",
                seconds: 3600,
              },
              {
                dateTime: "2026-05-10T23:30:00.000",
                level: "rem",
                seconds: 2700,
              },
            ],
          },
        },
      ],
    });
    expect(sessions).toHaveLength(1);
    const out = mapSleepSession(sessions[0]!);

    // One row per segment.
    expect(out).toHaveLength(3);
    expect(out.every((m) => m.type === "SLEEP_DURATION")).toBe(true);
    expect(out.every((m) => m.unit === "minutes")).toBe(true);

    const core = out.find((m) => m.sleepStage === "CORE")!;
    expect(core.value).toBe(30); // 1800s → 30 min
    // measuredAt = segment START + seconds = END (local instant).
    expect(core.measuredAt.getTime()).toBe(
      new Date("2026-05-10T22:30:00.000").getTime(),
    );
    const deep = out.find((m) => m.sleepStage === "DEEP")!;
    expect(deep.value).toBe(60);
    const rem = out.find((m) => m.sleepStage === "REM")!;
    expect(rem.value).toBe(45);

    // Every fieldTag distinct (logId anchor + stage + segment index).
    const tags = out.map((m) => m.fieldTag);
    expect(new Set(tags).size).toBe(tags.length);
    expect(deep.fieldTag).toBe("999:sleep_deep:1");
  });

  it("yields nothing for a session with no parseable segments", () => {
    expect(mapSleepSession({ levels: { data: [] } })).toHaveLength(0);
    expect(mapSleepSession({})).toHaveLength(0);
  });

  it("anchors a near-midnight segment END to the user's timezone, not the process zone", () => {
    // A Berlin user (UTC+2 in May / CEST) whose last segment ENDS at 00:30
    // local on 2026-05-11. The offset-less wall clock `2026-05-11T00:30:00`
    // must resolve to 22:30 UTC on 2026-05-10 — NOT 00:30 UTC (which a bare
    // `new Date(iso)` in a UTC process would produce, flipping the wake-day).
    const sessions = readSleepSessions({
      sleep: [
        {
          logId: 4242,
          startTime: "2026-05-10T23:00:00.000",
          endTime: "2026-05-11T00:30:00.000",
          levels: {
            data: [
              {
                dateTime: "2026-05-11T00:00:00.000",
                level: "deep",
                seconds: 1800, // ends 00:30 Berlin local
              },
            ],
          },
        },
      ],
    });

    const out = mapSleepSession(sessions[0]!, "Europe/Berlin");
    expect(out).toHaveLength(1);
    // 00:30 CEST (UTC+2) → 22:30 UTC on the PRIOR civil day.
    expect(out[0]!.measuredAt.toISOString()).toBe("2026-05-10T22:30:00.000Z");
  });

  it("anchors a logId-less session anchor against the user's timezone", () => {
    const sessions = readSleepSessions({
      sleep: [
        {
          // No logId → the anchor falls back to the END instant, which must
          // also be tz-resolved so the externalId is stable across syncs.
          endTime: "2026-05-11T00:30:00.000",
          levels: {
            data: [
              {
                dateTime: "2026-05-11T00:00:00.000",
                level: "rem",
                seconds: 1800,
              },
            ],
          },
        },
      ],
    });

    const out = mapSleepSession(sessions[0]!, "Europe/Berlin");
    expect(out).toHaveLength(1);
    // anchor = end instant ISO (UTC) → fieldTag starts with that instant.
    expect(out[0]!.fieldTag).toBe("2026-05-10T22:30:00.000Z:sleep_rem:0");
  });
});

describe("workout mapping (activities list)", () => {
  it("maps an activity-list entry into a Workout keyed on the logId", () => {
    const entries = readActivityList({
      activities: [
        {
          logId: 123456,
          activityName: "Run",
          startTime: "2026-05-10T07:00:00.000",
          duration: 45 * 60 * 1000,
          calories: 410,
          distance: 7.8, // km
          averageHeartRate: 148,
        },
      ],
    });
    expect(entries).toHaveLength(1);
    const w = mapWorkout(entries[0]!);
    expect(w).not.toBeNull();
    expect(w).toMatchObject({
      externalId: "123456",
      sportType: "running",
      durationSec: 45 * 60,
      totalEnergyKcal: 410,
      totalDistanceM: 7800, // km → m
      avgHeartRate: 148,
      maxHeartRate: null,
      minHeartRate: null,
    });
    expect(w!.startedAt.getTime()).toBe(
      new Date("2026-05-10T07:00:00.000").getTime(),
    );
  });

  it("falls back to a start-anchored externalId + 'other' sport when fields are absent", () => {
    const w = mapWorkout({
      startTime: "2026-05-10T07:00:00.000",
      duration: 30 * 60 * 1000,
    });
    expect(w!.externalId).toMatch(/^exercise:/);
    expect(w!.sportType).toBe("other");
    expect(w!.totalEnergyKcal).toBeNull();
    expect(w!.avgHeartRate).toBeNull();
  });

  it("returns null for an entry with no usable time span", () => {
    expect(mapWorkout({ startTime: "2026-05-10T07:00:00.000" })).toBeNull();
    expect(mapWorkout({ duration: 1000 })).toBeNull();
    expect(mapWorkout({})).toBeNull();
  });

  it("resolves activity names to canonical sport labels", () => {
    expect(mapFitbitSportType("Walk")).toBe("walking");
    expect(mapFitbitSportType("biking")).toBe("cycling");
    expect(mapFitbitSportType("weights")).toBe("strength");
    expect(mapFitbitSportType("unknown-sport")).toBe("other");
    expect(mapFitbitSportType("")).toBe("other");
  });
});

describe("FITBIT_FIELD_MAP", () => {
  it("documents a type + unit for every launch metric", () => {
    for (const [, entry] of Object.entries(FITBIT_FIELD_MAP)) {
      expect(typeof entry.type).toBe("string");
      expect(entry.type.length).toBeGreaterThan(0);
      expect(typeof entry.unit).toBe("string");
    }
    expect(FITBIT_FIELD_MAP.weight!.type).toBe("WEIGHT");
    expect(FITBIT_FIELD_MAP.vo2Max!.type).toBe("VO2_MAX");
  });
});
