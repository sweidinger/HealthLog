import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import type { User } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { WideEventBuilder } from "./logging/event-builder";
import { eventStorage, getEvent } from "./logging/context";
import { emitIfSampled } from "./logging/transports";
import { redactOptional, redactSecrets } from "./logging/redact";
import { getSession } from "./auth/session";
import { auditLog } from "./auth/audit";
import { resolveBearerToken, BearerAuthError } from "./auth/bearer";
import { AssistantDisabledError } from "./feature-flags";
import { ConsentRequiredError } from "./ai/consent-guard";
import { SCOPE_HEALTH_READ, SCOPE_HEALTH_WRITE } from "./mcp/oauth/config";

/**
 * HTTP methods a read-only credential may use on the REST surface. A request
 * with any other method (POST / PUT / PATCH / DELETE) is a write.
 *
 * The MCP-audience guard below assumes these methods are side-effect-free:
 * an MCP-bound token is admitted on them. A future side-effecting GET (or HEAD)
 * would silently widen that token's reach over REST — do NOT add one without
 * revisiting the MCP audience binding here.
 */
const READ_HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Whether a token is MCP-audience-bound (H1). The MCP OAuth bridge and the
 * connector settings card mint tokens whose ONLY grants are `health:read` —
 * and, when the user consents to logging, `health:read health:write`. Either
 * shape is bound to the MCP surface: the `/mcp` resolver accepts it and so do
 * safe (read) REST methods, but it must NEVER reach a REST write/delete. The
 * `health:write` grant admits writes ONLY in-process over `/mcp` (the confirmed
 * write tools), never over REST — so a write-scoped MCP token is exactly as
 * audience-bound on this edge as a read-only one. A token carrying any broader
 * or legacy grant (`*`, `medication:ingest`, …) is NOT MCP-audience-bound and
 * keeps its existing reach.
 */
export function isMcpAudienceToken(permissions: readonly string[]): boolean {
  if (permissions.length === 0) return false;
  return permissions.every(
    (p) => p === SCOPE_HEALTH_READ || p === SCOPE_HEALTH_WRITE,
  );
}

/**
 * Custom error class for HTTP errors with status codes.
 * Throw inside apiHandler-wrapped routes to return a JSON error response.
 */
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * Wraps an API route handler with Wide Event logging.
 * Creates a WideEventBuilder, runs the handler inside AsyncLocalStorage,
 * catches errors, and emits the event on completion.
 *
 * No CSRF check — HealthLog does not use CSRF tokens.
 * Auth annotation happens in routes via requireAuth().
 */
// Read a property from a request-like value without invoking native
// private-field getters (NextRequest.method / .url / .headers access
// `this.#state` and crash with `Cannot read private member #state from
// an object whose class did not declare it` when the request is a
// Proxy or a synthetic placeholder — Next 16 passes such placeholders
// to `force-static` route handlers during dev). We probe defensively
// and fall back to safe defaults so logging instrumentation never
// crashes the handler.
//
// The catch is narrowed to two well-known shapes: the V8 private-field
// TypeError, and the `Cannot read properties of undefined/null` shape
// raised when the wrapper is invoked without a request (vitest tests
// frequently invoke handlers as `GET()` with no args, mirroring the
// shape Next.js exercises for the static-export pass). Any other
// exception is a real bug in the read callback or in a downstream
// header parser and must surface — swallowing it would hide
// regressions in production instrumentation.
function isTolerableRequestProbeError(err: unknown): boolean {
  if (!(err instanceof TypeError)) return false;
  const msg = err.message ?? "";
  return (
    // V8 — current
    msg.includes("private member") ||
    // V8 — alternative
    msg.includes("private field") ||
    // Bun / older V8
    msg.includes("private name") ||
    // No request handed in at all (vitest direct-invoke or
    // force-static placeholder reduced to undefined / null).
    // Covers both modern `Cannot read properties of undefined
    // (reading 'X')` and the older `Cannot read property 'X' of
    // undefined` wordings.
    /Cannot read propert(?:y|ies)\b.*\bof (?:undefined|null)\b/.test(msg)
  );
}

