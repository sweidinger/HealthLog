/**
 * OAuth client resolution — CIMD-first, DCR fallback (Phase 3 of the MCP
 * milestone; changes B's DCR-first plan per the deep-value research).
 *
 * Both Claude.ai and ChatGPT now prefer **CIMD** (Client ID Metadata Documents,
 * SEP-991): the `client_id` IS an HTTPS URL that resolves to a JSON metadata
 * document describing the client. CIMD removes the per-connection client-row
 * explosion that DCR causes — and, here, removes the need for ANY client store.
 * A CIMD client is resolved by fetching its document THROUGH `safeFetch`
 * (SSRF-safe: `requirePublicHost`, manual redirects, bounded timeout) so a
 * malicious `client_id` cannot point the AS at an internal host (R-SEC-6).
 *
 * For clients that still use **DCR** (RFC 7591) we register them statelessly:
 * the issued `client_id` is itself a signed, self-describing `hlc_` artifact
 * (see `artifacts.ts`) carrying the registered `redirect_uris` + name. Decoding
 * it locally recovers the registration with no table — and tampering with it
 * fails the HMAC.
 *
 * Redirect-URI matching is exact against the registered set, with ONE tolerated
 * relaxation: loopback redirect URIs match port-agnostically (Claude Code /
 * Desktop bind an ephemeral localhost port), per the connector spec. The
 * `https://claude.ai/api/mcp/auth_callback` hosted callback is matched as an
 * ordinary registered entry.
 */
import { safeFetch } from "@/lib/safe-fetch";
import { ARTIFACT_KINDS, signArtifact, verifyArtifact } from "./artifacts";

export interface ResolvedClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  /** CIMD + DCR public clients authenticate with `none` (PKCE is the proof). */
  isPublic: true;
  source: "cimd" | "dcr";
}

export type ClientResolution =
  | { ok: true; client: ResolvedClient }
  | {
      ok: false;
      reason: "unknown_client" | "invalid_metadata" | "ssrf_blocked";
    };

const MAX_REDIRECT_URIS = 12;
const CIMD_MAX_BYTES = 16 * 1024;

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== "string" || v.length === 0 || v.length > 2048) return null;
    out.push(v);
  }
  if (out.length === 0 || out.length > MAX_REDIRECT_URIS) return null;
  return out;
}

/** A `client_id` that is an HTTPS URL is a CIMD client (SEP-991). */
export function isCimdClientId(clientId: string): boolean {
  try {
    return new URL(clientId).protocol === "https:";
  } catch {
    return false;
  }
}

/** A `client_id` minted by our stateless DCR endpoint. */
export function isDcrClientId(clientId: string): boolean {
  return clientId.startsWith(ARTIFACT_KINDS.clientId.prefix);
}

/**
 * Register a client via DCR (RFC 7591). The returned `client_id` is a signed
 * `hlc_` artifact that encodes the registration — no row is written. DCR clients
 * never expire (the artifact has a long horizon) but carry no secret.
 */
export function registerDcrClient(input: {
  clientName: string;
  redirectUris: string[];
}): ResolvedClient {
  const clientId = signArtifact(
    "clientId",
    { name: input.clientName, redirect_uris: input.redirectUris },
    // Ten-year horizon: a registration is long-lived but still self-expiring.
    10 * 365 * 24 * 60 * 60 * 1000,
  );
  return {
    clientId,
    clientName: input.clientName,
    redirectUris: input.redirectUris,
    isPublic: true,
    source: "dcr",
  };
}

function resolveDcrClient(clientId: string): ClientResolution {
  const verified = verifyArtifact<{ name?: string; redirect_uris?: unknown }>(
    "clientId",
    clientId,
  );
  if (!verified.ok) return { ok: false, reason: "unknown_client" };
  const redirectUris = asStringArray(verified.claims.redirect_uris);
  if (!redirectUris) return { ok: false, reason: "invalid_metadata" };
  return {
    ok: true,
    client: {
      clientId,
      clientName:
        typeof verified.claims.name === "string"
          ? verified.claims.name
          : "MCP client",
      redirectUris,
      isPublic: true,
      source: "dcr",
    },
  };
}

async function resolveCimdClient(clientId: string): Promise<ClientResolution> {
  let res: Response;
  try {
    // SSRF floor: the metadata host is fully user-controlled, so pin the
    // connect-time public-host check + manual redirects + bounded timeout.
    res = await safeFetch(
      clientId,
      { method: "GET", headers: { accept: "application/json" } },
      { requirePublicHost: true, timeoutMs: 8000 },
    );
  } catch {
    return { ok: false, reason: "ssrf_blocked" };
  }
  if (!res.ok) return { ok: false, reason: "unknown_client" };

  const raw = await res.text();
  if (raw.length > CIMD_MAX_BYTES) {
    return { ok: false, reason: "invalid_metadata" };
  }
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "invalid_metadata" };
  }

  // SEP-991: the document's `client_id` MUST equal the URL it was fetched from.
  if (doc.client_id !== clientId) {
    return { ok: false, reason: "invalid_metadata" };
  }
  const redirectUris = asStringArray(doc.redirect_uris);
  if (!redirectUris) return { ok: false, reason: "invalid_metadata" };

  return {
    ok: true,
    client: {
      clientId,
      clientName:
        typeof doc.client_name === "string" ? doc.client_name : "MCP client",
      redirectUris,
      isPublic: true,
      source: "cimd",
    },
  };
}

/**
 * Resolve a `client_id` to its registration. HTTPS URLs are CIMD (fetched
 * SSRF-safely); `hlc_` ids are stateless DCR; anything else is unknown.
 */
export async function resolveClient(
  clientId: string,
): Promise<ClientResolution> {
  if (typeof clientId !== "string" || clientId.length === 0) {
    return { ok: false, reason: "unknown_client" };
  }
  if (isCimdClientId(clientId)) return resolveCimdClient(clientId);
  if (isDcrClientId(clientId)) return resolveDcrClient(clientId);
  return { ok: false, reason: "unknown_client" };
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function isLoopback(url: URL): boolean {
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * Whether `requested` is an allowed redirect URI for `registered`. Exact match
 * by default; loopback URIs match port-agnostically (the AS ignores the port for
 * `localhost` / `127.0.0.1` / `::1`, per the connector spec) so Claude Code /
 * Desktop's ephemeral callback port still matches its registration.
 */
export function redirectUriAllowed(
  requested: string,
  registered: readonly string[],
): boolean {
  if (registered.includes(requested)) return true;

  let req: URL;
  try {
    req = new URL(requested);
  } catch {
    return false;
  }
  if (!isLoopback(req)) return false;

  for (const entry of registered) {
    let reg: URL;
    try {
      reg = new URL(entry);
    } catch {
      continue;
    }
    if (
      isLoopback(reg) &&
      reg.hostname === req.hostname &&
      reg.pathname === req.pathname
    ) {
      return true; // ignore the port for loopback
    }
  }
  return false;
}
