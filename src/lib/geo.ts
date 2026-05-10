/**
 * IP geolocation lookup for audit-log enrichment.
 *
 * Default provider is ipwho.is (HTTPS, free, no key). Both the response
 * shape from ipwho.is and the fallback ip-api.com pro endpoint are
 * accepted, so swapping providers via IP_GEO_LOOKUP_URL only requires
 * matching one of those response shapes.
 *
 * Setting IP_GEO_LOOKUP_DISABLED=1 disables lookup entirely — used by
 * deployments that do not want any IP egress to a third-party service
 * (V3 audit: GDPR Art. 32 + Art. 44, plaintext HTTP IP egress).
 *
 * v1.4.16 A8a: the body is decoded as UTF-8 explicitly via
 * `TextDecoder('utf-8')` instead of `Response.json()`, and an
 * `Accept-Language: de, en;q=0.5` hint is sent so providers return
 * native city names ("Nürnberg") rather than ASCII folds
 * ("Nuremberg"). The previous path lost umlauts in production for at
 * least one maintainer-flagged login row that rendered as "Nrnberg" in
 * /admin/login-overview — see `docs/audit/v1416-summary.md` once cut.
 */

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

const DEFAULT_GEO_URL = "https://ipwho.is";

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

export async function lookupIpLocation(
  ip: string | null,
): Promise<string | null> {
  if (!ip || PRIVATE_IP.test(ip)) return null;
  if (process.env.IP_GEO_LOOKUP_DISABLED === "1") return null;

  try {
    const res = await fetch(buildLookupUrl(ip), {
      signal: AbortSignal.timeout(3000),
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
    });
    if (!res.ok) return null;

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
