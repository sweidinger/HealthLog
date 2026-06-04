import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FITBIT_API_BASE,
  FITBIT_DATA_TYPES,
  FITBIT_FIELD_MAP,
  FITBIT_OAUTH_SCOPE,
  exchangeCode,
  fetchDataPoints,
  fetchProfile,
  getAuthorizationUrl,
  mapActiveCalories,
  mapBodyFat,
  mapDistance,
  mapFitbitSleepStage,
  mapFitbitSportType,
  mapFloors,
  mapHeartRateVariability,
  mapHeightCm,
  mapOxygenSaturation,
  mapRestingHeartRate,
  mapSleepSession,
  mapSteps,
  mapVo2Max,
  mapWeight,
  mapWorkout,
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("getAuthorizationUrl", () => {
  it("builds the Google authorize URL with offline access + consent prompt", () => {
    const url = getAuthorizationUrl("nonce123", CREDS);
    expect(url).toContain("accounts.google.com/o/oauth2/v2/auth");
    expect(url).toContain("response_type=code");
    expect(url).toContain("client_id=cid");
    expect(url).toContain("state=nonce123");
    expect(url).toContain("access_type=offline");
    expect(url).toContain("prompt=consent");
    // URLSearchParams encodes the space-separated scope; compare the parsed
    // `scope` param back to the canonical constant.
    const scope = new URL(url).searchParams.get("scope");
    expect(scope).toBe(FITBIT_OAUTH_SCOPE);
    expect(FITBIT_OAUTH_SCOPE).toContain("googlehealth.profile.readonly");
  });

  it("requests exactly the four launch Restricted read bundles", () => {
    const scopes = FITBIT_OAUTH_SCOPE.split(" ");
    expect(scopes).toHaveLength(4);
    expect(scopes).toContain(
      "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly",
    );
    expect(scopes).toContain(
      "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly",
    );
    expect(scopes).toContain(
      "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
    );
    // ECG / nutrition / location are deliberately omitted from the launch set.
    expect(FITBIT_OAUTH_SCOPE).not.toContain("ecg");
    expect(FITBIT_OAUTH_SCOPE).not.toContain("nutrition");
    expect(FITBIT_OAUTH_SCOPE).not.toContain("location");
  });
});

describe("token exchange + refresh", () => {
  it("exchanges an authorization code for a token pair via Basic auth", async () => {
    const fetchMock = installFetchMock([
      {
        status: 200,
        body: {
          access_token: "at",
          refresh_token: "rt",
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
        },
      },
    ]);
    const tok = await exchangeCode("code", CREDS);
    expect(tok.access_token).toBe("at");
    expect(tok.refresh_token).toBe("rt");
    expect(tok.expires_in).toBe(3600);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(url).toContain("oauth2.googleapis.com/token");
    expect(init.body).toContain("grant_type=authorization_code");
    // Confidential client credentials ride in the Basic-auth header.
    const expected = `Basic ${Buffer.from("cid:csecret").toString("base64")}`;
    expect(init.headers.Authorization).toBe(expected);
  });

  it("refreshes WITHOUT re-sending scope (Google preserves the grant)", async () => {
    const fetchMock = installFetchMock([
      {
        status: 200,
        body: { access_token: "at2", expires_in: 3600 },
      },
    ]);
    const tok = await refreshAccessToken("rt1", CREDS);
    expect(tok.access_token).toBe("at2");
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { body: string },
    ];
    expect(init.body).toContain("grant_type=refresh_token");
    expect(init.body).toContain("refresh_token=rt1");
    // Google preserves the original grant — no scope param is re-sent.
    expect(init.body).not.toContain("scope=");
  });

  it("returns an absent refresh_token unchanged (Google does not rotate)", async () => {
    installFetchMock([
      { status: 200, body: { access_token: "at3", expires_in: 3600 } },
    ]);
    const tok = await refreshAccessToken("rt1", CREDS);
    expect(tok.access_token).toBe("at3");
    expect(tok.refresh_token).toBeUndefined();
  });

  it("throws a classified FitbitApiError on a 401 token response", async () => {
    installFetchMock([{ status: 401, body: { error: "invalid_grant" } }]);
    await expect(exchangeCode("bad", CREDS)).rejects.toMatchObject({
      name: "FitbitApiError",
      classification: "reauth_required",
    });
  });
});

