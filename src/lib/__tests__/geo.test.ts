import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.IP_GEO_LOOKUP_URL;
  delete process.env.IP_GEO_LOOKUP_DISABLED;
  vi.resetModules();
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  vi.restoreAllMocks();
});

// V3 audit: /api/auth events were leaking IP + timestamp via plaintext
// HTTP to ip-api.com (GDPR Art. 32 + Art. 44). The lookup helper now
// (a) only egresses over HTTPS, (b) supports an opt-out env, and
// (c) accepts both ipwho.is and ip-api.com pro response shapes.
describe("lookupIpLocation IP-geolocation HTTPS guard", () => {
  it("returns null for private addresses without making any request", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { lookupIpLocation } = await import("../geo");

    expect(await lookupIpLocation("10.0.0.5")).toBeNull();
    expect(await lookupIpLocation("127.0.0.1")).toBeNull();
    expect(await lookupIpLocation("::1")).toBeNull();
    expect(await lookupIpLocation(null)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns null when IP_GEO_LOOKUP_DISABLED=1", async () => {
    process.env.IP_GEO_LOOKUP_DISABLED = "1";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { lookupIpLocation } = await import("../geo");

    expect(await lookupIpLocation("8.8.8.8")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // v1.4.16 A8a: helper turns a JS object into a real `Response` whose
  // body is the UTF-8 byte stream of `JSON.stringify(value)`. The geo
  // helper now reads via `arrayBuffer() + TextDecoder('utf-8')` so the
  // test fakes have to expose those, not just `json()`.
  function jsonOk(value: unknown): Response {
    return new Response(
      new TextEncoder().encode(JSON.stringify(value)).buffer as ArrayBuffer,
      {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    );
  }

  it("uses HTTPS by default (ipwho.is)", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(
        jsonOk({ success: true, city: "Berlin", country_code: "DE" }),
      );
    vi.stubGlobal("fetch", fetchSpy);
    const { lookupIpLocation } = await import("../geo");

    expect(await lookupIpLocation("8.8.8.8")).toBe("Berlin, DE");
    const url = fetchSpy.mock.calls[0]?.[0] as string;
    expect(url.startsWith("https://")).toBe(true);
  });

  it("refuses to call non-HTTPS configured providers", async () => {
    process.env.IP_GEO_LOOKUP_URL = "http://ip-api.com/json";
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response("", {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const { lookupIpLocation } = await import("../geo");

    const result = await lookupIpLocation("8.8.8.8");
    expect(result).toBeNull();
    const url = fetchSpy.mock.calls[0]?.[0] as string;
    // Even when an operator misconfigures HTTP, the helper rewrites the
    // URL to a deliberately invalid HTTPS URL so the egress is HTTPS-only.
    expect(url.startsWith("https://")).toBe(true);
  });

  it("accepts the ip-api pro response shape (status:'success', countryCode)", async () => {
    process.env.IP_GEO_LOOKUP_URL = "https://pro.ip-api.com/json";
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonOk({
        status: "success",
        city: "Hamburg",
        countryCode: "DE",
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const { lookupIpLocation } = await import("../geo");

    expect(await lookupIpLocation("8.8.8.8")).toBe("Hamburg, DE");
  });
});

// v1.4.16 A8a: Marc spotted "Nrnberg" rendered in /admin/login-overview
// for an audit row that should have read "Nürnberg, DE". The geo source
// (ipwho.is) returns valid UTF-8, but `Response.json()` defers its
// charset decoding to whatever the server's `Content-Type` header
// claims, so an upstream proxy that strips the charset parameter (or
// re-serves the body as latin-1) can poison the umlaut path. The fix
// reads the body as a UTF-8 ArrayBuffer first, then JSON.parses.
// The umlaut-roundtrip test is the regression guard.
describe("lookupIpLocation umlaut roundtrip (v1.4.16 A8a)", () => {
  // Build a Response-like that serves a UTF-8 byte stream — what ipwho.is
  // actually puts on the wire — instead of letting the Vitest test runner
  // hand the parser a pre-decoded JS object, which masks any
  // `Content-Type`-charset-driven decoding bug.
  function utf8JsonResponse(body: object): Response {
    return new Response(
      new TextEncoder().encode(JSON.stringify(body)).buffer as ArrayBuffer,
      {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    );
  }

  for (const city of [
    "Nürnberg",
    "München",
    "Düsseldorf",
    "Köln",
    "Würzburg",
    "Bückeburg",
  ]) {
    it(`preserves "${city}" through fetch → DB-ready string`, async () => {
      const fetchSpy = vi
        .fn()
        .mockResolvedValue(
          utf8JsonResponse({ success: true, city, country_code: "DE" }),
        );
      vi.stubGlobal("fetch", fetchSpy);
      const { lookupIpLocation } = await import("../geo");

      expect(await lookupIpLocation("8.8.8.8")).toBe(`${city}, DE`);
    });
  }

  it('preserves the eszett ("ß") in country/region names', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      utf8JsonResponse({
        success: true,
        city: "Weißenfels",
        country_code: "DE",
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const { lookupIpLocation } = await import("../geo");

    expect(await lookupIpLocation("8.8.8.8")).toBe("Weißenfels, DE");
  });

  it("survives a Content-Type header that omits the charset", async () => {
    // Defensive: some upstream proxies strip `; charset=utf-8`. The body
    // stays UTF-8 bytes; the helper must not let Response.json()'s
    // charset-defaulting behaviour hide an umlaut.
    const headers = new Headers({ "content-type": "application/json" });
    const body = new TextEncoder().encode(
      JSON.stringify({ success: true, city: "Nürnberg", country_code: "DE" }),
    );
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(body.buffer as ArrayBuffer, {
        status: 200,
        headers,
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const { lookupIpLocation } = await import("../geo");

    expect(await lookupIpLocation("8.8.8.8")).toBe("Nürnberg, DE");
  });

  it("hints providers it wants localized names via Accept-Language", async () => {
    // ipwho.is and ip-api both honour Accept-Language for the city
    // field; without the hint, ip-api falls back to English ASCII fold
    // ("Nuremberg"). Setting de;q=1, en;q=0.5 keeps the user-facing
    // text close to the locale the audit-log overview renders in.
    const fetchSpy = vi.fn().mockResolvedValue(
      utf8JsonResponse({
        success: true,
        city: "Nürnberg",
        country_code: "DE",
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const { lookupIpLocation } = await import("../geo");

    await lookupIpLocation("8.8.8.8");
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = new Headers(init?.headers ?? {});
    const al = headers.get("accept-language") ?? "";
    expect(al.toLowerCase()).toMatch(/de/);
  });
});
