/**
 * IP geolocation lookup for audit-log enrichment.
 *
 * v1.18.10 (W7): online-first resolver. The `ipwho.is` HTTPS lookup
 * (free, no key) is the DEFAULT path — every self-host resolves a
 * location out of the box with no MaxMind licence configured. The
 * bundled MaxMind GeoLite2-City MMDB at `/opt/geolite2/GeoLite2-City.mmdb`
 * is an OPTIONAL fallback (perspective: removed later): it is consulted
 * only when the online lookup misses (provider down / rate-limited) or
 * when egress is disabled via `IP_GEO_LOOKUP_DISABLED=1`.
 *
 *   1. Private / loopback / opt-out → null (no lookup).
 *   2. Per-IP cache hit → return immediately.
 *   3. Online `ipwho.is` lookup → return on success.
 *   4. Offline MMDB present → local read fallback on an online miss.
 *
 * The legacy contract still holds: `lookupIpLocation` returns a
 * `"City, CC"` string or `null`, never throws. `lookupIpAsn` is the
 * new sibling that resolves the autonomous-system number + the carrier
 * organisation string (so the admin login overview can render a
 * carrier chip next to the auth provider).
 *
 * Both helpers are safe to call from any request context. The MMDB
 * Reader is loaded lazily on first call and held in a module-level
 * cache; the file load is synchronous and not cheap, but it only
 * happens once per worker process.
 *
 * The base path is overridable via `GEOLITE2_DIR` (default
 * `/opt/geolite2`). When the DB files are missing the helpers silently
 * skip the offline tier — local dev without the MMDBs still works and
 * falls straight back to the online provider.
 *
 * Default provider for the online lookup is ip-api.com (HTTPS JSON
 * endpoint). ipwho.is was the v1.18.10 default but rejects datacentre /
 * free-plan server egress with a 403, so it never resolved on prod. Both
 * the ipwho.is shape (`success`/`country_code`) and the ip-api.com shape
 * (`status`/`countryCode`) are accepted, so swapping providers via
 * `IP_GEO_LOOKUP_URL` only requires matching one of those response shapes.
 * A non-ok HTTP status (403/429/5xx) is surfaced on the wide event rather
 * than swallowed, so a future provider rejection is visible.
 *
 * Setting `IP_GEO_LOOKUP_DISABLED=1` disables the online lookup
 * entirely — used by deployments that do not want any IP egress to a
 * third-party service (V3 audit: GDPR Art. 32 + Art. 44, plaintext
 * HTTP IP egress). With egress disabled the resolver leans solely on
 * the offline MMDB tier (and returns null when that is also absent).
 *
 * Resolved locations are cached per IP in a small in-memory LRU
 * (`LOCATION_CACHE`) so a burst of audit events from the same client
 * does not hammer ipwho.is — the cache holds both hits and misses
 * (negative caching) for a bounded TTL.
 *
 * v1.4.16 A8a: the online-fallback body is decoded as UTF-8 explicitly
 * via `TextDecoder('utf-8')` instead of `Response.json()`, and an
 * `Accept-Language: de, en;q=0.5` hint is sent so providers return
 * native city names ("Nürnberg") rather than ASCII folds ("Nuremberg").
 * The previous path lost umlauts in production for at least one
 * maintainer-flagged login row that rendered as "Nrnberg" in
 * /admin/login-overview — see `docs/audit/v1416-summary.md`.
 *
 * v1.4.27 R5: the build no longer hard-fails on a missing
 * `MAXMIND_LICENSE_KEY` secret — the CI workflow drops an `.empty`
 * marker into the geo asset directory when the key is unset.
 * `offlineGeoReady()` is the canonical check used by `/api/version`
 * and the admin status surface, and the lookup paths fire a one-shot
 * admin notification on the first fallback so the maintainer hears
 * about the gap from the running app.
 */
import fs from "node:fs";
import path from "node:path";
import { Reader as MmdbReader } from "mmdb-lib";
import type { AsnResponse, CityResponse } from "mmdb-lib/lib/reader/response";
import { getEvent } from "@/lib/logging/context";
import { safeFetch } from "@/lib/safe-fetch";

interface IpwhoIsResponse {
  success?: boolean;
  city?: string;
  country_code?: string;
}

interface IpApiProResponse {
  status?: "success" | "fail";
  city?: string;
  countryCode?: string;
}

type GeoResponse = IpwhoIsResponse & IpApiProResponse;

const PRIVATE_IP =
  /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|::1|fc|fd|fe80|localhost|unknown)/;