describe("fetchProfile + resolveFitbitUserId", () => {
  it("fetches the profile from the Google Health base", async () => {
    const fetchMock = installFetchMock([
      { status: 200, body: { name: "users/abc123" } },
    ]);
    const profile = await fetchProfile("at");
    expect(profile.name).toBe("users/abc123");
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe(`${FITBIT_API_BASE}/users/me/profile`);
  });

  it("throws a classified error on a 403 profile read", async () => {
    installFetchMock([{ status: 403, body: {} }]);
    await expect(fetchProfile("at")).rejects.toMatchObject({
      name: "FitbitApiError",
      classification: "reauth_required",
    });
  });

  it("resolves the external user id from a users/{id} resource name", () => {
    expect(resolveFitbitUserId({ name: "users/abc123" })).toBe("abc123");
  });

  it("falls back to a bare id, then to 'me'", () => {
    expect(resolveFitbitUserId({ id: "xyz" })).toBe("xyz");
    expect(resolveFitbitUserId({})).toBe("me");
  });
});

describe("fetchDataPoints", () => {
  it("encodes the data type kebab-case in the path and snake_case in the filter, walking nextPageToken", async () => {
    const fetchMock = installFetchMock([
      {
        status: 200,
        body: {
          dataPoints: [{ a: 1 }],
          nextPageToken: "tok2",
        },
      },
      { status: 200, body: { dataPoints: [{ a: 2 }] } },
    ]);

    const points = await fetchDataPoints(
      FITBIT_DATA_TYPES.bodyFat,
      "at",
      "fetchBodyFat",
      { start: new Date("2026-01-01T00:00:00.000Z") },
    );
    expect(points).toHaveLength(2);

    const [url1] = fetchMock.mock.calls[0] as unknown as [string];
    // Path uses kebab-case; filter uses snake_case.
    expect(url1).toContain(
      `${FITBIT_API_BASE}/users/me/dataTypes/body-fat/dataPoints`,
    );
    const parsed = new URL(url1);
    expect(parsed.searchParams.get("filter")).toBe(
      'body_fat.sample_time.physical_time >= "2026-01-01T00:00:00.000Z"',
    );

    // Second page carries the pageToken from the first response.
    const [url2] = fetchMock.mock.calls[1] as unknown as [string];
    expect(new URL(url2).searchParams.get("pageToken")).toBe("tok2");
  });

  it("filters daily summaries on the civil date, not the sample time", async () => {
    const fetchMock = installFetchMock([
      { status: 200, body: { dataPoints: [] } },
    ]);
    await fetchDataPoints(
      FITBIT_DATA_TYPES.restingHeartRate,
      "at",
      "fetchRhr",
      { start: new Date("2026-03-04T10:00:00.000Z") },
    );
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(new URL(url).searchParams.get("filter")).toBe(
      'daily_resting_heart_rate.date >= "2026-03-04"',
    );
  });

  it("filters INTERVAL types on interval.start_time, not a sample_time or a bare date", async () => {
    // steps / distance / calories / floors, sleep and exercise are INTERVAL data
    // types — Google anchors them on `interval.start_time`. A sample_time filter
    // 400s/empties for these and stalls incremental sync.
    const stepsMock = installFetchMock([{ status: 200, body: { dataPoints: [] } }]);
    await fetchDataPoints(FITBIT_DATA_TYPES.steps, "at", "fetchSteps", {
      start: new Date("2026-03-04T10:00:00.000Z"),
    });
    expect(
      new URL((stepsMock.mock.calls[0] as unknown as [string])[0]).searchParams.get(
        "filter",
      ),
    ).toBe('steps.interval.start_time >= "2026-03-04T10:00:00.000Z"');

    const sleepMock = installFetchMock([{ status: 200, body: { dataPoints: [] } }]);
    await fetchDataPoints(FITBIT_DATA_TYPES.sleep, "at", "fetchSleep", {
      start: new Date("2026-03-04T10:00:00.000Z"),
    });
    expect(
      new URL((sleepMock.mock.calls[0] as unknown as [string])[0]).searchParams.get(
        "filter",
      ),
    ).toBe('sleep.interval.start_time >= "2026-03-04T10:00:00.000Z"');

    const exMock = installFetchMock([{ status: 200, body: { dataPoints: [] } }]);
    await fetchDataPoints(FITBIT_DATA_TYPES.exercise, "at", "fetchExercise", {
      start: new Date("2026-03-04T10:00:00.000Z"),
    });
    expect(
      new URL((exMock.mock.calls[0] as unknown as [string])[0]).searchParams.get(
        "filter",
      ),
    ).toBe('exercise.interval.start_time >= "2026-03-04T10:00:00.000Z"');
  });

  it("throws a classified FitbitApiError on a non-2xx page", async () => {
    installFetchMock([{ status: 403, body: {} }]);
    await expect(
      fetchDataPoints(FITBIT_DATA_TYPES.weight, "at", "fetchWeight"),
    ).rejects.toMatchObject({
      name: "FitbitApiError",
      classification: "reauth_required",
      httpStatus: 403,
    });
  });
});