function safeRequestProp<R>(
  request: unknown,
  read: (req: NextRequest) => R,
  fallback: R,
): R {
  try {
    return read(request as NextRequest);
  } catch (err) {
    if (isTolerableRequestProbeError(err)) {
      // v1.4.27 B7 / BL-P1-3 — surface every fallback so a real read
      // regression cannot hide behind the tolerated-error narrowing.
      // Vitest direct-invoke and the force-static placeholder path are
      // the two known-quiet shapes; anything else worth a look should
      // show up in the dev console + the run log.
      if (process.env.NODE_ENV !== "test") {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[api-handler] safeRequestProp fallback — tolerable error: ${msg}`,
        );
      }
      return fallback;
    }
    throw err;
  }
}

/** @internal — exposed for unit tests of the narrow-catch contract. */
export const __testables = {
  safeRequestProp,
  isTolerableRequestProbeError,
};

// Next.js route handlers come in two shapes — `(request)` for static routes
// and `(request, { params })` for dynamic ones. The variadic generic is the
// only signature TS accepts that covers both at the call site. The `any[]`
// here is constrained by the bound (T must return Promise<Response>) so it
// does not loosen handler bodies — only their parameter list.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function apiHandler<T extends (...args: any[]) => Promise<Response>>(
  handler: T,
): T {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrapped = async (...args: any[]): Promise<Response> => {
    const request = args[0] as NextRequest;
    const requestUrl = safeRequestProp(request, (r) => r.url, "");
    const url = (() => {
      try {
        return new URL(requestUrl);
      } catch {
        // No usable URL (e.g. force-static placeholder) — fall back to
        // a synthetic origin so the rest of the pipeline can still
        // attach a pathname.
        return new URL("http://localhost/");
      }
    })();

    const evt = new WideEventBuilder("http");

    // Propagate x-request-id if present
    const incomingRequestId = safeRequestProp(
      request,
      (r) => r.headers.get("x-request-id"),
      null,
    );
    if (incomingRequestId) evt.setRequestId(incomingRequestId);

    evt.setHttp({
      method: safeRequestProp(request, (r) => r.method, "GET"),
      path: url.pathname,
      route: url.pathname,
      status: 200,
      user_agent:
        safeRequestProp(request, (r) => r.headers.get("user-agent"), null) ??
        undefined,
      ip:
        safeRequestProp(
          request,
          (r) => r.headers.get("x-forwarded-for")?.split(",")[0]?.trim(),
          null,
        ) ||
        safeRequestProp(request, (r) => r.headers.get("x-real-ip"), null) ||
        undefined,
    });

    return eventStorage.run(evt, async () => {
      let response: Response | undefined;
      try {
        response = await handler(...args);
      } catch (error) {
        if (error instanceof AssistantDisabledError) {
          // v1.4.31 — operator has disabled the assistant surface.
          // The 403 + `errorCode: "assistant.disabled.<surface>"`
          // envelope is locked per
          // `.planning/RESPONSE-TO-IOS-TEAM-2026-05-16.md` §3 R5.
          // Older iOS clients that don't know the errorCode surface
          // this as a generic 403; v1.4.31+ clients can branch on the
          // errorCode to render an inline operator-disabled notice.
          evt.setError(error);
          response = NextResponse.json(
            {
              data: null,
              error: error.message,
              meta: { errorCode: error.errorCode },
            },
            { status: 403 },
          );
        } else if (error instanceof ConsentRequiredError) {
          // v1.12.1 — server-side consent gate before external-LLM PHI
          // egress on the operator's server-managed key. Mirrors the
          // AssistantDisabledError envelope (403 + meta.errorCode) so the
          // iOS client renders an inline "grant consent" notice instead of
          // a generic failure.
          evt.setError(error);
          response = NextResponse.json(
            {
              data: null,
              error: error.message,
              meta: { errorCode: error.errorCode },
            },
            { status: 403 },
          );
        } else if (error instanceof StepUpRequiredError) {
          // v1.23 — step-up gate not satisfied. Same 401 + meta.errorCode
          // envelope shape as the assistant/consent gates so the client can
          // branch on the stable code and launch a re-verification flow.
          // Checked before the generic HttpError branch because
          // StepUpRequiredError extends it.
          evt.setError(error);
          response = NextResponse.json(
            {
              data: null,
              error: error.message,
              meta: { errorCode: error.errorCode },
            },
            { status: error.statusCode },
          );
        } else if (error instanceof HttpError) {
          evt.setError(error);
          response = NextResponse.json(
            { data: null, error: error.message },
            { status: error.statusCode },
          );
        } else if (error instanceof SyntaxError) {
          evt.setError(error);
          response = NextResponse.json(
            { data: null, error: "Invalid JSON body" },
            { status: 400 },
          );
        } else {
          evt.setError(error);
          // Report to GlitchTip (fire-and-forget)
          reportToGlitchtip(error, request, evt).catch(() => {});
          response = NextResponse.json(
            { data: null, error: "Interner Serverfehler" },
            { status: 500 },
          );
        }
      } finally {
        const status = (response as Response | undefined)?.status ?? 500;
        evt.finish(status);
        try {
          emitIfSampled(evt.toJSON());
        } catch {
          /* logging must never crash the handler */
        }
      }
      const nr = response as NextResponse;
      nr.headers.set("x-request-id", evt.getRequestId());
      return nr;
    });
  };
  return wrapped as T;
}

/**
 * Authenticated request context. Returned by both session-cookie and Bearer-token
 * authentication paths. The `session.id` is the session-record id for cookie auth
 * and the `ApiToken` id for bearer auth — callers must not assume the id refers
 * to a Session row.
 */
export type AuthContext = {
  session: { id: string; expiresAt: Date };
  user: User;
};

/**
 * Require an authenticated request. Throws HttpError(401) / HttpError(403) on failure.
 *
 * Auth precedence (cookie-first, never both):
 *   1. Valid session cookie → cookie path (existing behaviour, requiredPermission ignored).
 *   2. No cookie + `Authorization: Bearer hlk_<...>` → API token path.
 *   3. Neither → 401.
 *
 * @param requiredPermission Optional permission scope. Only enforced for Bearer
 *   auth — cookie sessions always pass (full user access). When set and missing
 *   from `ApiToken.permissions`, throws HttpError(403).
 */
export async function requireAuth(
  requiredPermission?: string,
): Promise<AuthContext> {
  // 1. Session cookie path — unchanged.
  const sessionData = await getSession();
  if (sessionData) {
    const evt = getEvent();
    if (evt) {
      evt.setAuth({
        user_id: sessionData.user.id,
        user_role: sessionData.user.role,
        auth_method: "session",
      });
    }
    return sessionData;
  }

  // 2. Bearer-token path.
  // `headers()` is only valid inside a Next.js request scope. Outside one
  // (e.g. during direct unit tests of legacy routes that pre-date Bearer auth)
  // we treat the absence of a header context as "no Bearer present" and fall
  // through to the unauthenticated case below.
  let authHeader: string | null = null;
  try {
    const headerList = await headers();
    authHeader = headerList.get("authorization");
  } catch {
    authHeader = null;
  }
  if (authHeader?.startsWith("Bearer ")) {
    return await authenticateBearer(authHeader.slice(7), requiredPermission);
  }

  // 3. No credentials.
  throw new HttpError(401, "Not authenticated");
}

/**
 * Authenticate a raw Bearer token against `ApiToken`.
 *
 * The validation itself lives in the transport-agnostic `resolveBearerToken`
 * (`./auth/bearer`) — the single source of truth shared with the MCP wire. This
 * wrapper adds the HTTP-edge concerns: the `auth.bearer.failure` audit trail
 * (only the failure path writes a durable audit row — the success row was
 * intentionally dropped for perf) and the Wide-Event `auth_method: "bearer"`
 * annotation, then maps the result onto the `AuthContext` contract
 * (`session.id` carries the token id).
 *
 * Authorisation contract (unchanged): a route that declares no
 * `requiredPermission` accepts any valid token; one that declares a scope
 * accepts wildcard (`["*"]`) tokens and narrow-scope tokens that list it.
 */
async function authenticateBearer(
  rawToken: string,
  requiredPermission: string | undefined,
): Promise<AuthContext> {
  let resolution;
  try {
    resolution = await resolveBearerToken(rawToken, requiredPermission);
  } catch (err) {
    if (err instanceof BearerAuthError) {
      auditLog("auth.bearer.failure", {
        userId: err.userId ?? null,
        details: {
          reason: err.reason,
          ...(err.tokenId ? { tokenId: err.tokenId } : {}),
          ...(err.reason === "insufficient_permissions"
            ? { required: requiredPermission }
            : {}),
        },
      }).catch(() => {});
      const message =
        err.statusCode === 403
          ? "Insufficient permissions"
          : err.reason === "expired"
            ? "Token expired"
            : "Invalid token";
      throw new HttpError(err.statusCode, message);
    }
    throw err;
  }

  const { user, tokenId, expiresAt, permissions } = resolution;

  // H1 — audience binding at the resource server. An MCP-audience token
  // (`health:read`, or `health:read health:write`) is bound to the `/mcp`
  // surface; it may reach `/mcp` (a separate resolver that never runs this
  // edge) and safe REST reads, but a write/delete over REST is outside its
  // audience and is refused — INCLUDING a write-scoped token, whose writes are
  // confined to the in-process `/mcp` tools and never granted over REST. Fail
  // closed when the method is unknown
  // (no event context) since every real REST request runs inside apiHandler,
  // which always sets the method — an unknown method means we cannot prove a
  // read, so we deny. This is RFC 8707 audience binding on the credential the
  // client actually holds, not only during the OAuth exchange.
  if (isMcpAudienceToken(permissions)) {
    const method = (getEvent()?.getHttpMethod() ?? "").toUpperCase();
    if (!READ_HTTP_METHODS.has(method)) {
      auditLog("auth.bearer.failure", {
        userId: user.id,
        details: {
          reason: "mcp_audience_write_blocked",
          tokenId,
          method: method || "unknown",
        },
      }).catch(() => {});
      throw new HttpError(403, "Insufficient permissions");
    }
  }

  // v1.25 — no per-request success audit row. The polling iOS client drove a
  // constant INSERT + pool checkout on every authenticated Bearer request; the
  // wide event below already records `auth_method: "bearer"` + `user_id`, so the
  // success path stays fully observable without the write churn. The failure
  // path keeps its audit row.
  const evt = getEvent();
  if (evt) {
    evt.setAuth({
      user_id: user.id,
      user_role: user.role,
      auth_method: "bearer",
    });
  }

  return {
    session: { id: tokenId, expiresAt },
    user,
  };
}

/**
 * Require an authenticated admin user. Throws HttpError(401) or HttpError(403).
 * Cookie-only — Bearer tokens never elevate to admin (security boundary).
 * Automatically annotates the Wide Event with auth context.
 */
export async function requireAdmin(): Promise<AuthContext> {
  const sessionData = await getSession();
  if (!sessionData) throw new HttpError(401, "Not authenticated");

  const evt = getEvent();
  if (evt) {
    evt.setAuth({
      user_id: sessionData.user.id,
      user_role: sessionData.user.role,
      auth_method: "session",
    });
  }

  if (sessionData.user.role !== "ADMIN") {
    throw new HttpError(403, "Admin access required");
  }
  return sessionData;
}

/**
 * v1.23 — require a cookie-backed session, refusing Bearer tokens.
 *
 * Cookie-only by the same structural argument as `requireAdmin`: it resolves
 * the session via `getSession()` (which reads only the session cookie) and
 * never falls through to the Bearer branch. The second-factor management
 * surfaces (TOTP enroll / confirm / disable / recovery-code regenerate) use
 * this so an API token — even a wildcard one — can never enrol or tear down
 * MFA on the account it belongs to. MFA management is a browser-only action.
 */
export async function requireCookieAuth(): Promise<AuthContext> {
  const sessionData = await getSession();
  if (!sessionData) throw new HttpError(401, "Not authenticated");

  const evt = getEvent();
  if (evt) {
    evt.setAuth({
      user_id: sessionData.user.id,
      user_role: sessionData.user.role,
      auth_method: "session",
    });
  }
  return sessionData;
}

/**
 * Error thrown when a step-up gate is not satisfied. Carries `errorCode` so
 * the route can surface a stable machine code (`auth.stepup.required`) the
 * client branches on to launch a re-verification flow rather than parsing
 * prose.
 */
export class StepUpRequiredError extends HttpError {
  constructor(
    public errorCode: string = "auth.stepup.required",
    message = "Recent second-factor verification required",
  ) {
    super(401, message);
    this.name = "StepUpRequiredError";
  }
}

/**
 * Default step-up freshness window (5 minutes) for sensitive mutations.
 * Within the 5–15 min band OWASP recommends; tight end because the gated
 * actions (disable MFA, regenerate codes, and later key rotation / export)
 * are destructive.
 */
export const MFA_STEP_UP_MAX_AGE_SECONDS = 5 * 60;

export type FreshMfaContext = AuthContext & { mfaVerifiedAt: Date };

/**
 * v1.23 — step-up gate. Passes only for a COOKIE session whose
 * `Session.mfaVerifiedAt` is within `maxAgeSeconds` AND whose user has an
 * active second factor (`totpConfirmedAt`). Throws `StepUpRequiredError`
 * (401, `errorCode: "auth.stepup.required"`) otherwise.
 *
 * Bearer tokens can NEVER satisfy this — exactly like `requireAdmin`, the
 * resolution path is `getSession()` (cookie-only) and there is no Bearer
 * fall-through. A token transport carries no `mfaVerifiedAt` and cannot
 * acquire one, so the boundary is structural, not a softenable runtime check.
 *
 * Consumed in Phase M by MFA disable + recovery-code regeneration; later
 * waves gate account deletion, key rotation, and passphrase export on it.
 */
export async function requireFreshMfa(
  maxAgeSeconds: number,
): Promise<FreshMfaContext> {
  const sessionData = await getSession();
  if (!sessionData) throw new HttpError(401, "Not authenticated");

  const evt = getEvent();
  if (evt) {
    evt.setAuth({
      user_id: sessionData.user.id,
      user_role: sessionData.user.role,
      auth_method: "session",
    });
  }

  // The user must actually have a second factor active. A single-factor
  // account cannot produce a fresh-MFA proof, so step-up-gated actions are
  // unreachable for it by design (the management UI gates enrolment first).
  // Either factor counts: a confirmed TOTP secret OR a registered WebAuthn
  // security key — both stamp `Session.mfaVerifiedAt` on a completed login.
  if (!sessionData.user.totpConfirmedAt) {
    const webauthnKeyCount = await prisma.webauthnMfaCredential.count({
      where: { userId: sessionData.user.id },
    });
    if (webauthnKeyCount === 0) {
      throw new StepUpRequiredError("auth.stepup.mfa_not_enrolled");
    }
  }

  // Read the freshness stamp off the live session row — `getSession`'s
  // projection intentionally omits it.
  const row = await prisma.session.findUnique({
    where: { id: sessionData.session.id },
    select: { mfaVerifiedAt: true },
  });
  const verifiedAt = row?.mfaVerifiedAt ?? null;
  if (!verifiedAt || verifiedAt.getTime() < Date.now() - maxAgeSeconds * 1000) {
    throw new StepUpRequiredError();
  }

  return { ...sessionData, mfaVerifiedAt: verifiedAt };
}

/**
 * v1.23 — conditional step-up for destructive account actions.
 *
 * Resolves the caller with the standard `requireAuth()` (cookie OR Bearer).
 * For an account WITHOUT a confirmed second factor the caller passes straight
 * through — a single-factor user is intentionally unaffected, so account
 * deletion / data reset keeps its existing typed-confirmation-only contract.
 * For an account WITH MFA active (`totpConfirmedAt` set) it additionally runs
 * `requireFreshMfa`, which is cookie-only by construction: an MFA-enrolled
 * account's Bearer transport carries no `mfaVerifiedAt` and therefore cannot
 * satisfy step-up, surfacing `StepUpRequiredError` (401,
 * `errorCode: "auth.stepup.required"`) so the UI launches a re-verification.
 *
 * Gating only the MFA-enrolled cohort keeps the boundary structural: a
 * hijacked live cookie session for an MFA user cannot nuke the record without
 * a fresh factor, while users who never opted into MFA are not forced through
 * a flow they have no way to complete.
 */
export async function requireFreshMfaIfEnrolled(
  maxAgeSeconds: number,
): Promise<AuthContext> {
  const auth = await requireAuth();
  // Either factor enrols the account: a confirmed TOTP secret OR a registered
  // WebAuthn security key. A webauthn-only user must clear step-up too, so the
  // destructive-action boundary tracks `requireFreshMfa`'s either-factor rule.
  let enrolled = Boolean(auth.user.totpConfirmedAt);
  if (!enrolled) {
    const webauthnKeyCount = await prisma.webauthnMfaCredential.count({
      where: { userId: auth.user.id },
    });
    enrolled = webauthnKeyCount > 0;
  }
  if (enrolled) {
    await requireFreshMfa(maxAgeSeconds);
  }
  return auth;
}

/**
 * Report unhandled errors to GlitchTip (fire-and-forget).
 * Uses dynamic import to avoid circular dependencies and startup cost.
 */
async function reportToGlitchtip(
  error: unknown,
  request: NextRequest,
  evt: WideEventBuilder,
): Promise<void> {
  const [{ getGlitchtipSettings }, { sendGlitchtipEvent }] = await Promise.all([
    import("@/lib/monitoring-settings"),
    import("@/lib/monitoring/glitchtip"),
  ]);

  const settings = await getGlitchtipSettings();
  if (!settings.glitchtipEnabled || !settings.glitchtipDsn) return;

  const err =
    error instanceof Error
      ? error
      : new Error(typeof error === "string" ? error : "Unknown error");

  // Skip expected errors from bot scanners (malformed JSON bodies)
  if (err instanceof SyntaxError) return;

  // Audit H-B7 / phase P2: strip the query string before forwarding to
  // GlitchTip. Withings legacy callbacks ship `?secret=…` (see C-3) and
  // OAuth callbacks ship `?code=…&state=…`; if any of those error we
  // don't want their secrets in someone's incident UI.
  const rawUrl = safeRequestProp(request, (r) => r.url, "");
  let scrubbedUrl = rawUrl;
  try {
    const u = new URL(rawUrl);
    u.search = "";
    scrubbedUrl = u.toString();
  } catch {
    // Invalid URL — fall through with the raw value (only happens in
    // degenerate test fixtures).
  }

  await sendGlitchtipEvent({
    dsn: settings.glitchtipDsn,
    input: {
      environment: settings.glitchtipEnvironment || "production",
      // Defence in depth: even though the WideEventBuilder already
      // redacts on `setError()`, the GlitchTip path imports `err`
      // directly. Apply the same redaction here so a Telegram bot
      // token or external Bearer cannot leak via the incident UI.
      message: redactSecrets(err.message),
      level: "error",
      type: err.name || "Error",
      stack: redactOptional(err.stack),
      // Query string is already stripped above, but path-segment secrets
      // (e.g. `/api/withings/webhook/<secret>`, `/api/whoop/webhook/<secret>`)
      // survive that strip. Run the same `redactSecrets` pass that guards the
      // message/stack so a `PATH_SECRET_PATHS`-registered secret cannot reach
      // the external incident UI.
      url: redactSecrets(scrubbedUrl),
      sourceTag: "healthlog-api-handler",
      requestId: evt.getRequestId(),
    },
  });
}