// v1.25.5 — ipwho.is is the default online provider again (free, no key, no
// per-minute cap on the standard endpoint). The base is `https://ipwho.is`;
// `buildLookupUrl` appends `/<ip>` so the wire URL is `https://ipwho.is/<ip>`.
// The parser accepts BOTH the ipwho.is shape (`success` + `country_code`) and
// the ip-api.com shape (`status` + `countryCode`), so operators whose egress
// ipwho.is rejects can point `IP_GEO_LOOKUP_URL` at `https://ip-api.com/json`
// (or any keyed provider matching one of those shapes) with no code change.
// The offline GeoLite2 MMDB tier stays OPTIONAL — consulted only when the
// online lookup misses, and skipped entirely when the databases are absent.
const DEFAULT_GEO_URL = "https://ipwho.is";

function geoLiteDir(): string {
  return process.env.GEOLITE2_DIR ?? "/opt/geolite2";
}

// ── Per-IP location cache ────────────────────────────────────────────
//
// v1.15.12 E1: the online tier is now the baseline path, so a burst of
// audit events from the same address must not fan out one ipwho.is
// request each. We cache the resolved "City, CC" string per IP for a
// bounded TTL and also negative-cache misses (stored as null) so a
// non-resolving IP doesn't re-hit the provider every time. The map is a
// simple bounded FIFO — geo lookups are low-cardinality (a handful of
// distinct client IPs per worker) so an exact LRU is overkill.

const LOCATION_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 h
const LOCATION_CACHE_MAX = 512;
const LOCATION_CACHE = new Map<string, { value: string | null; at: number }>();

function getCachedLocation(ip: string): { value: string | null } | null {
  const hit = LOCATION_CACHE.get(ip);
  if (!hit) return null;
  if (Date.now() - hit.at > LOCATION_CACHE_TTL_MS) {
    LOCATION_CACHE.delete(ip);
    return null;
  }
  return { value: hit.value };
}

function setCachedLocation(ip: string, value: string | null): void {
  // Bound the map: drop the oldest insertion when full.
  if (LOCATION_CACHE.size >= LOCATION_CACHE_MAX) {
    const oldest = LOCATION_CACHE.keys().next().value;
    if (oldest !== undefined) LOCATION_CACHE.delete(oldest);
  }
  LOCATION_CACHE.set(ip, { value, at: Date.now() });
}

// ── Offline tier (MaxMind GeoLite2) ──────────────────────────────────
//
// Both readers are held in a process-local cache. We use `undefined`
// for "never tried", and `null` for "tried, file missing" so we don't
// pay the `existsSync + readFileSync + parse` cost on every lookup.

interface MmdbCache {
  city?: MmdbReader<CityResponse> | null;
  asn?: MmdbReader<AsnResponse> | null;
}

const cache: MmdbCache = {};

function loadMmdbReader<
  T extends import("mmdb-lib/lib/reader/response").Response,
>(file: string): MmdbReader<T> | null {
  try {
    const full = path.join(geoLiteDir(), file);
    if (!fs.existsSync(full)) return null;
    const buf = fs.readFileSync(full);
    return new MmdbReader<T>(buf);
  } catch {
    // Corrupt MMDB or unreadable file → fall back to online tier.
    // Never throw from the geo lookup path; the auth-audit caller is
    // fire-and-forget and a thrown error would propagate into an
    // unhandled rejection.
    return null;
  }
}

function getCityReader(): MmdbReader<CityResponse> | null {
  if (cache.city === undefined) {
    cache.city = loadMmdbReader<CityResponse>("GeoLite2-City.mmdb");
  }
  return cache.city;
}

function getAsnReader(): MmdbReader<AsnResponse> | null {
  if (cache.asn === undefined) {
    cache.asn = loadMmdbReader<AsnResponse>("GeoLite2-ASN.mmdb");
  }
  return cache.asn;
}

/**
 * Test-only — reset the lazy reader cache so a test can swap the
 * `GEOLITE2_DIR` between cases without leaking the previous Reader.
 * Not exported from the public surface; the tests import via the
 * module-level alias.
 */
export function __resetGeoLite2CacheForTests(): void {
  cache.city = undefined;
  cache.asn = undefined;
  notifiedThisProcess = false;
  LOCATION_CACHE.clear();
}

// ── Offline readiness + one-shot admin notification ─────────────────
//
// The CI workflow drops an `.empty` marker into the geo asset directory
// when the maintainer has not configured `MAXMIND_LICENSE_KEY`, in
// which case the City + ASN MMDBs are absent and every lookup hits the
// online fallback. `offlineGeoReady()` is the canonical truth used by
// `/api/version` and the admin status surface so the two paths cannot
// disagree.
//
// `notifiedThisProcess` is a module-level latch so the admin only
// receives the "offline geo is disabled" notification once per worker
// boot — every subsequent fallback hit is silent. Test-only reset is
// folded into the cache reset above.