describe("metric mappers", () => {
  it("maps weight in kg with a stable sample-time anchor + field-tag externalId", () => {
    const point = {
      weight: {
        kilograms: 81.456,
        sample_time: { physical_time: "2026-05-10T07:30:00.000Z" },
      },
    };
    const out = mapWeight(point);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: "WEIGHT",
      value: 81.46,
      unit: "kg",
    });
    expect(out[0]!.measuredAt.toISOString()).toBe("2026-05-10T07:30:00.000Z");
    // externalId field-tag: <anchor>:<tag>; anchor is the sample time ISO string.
    expect(out[0]!.fieldTag).toBe("2026-05-10T07:30:00.000Z:weight");
  });

  it("maps body fat percentage", () => {
    const out = mapBodyFat({ body_fat: { percentage: 18.2 } });
    expect(out[0]).toMatchObject({ type: "BODY_FAT", value: 18.2, unit: "%" });
  });

  it("maps daily SpO2 with a civil-date anchor", () => {
    const out = mapOxygenSaturation({
      daily_oxygen_saturation: {
        average_percentage: 97.4,
        date: { year: 2026, month: 5, day: 10 },
      },
    });
    expect(out[0]).toMatchObject({
      type: "OXYGEN_SATURATION",
      value: 97.4,
      unit: "%",
    });
    // Daily anchor is the civil date (YYYY-MM-DD), so a re-fetch of the same day
    // overwrites in place.
    expect(out[0]!.fieldTag).toBe("2026-05-10:spo2");
  });

  it("maps Fitbit HRV into the SDNN HEART_RATE_VARIABILITY slot, NOT HRV_RMSSD", () => {
    const out = mapHeartRateVariability({
      daily_heart_rate_variability: {
        rmssd_milliseconds: 42.7,
        date: { year: 2026, month: 5, day: 10 },
      },
    });
    expect(out[0]!.type).toBe("HEART_RATE_VARIABILITY");
    expect(out[0]!.type).not.toBe("HRV_RMSSD");
    expect(out[0]).toMatchObject({ value: 42.7, unit: "ms" });
  });

  it("maps daily resting heart rate", () => {
    const out = mapRestingHeartRate({
      daily_resting_heart_rate: {
        beats_per_minute: 54,
        date: { year: 2026, month: 5, day: 10 },
      },
    });
    expect(out[0]).toMatchObject({ type: "RESTING_HEART_RATE", value: 54 });
  });

  it("drops a garbage / non-positive reading rather than minting a row", () => {
    expect(mapWeight({ weight: { kilograms: 0 } })).toHaveLength(0);
    expect(mapWeight({ weight: { kilograms: Number.NaN } })).toHaveLength(0);
    expect(mapWeight({})).toHaveLength(0);
  });

  it("resolves height to cm from either centimetres or metres, never as a Measurement", () => {
    expect(mapHeightCm({ height: { centimeters: 178 } })).toBe(178);
    expect(mapHeightCm({ height: { meters: 1.78 } })).toBe(178);
    expect(mapHeightCm({ height: {} })).toBeNull();
  });
});

