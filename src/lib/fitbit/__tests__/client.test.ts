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
  mapBodyFat,
  mapHeartRateVariability,
  mapHeightCm,
  mapOxygenSaturation,
  mapRestingHeartRate,
  mapWeight,
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