let notifiedThisProcess = false;

export function offlineGeoReady(): boolean {
  try {
    const dir = geoLiteDir();
    if (fs.existsSync(path.join(dir, ".empty"))) return false;
    return fs.existsSync(path.join(dir, "GeoLite2-City.mmdb"));
  } catch {
    return false;
  }
}

async function notifyOfflineGeoUnavailable(): Promise<void> {
  if (notifiedThisProcess) return;
  notifiedThisProcess = true;
  // Defer the resolve so we don't pay the cost of pulling the
  // Prisma client into the import graph until the first fallback —
  // most calls are cache hits or private-IP short-circuits.
  try {
    const [{ prisma }, { dispatchLocalisedNotification }] = await Promise.all([
      import("@/lib/db"),
      import("@/lib/notifications/dispatch-localised"),
    ]);
    const admins = await prisma.user.findMany({
      where: { role: "ADMIN" },
      select: { id: true },
    });
    if (admins.length === 0) {
      getEvent()?.addWarning(
        "geo: offline databases unavailable, no admin user configured to notify",
      );
      return;
    }
    getEvent()?.addWarning(
      "geo: offline databases unavailable, falling back to ipwho.is — notifying admins",
    );
    for (const admin of admins) {
      await dispatchLocalisedNotification({
        userId: admin.id,
        titleKey: "notifications.admin.offlineGeoUnavailableTitle",
        messageKey: "notifications.admin.offlineGeoUnavailableBody",
        params: {
          secretsUrl:
            "https://github.com/MBombeck/HealthLog/settings/secrets/actions",
        },
        metadata: { source: "geo-offline-detection" },
      });
    }
  } catch (err) {
    // Never let a notification failure propagate — the auth-audit
    // caller is fire-and-forget.
    getEvent()?.addWarning(
      `geo: offline-geo notification failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Pick the best-available localised city name from a GeoLite2
 * record. German first because the user-base is DACH-skewed; English
 * as a graceful fallback for cities that don't have a German exonym.
 * The Names map is incomplete in MaxMind for some small German
 * towns, so we accept any of the locales the MMDB layout exposes.
 */
function pickCityName(city: CityResponse["city"]): string | null {
  if (!city?.names) return null;
  return (
    city.names.de ?? city.names.en ?? city.names.fr ?? city.names.es ?? null
  );
}

function lookupIpLocationOffline(ip: string): string | null {
  const reader = getCityReader();
  if (!reader) return null;
  try {
    const row = reader.get(ip);
    if (!row) return null;
    const city = pickCityName(row.city);
    const cc = row.country?.iso_code ?? row.registered_country?.iso_code;
    if (!city || !cc) return null;
    return `${city}, ${cc}`;
  } catch {
    return null;
  }
}

function buildLookupUrl(ip: string): string {
  const base = (process.env.IP_GEO_LOOKUP_URL ?? DEFAULT_GEO_URL).replace(
    /\/+$/,
    "",
  );
  if (!base.startsWith("https://")) {
    // V3 audit: never leak audit-event IPs over plaintext HTTP. Reject any
    // configuration that would do so by upgrading to https; if the operator
    // has explicitly opted into HTTP via env, we still refuse and return a
    // dummy URL the parser will fail on.
    return `https://invalid.invalid/refused-non-https/${encodeURIComponent(ip)}`;
  }
  return `${base}/${encodeURIComponent(ip)}`;
}

/**
 * Decode the raw response bytes as UTF-8, then JSON-parse. Bypasses
 * `Response.json()` so the result is independent of the upstream
 * `Content-Type: application/json; charset=…` value — relevant in
 * production where ipwho.is sits behind Cloudflare and an intermediate
 * proxy can re-serve the body without preserving the charset hint.
 * Falls back to whatever decoding errors `TextDecoder` produces (which
 * substitute U+FFFD rather than dropping bytes), so a malformed
 * response surfaces as a parse failure instead of silent character
 * loss.
 */
async function readUtf8Json(res: Response): Promise<unknown> {
  const buf = await res.arrayBuffer();
  const text = new TextDecoder("utf-8").decode(buf);
  return JSON.parse(text);
}

async function lookupIpLocationOnline(ip: string): Promise<string | null> {
  if (process.env.IP_GEO_LOOKUP_DISABLED === "1") return null;
  try {
    const res = await safeFetch(
      buildLookupUrl(ip),
      {
        headers: {
          // ipwho.is and ip-api both honour Accept-Language for the
          // city field. Without the hint, ip-api falls back to the
          // English ASCII fold ("Nuremberg" instead of "Nürnberg").
          // German first because the user-base is DACH-skewed; English
          // as a graceful fallback for cities that don't have a German
          // name. Quality 0.5 on the en fallback keeps providers from
          // tie-breaking the wrong way.
          "Accept-Language": "de, en;q=0.5",
          Accept: "application/json",
        },
      },
      // v1.11.2 — the lookup URL comes from the operator IP_GEO_LOOKUP_URL env;
      // pin the connect-time DNS check so it can't be pointed at a private /
      // metadata address (SSRF/rebinding).
      // v1.15.12 E1 — keep the online timeout below the audit-log 3 s race
      // window so a slow-but-successful lookup still lands before the race
      // resolves null and drops the location (the "—" symptom on apps01).
      { timeoutMs: 2_500, requirePublicHost: true },
    );
    if (!res.ok) {
      // v1.18.11 (W3) — a non-ok response (403 free-plan/CORS rejection,
      // 429 rate-limit, 5xx) is not a clean "this IP has no location": it is
      // a provider-level failure that, left silent, renders as "—" with no
      // signal anywhere. Surface it on the wide event so the next provider
      // rejection is visible instead of swallowed (the ipwho.is 403 that
      // caused the prod "—" never produced a single log line). Still return
      // null so the offline fallback / negative-cache path runs unchanged.
      getEvent()?.addWarning(
        `geo: online lookup returned HTTP ${res.status} — location not resolved`,
      );
      return null;
    }

    const data = (await readUtf8Json(res)) as GeoResponse;
    const ok =
      data.success === true ||
      data.status === "success" ||
      (data.city && (data.country_code ?? data.countryCode));
    if (!ok) return null;

    const city = data.city;
    const country = data.country_code ?? data.countryCode;
    if (!city || !country) return null;

    return `${city}, ${country}`;
  } catch {
    return null;
  }
}

export async function lookupIpLocation(
  ip: string | null,
): Promise<string | null> {
  if (!ip || PRIVATE_IP.test(ip)) return null;

  const cached = getCachedLocation(ip);
  if (cached) return cached.value;

  // v1.18.10 (W7) — online-first by default. The `ipwho.is` HTTPS lookup
  // is now the primary resolver for every self-host: it needs no MaxMind
  // licence and resolves a location out of the box. The bundled GeoLite2
  // offline tier is an OPTIONAL fallback kept only for the egress-disabled
  // case (`IP_GEO_LOOKUP_DISABLED=1`) or for an online miss when the DBs
  // happen to be present — it is no longer the default path, and a missing
  // offline tier is the expected baseline rather than a gap to alert on.
  const online = await lookupIpLocationOnline(ip);
  if (online) {
    setCachedLocation(ip, online);
    return online;
  }

  // Online missed (provider down, rate-limited, or egress disabled). Fall
  // back to the offline MMDB if the operator configured one.
  if (offlineGeoReady()) {
    const offline = lookupIpLocationOffline(ip);
    if (offline) {
      setCachedLocation(ip, offline);
      return offline;
    }
  } else {
    // Neither resolver produced a location: the online lookup missed (or
    // egress is disabled) AND no offline tier is configured. That is the
    // only genuine "no resolver at all" gap — fire the one-shot admin alert
    // so the maintainer can wire `MAXMIND_LICENSE_KEY` or re-enable egress.
    // The happy path (ipwho.is resolving by default) never reaches here, so
    // a self-host without the offline DBs is not nagged on every lookup.
    void notifyOfflineGeoUnavailable();
  }

  setCachedLocation(ip, null);
  return null;
}

/**
 * Resolve the autonomous-system number + carrier organisation for an
 * IP. Offline-only against the bundled GeoLite2-ASN MMDB — the public
 * `ipwho.is` endpoint does not expose an ASN field in its free tier,
 * so a miss returns `null` rather than falling back to an online
 * lookup.
 *
 * Private / loopback IPs return `null` without touching the reader.
 * Same gate the location helper applies.
 */
export function lookupIpAsn(
  ip: string | null,
): { asn: number; carrier: string | null } | null {
  if (!ip || PRIVATE_IP.test(ip)) return null;
  const reader = getAsnReader();
  if (!reader) {
    // No offline ASN data — alert once per process. There is no online
    // fallback for ASN, but the maintainer still wants to know the
    // carrier chip is going to stay empty until the secret is set.
    if (!offlineGeoReady()) {
      void notifyOfflineGeoUnavailable();
    }
    return null;
  }
  try {
    const row = reader.get(ip);
    if (!row) return null;
    const asn = row.autonomous_system_number;
    if (typeof asn !== "number") return null;
    const carrier = row.autonomous_system_organization || null;
    return { asn, carrier };
  } catch {
    return null;
  }
}