describe("FITBIT_FIELD_MAP ↔ FITBIT_DATA_TYPES casing parity", () => {
  it("keeps the kebab-path / snake-filter pair consistent across both tables", () => {
    for (const [, entry] of Object.entries(FITBIT_FIELD_MAP)) {
      // Path is kebab-case, filter is snake_case — they must never carry the
      // wrong separator (the design §A.1 casing gotcha).
      expect(entry.path).not.toContain("_");
      expect(entry.filter).not.toContain("-");
    }
    // Every FITBIT_DATA_TYPES entry has matching casing too.
    for (const dt of Object.values(FITBIT_DATA_TYPES)) {
      expect(dt.path).not.toContain("_");
      expect(dt.filter).not.toContain("-");
    }
  });
});

describe("activity mappers (cumulative daily)", () => {
  // INTERVAL data types: Google buckets the daily total into an `interval` with
  // a `start_time` (physical instant) — NOT a bare civil `date`. The mapper
  // anchors measuredAt on `interval.start_time` and day-keys the externalId.
  const interval = { start_time: "2026-05-10T00:00:00.000Z" };
  // A civil-only fallback shape (no physical start_time) still day-keys cleanly.
  const civilInterval = {
    civil_start_time: { year: 2026, month: 5, day: 10 },
  };

  it("maps steps with a stats:-shaped daily externalId and preserves a zero", () => {
    const out = mapSteps({ steps: { count: 8421, interval } });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: "ACTIVITY_STEPS",
      value: 8421,
      unit: "steps",
      cumulativeDaily: true,
    });
    // fieldTag carries <tag>:<YYYY-MM-DD>; the sync layer prefixes `stats:`.
    expect(out[0]!.fieldTag).toBe("steps:2026-05-10");
    // measuredAt anchored on the interval start instant.
    expect(out[0]!.measuredAt.toISOString()).toBe("2026-05-10T00:00:00.000Z");

    // The civil-only fallback day-keys the externalId at UTC midday.
    const civil = mapSteps({ steps: { count: 100, interval: civilInterval } });
    expect(civil[0]!.fieldTag).toBe("steps:2026-05-10");

    // A rest day records 0 steps — that is real data, not a gap.
    const rest = mapSteps({ steps: { count: 0, interval } });
    expect(rest).toHaveLength(1);
    expect(rest[0]!.value).toBe(0);
  });

  it("maps distance in metres, converting km → m when reported in km", () => {
    expect(mapDistance({ distance: { meters: 6200, interval } })[0]).toMatchObject({
      type: "WALKING_RUNNING_DISTANCE",
      value: 6200,
      unit: "m",
    });
    // km path multiplies by 1000.
    expect(
      mapDistance({ distance: { kilometers: 6.2, interval } })[0]!.value,
    ).toBe(6200);
  });

  it("maps the ACTIVE-calories portion into ACTIVE_ENERGY_BURNED", () => {
    const out = mapActiveCalories({
      active_calories: { active_kilocalories: 540, interval },
    });
    expect(out[0]).toMatchObject({
      type: "ACTIVE_ENERGY_BURNED",
      value: 540,
      unit: "kcal",
    });
  });

  it("maps floors and preserves a zero", () => {
    expect(mapFloors({ floors: { count: 12, interval } })[0]).toMatchObject({
      type: "FLIGHTS_CLIMBED",
      value: 12,
      unit: "flights",
    });
    expect(mapFloors({ floors: { count: 0, interval } })[0]!.value).toBe(0);
  });

  it("maps VO2 max (strictly positive, daily latest-wins) and drops a zero", () => {
    // VO2 max is a daily-summary metric (civil `date` anchor), not an interval.
    const day = { year: 2026, month: 5, day: 10 };
    const out = mapVo2Max({
      vo2_max: { milliliters_per_kilogram_per_minute: 47.3, date: day },
    });
    expect(out[0]).toMatchObject({ type: "VO2_MAX", value: 47.3 });
    // VO2 max of 0 is garbage — dropped (unlike the running totals).
    expect(
      mapVo2Max({ vo2_max: { milliliters_per_kilogram_per_minute: 0, date: day } }),
    ).toHaveLength(0);
  });
});

