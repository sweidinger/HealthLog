import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FITBIT_API_BASE,
  FITBIT_OAUTH_SCOPE,
  exchangeCode,
  fetchProfile,
  getAuthorizationUrl,
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
