/**
 * First-party web-handoff login (iOS #65) — server-only support.
 *
 * The iOS app's `webcredentials` entitlement is compiled to the managed domain,
 * so on a self-hosted domain saved passwords mis-file and passkeys cannot run
 * (origin mismatch). The fix runs the login in the instance's real web origin
 * inside an `ASWebAuthenticationSession`; after a successful web login the
 * server hands the app a single-use handoff code on a compiled-in custom scheme,
 * which the app exchanges for the standard native token bundle.
 *
 * This module owns the flow's compile-time constants, its encrypted state-cookie
 * codec, and the DB-clock helper the freshness binding depends on. The mint /
 * consume core is the shared `./native-handoff.ts`.
 *
 * Server-only: imports `prisma` + the crypto helpers. The web login PAGE must
 * NOT import this (it only navigates to the relative `/api/auth/native/complete`
 * path and reads `flow` from the query string).
 */
import { prisma } from "@/lib/db";
import { encrypt, decrypt } from "@/lib/crypto";
import { buildHandoffCallbackUrl } from "@/lib/auth/native-handoff";

/**
 * The ONLY callback target for the web-handoff flow. Compiled-in, not operator-
 * or client-supplied — there is no `redirect_uri` parameter anywhere, so the
 * open-redirect / scheme-hijack class is removed by construction. Kept next to
 * the OIDC leg's `NATIVE_OIDC_REDIRECT_URI` so both live in one named place and
 * either can be corrected once before release. Pending iOS confirmation of the
 * exact path (`login-callback` vs a param on `oidc-callback`); the scheme stays
 * `healthlog` either way.
 */
export const NATIVE_WEB_HANDOFF_REDIRECT_URI = "healthlog://login-callback";

/**
 * The encrypted state cookie carrying `{ appCodeChallenge, startedAt }` from the
 * authorize entry (`/api/auth/native/login`) to the completion endpoint
 * (`/api/auth/native/complete`). AES-256-GCM (fresh IV + auth tag per write, via
 * `encrypt`), httpOnly, SameSite=Lax, path-scoped, short-lived — the exact
 * proven shape of `oidc_auth_state`.
 */
export const NATIVE_HANDOFF_STATE_COOKIE = "native_auth_state";
/**
 * RFC 6265 keys a cookie by (name, domain, path) — a delete must repeat the
 * exact path the set used. Only the completion endpoint ever reads it.
 */
export const NATIVE_HANDOFF_STATE_COOKIE_PATH = "/api/auth/native";
/**
 * 10-minute state TTL — a human typing a password (and possibly a TOTP) fits
 * comfortably. The 90-second window applies to the minted CODE, not the login.
 */
export const NATIVE_HANDOFF_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Closed set of machine-readable error reasons the completion / authorize
 * endpoints put on `healthlog://login-callback?error=<reason>`. Not i18n's
 * concern — the app maps them; the web side never renders them.
 */
export type NativeHandoffErrorReason =
  | "invalid_request"
  | "rate_limited"
  | "invalid_state"
  | "no_session"
  | "stale_session"
  | "user_missing";

interface NativeHandoffState {
  /** The app's S256 PKCE challenge, bound at the authorize entry. */
  appCodeChallenge: string;
  /**
   * DB-clock instant the flow started (ISO string of `SELECT now()`), so it is
   * directly comparable to `Session.createdAt` (`@default(now())`, also DB-side)
   * with no app/DB skew — red-team A1. The completion route requires
   * `session.createdAt >= startedAt`.
   */
  startedAt: string;
}

/** Encrypt the state blob for the cookie value. */
export function encodeNativeHandoffState(state: NativeHandoffState): string {
  return encrypt(JSON.stringify(state));
}

/**
 * Decrypt + shape-validate the state cookie. Returns null for a missing,
 * undecryptable (tampered / forged — AES-256-GCM is authenticated), or
 * malformed blob. A `startedAt` that does not parse to a real date is rejected.
 */
export function decodeNativeHandoffState(
  raw: string | undefined | null,
): NativeHandoffState | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(decrypt(raw));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof (parsed as Record<string, unknown>).appCodeChallenge !==
        "string" ||
      typeof (parsed as Record<string, unknown>).startedAt !== "string"
    ) {
      return null;
    }
    const state = parsed as NativeHandoffState;
    if (Number.isNaN(new Date(state.startedAt).getTime())) return null;
    return state;
  } catch {
    return null;
  }
}

/**
 * Build the web-handoff callback redirect from the compiled-in constant plus
 * query-escaped params only. Nothing client-sent is echoed into `Location`.
 */
export function buildWebHandoffCallbackUrl(
  params: Record<string, string>,
): string {
  return buildHandoffCallbackUrl(NATIVE_WEB_HANDOFF_REDIRECT_URI, params);
}

/**
 * Read the database clock. The freshness binding compares `startedAt` against
 * `Session.createdAt`, which Postgres stamps via the column `DEFAULT now()`;
 * stamping `startedAt` from the same clock (rather than the app's `Date.now()`)
 * removes the app/DB skew a remote-Postgres self-host could carry — red-team A1.
 * Tagged-template `$queryRaw` — parameter-free, no interpolation.
 */
export async function nativeHandoffDbNow(): Promise<Date> {
  const rows = await prisma.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
  return rows[0].now;
}