describe("sleep-stage mapping", () => {
  it("harmonises Google stage labels onto the shared SleepStage enum", () => {
    expect(mapFitbitSleepStage("light")).toBe("CORE"); // Fitbit light ↔ Apple core
    expect(mapFitbitSleepStage("deep")).toBe("DEEP");
    expect(mapFitbitSleepStage("rem")).toBe("REM");
    expect(mapFitbitSleepStage("awake")).toBe("AWAKE");
    expect(mapFitbitSleepStage("wake")).toBe("AWAKE");
    expect(mapFitbitSleepStage("restless")).toBe("AWAKE");
    expect(mapFitbitSleepStage("in-bed")).toBe("IN_BED");
    expect(mapFitbitSleepStage("asleep")).toBe("ASLEEP");
    // Unknown / non-string → null (skipped, never mis-bucketed).
    expect(mapFitbitSleepStage("snoring")).toBeNull();
    expect(mapFitbitSleepStage(42)).toBeNull();
  });

  it("maps a session into per-stage SLEEP_DURATION rows with measuredAt = stage END", () => {
    const session = {
      sleep: {
        startTime: "2026-05-10T22:00:00.000Z",
        endTime: "2026-05-11T06:00:00.000Z",
        segments: [
          {
            stage: "light",
            startTime: "2026-05-10T22:00:00.000Z",
            endTime: "2026-05-10T22:30:00.000Z",
          },
          {
            stage: "deep",
            startTime: "2026-05-10T22:30:00.000Z",
            endTime: "2026-05-10T23:30:00.000Z",
          },
          {
            stage: "light",
            startTime: "2026-05-10T23:30:00.000Z",
            endTime: "2026-05-11T00:15:00.000Z",
          },
          {
            stage: "rem",
            startTime: "2026-05-11T00:15:00.000Z",
            endTime: "2026-05-11T01:00:00.000Z",
          },
        ],
      },
    };
    const out = mapSleepSession(session);
    const byStage = Object.fromEntries(out.map((m) => [m.sleepStage, m]));

    // CORE = the two light segments summed (30 + 45 = 75 min).
    expect(byStage.CORE!.value).toBe(75);
    expect(byStage.CORE!.type).toBe("SLEEP_DURATION");
    expect(byStage.CORE!.unit).toBe("minutes");
    // measuredAt is the LATEST end for that stage (the second light segment).
    expect(byStage.CORE!.measuredAt.toISOString()).toBe(
      "2026-05-11T00:15:00.000Z",
    );
    expect(byStage.DEEP!.value).toBe(60);
    expect(byStage.REM!.value).toBe(45);

    // externalId field-tag is session-anchored so a re-score overwrites in place.
    expect(byStage.DEEP!.fieldTag).toBe(
      "2026-05-11T06:00:00.000Z:sleep_deep",
    );
  });

  it("anchors the session externalId on sleep.interval.end_time for an INTERVAL-shaped point", () => {
    const out = mapSleepSession({
      sleep: {
        interval: {
          start_time: "2026-05-10T22:00:00.000Z",
          end_time: "2026-05-11T06:00:00.000Z",
        },
        segments: [
          {
            stage: "deep",
            startTime: "2026-05-10T22:30:00.000Z",
            endTime: "2026-05-10T23:30:00.000Z",
          },
        ],
      },
    });
    const deep = out.find((m) => m.sleepStage === "DEEP");
    expect(deep!.fieldTag).toBe("2026-05-11T06:00:00.000Z:sleep_deep");
  });

  it("yields nothing for a session with no parseable segments", () => {
    expect(mapSleepSession({ sleep: {} })).toHaveLength(0);
    expect(mapSleepSession({})).toHaveLength(0);
  });
});

describe("workout mapping", () => {
  it("maps an exercise session into a Workout shape with a stable externalId", () => {
    const w = mapWorkout({
      exercise: {
        session_id: "ex-123",
        activity_type: "run",
        startTime: "2026-05-10T07:00:00.000Z",
        endTime: "2026-05-10T07:45:00.000Z",
        active_kilocalories: 410,
        distance: { meters: 7800 },
        average_heart_rate: { beats_per_minute: 148 },
        maximum_heart_rate: { beats_per_minute: 172 },
      },
    });
    expect(w).not.toBeNull();
    expect(w).toMatchObject({
      externalId: "ex-123",
      sportType: "running",
      durationSec: 45 * 60,
      totalEnergyKcal: 410,
      totalDistanceM: 7800,
      avgHeartRate: 148,
      maxHeartRate: 172,
    });
    expect(w!.startedAt.toISOString()).toBe("2026-05-10T07:00:00.000Z");
  });

  it("falls back to a start-anchored externalId + 'other' sport when fields are absent", () => {
    const w = mapWorkout({
      exercise: {
        startTime: "2026-05-10T07:00:00.000Z",
        endTime: "2026-05-10T07:30:00.000Z",
      },
    });
    expect(w!.externalId).toBe("exercise:2026-05-10T07:00:00.000Z");
    expect(w!.sportType).toBe("other");
    expect(w!.totalEnergyKcal).toBeNull();
    expect(w!.avgHeartRate).toBeNull();
  });

  it("reads the start/end from exercise.interval for an INTERVAL-shaped point", () => {
    const w = mapWorkout({
      exercise: {
        session_id: "ex-iv",
        activity_type: "run",
        interval: {
          start_time: "2026-05-10T07:00:00.000Z",
          end_time: "2026-05-10T07:45:00.000Z",
        },
      },
    });
    expect(w).not.toBeNull();
    expect(w!.startedAt.toISOString()).toBe("2026-05-10T07:00:00.000Z");
    expect(w!.endedAt.toISOString()).toBe("2026-05-10T07:45:00.000Z");
    expect(w!.durationSec).toBe(45 * 60);
  });

  it("returns null for a session with no usable time span", () => {
    expect(mapWorkout({ exercise: { startTime: "2026-05-10T07:00:00.000Z" } })).toBeNull();
    expect(
      mapWorkout({
        exercise: {
          startTime: "2026-05-10T07:30:00.000Z",
          endTime: "2026-05-10T07:00:00.000Z", // end before start
        },
      }),
    ).toBeNull();
    expect(mapWorkout({})).toBeNull();
  });

  it("resolves Google activity types to canonical sport labels", () => {
    expect(mapFitbitSportType("Walk")).toBe("walking");
    expect(mapFitbitSportType("biking")).toBe("cycling");
    expect(mapFitbitSportType("weights")).toBe("strength");
    expect(mapFitbitSportType("unknown-sport")).toBe("other");
    expect(mapFitbitSportType("")).toBe("other");
  });
});
