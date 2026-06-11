/**
 * Typed client-side fetch wrapper for same-origin `/api/...` routes.
 *
 * Every API route responds with the `{ data, error, meta? }` envelope
 * (see `src/lib/api-response.ts`). Before this wrapper, ~250 client call
 * sites hand-rolled the same four lines — `fetch`, `.ok` check, `await
 * res.json()`, `.data` unwrap — with subtly divergent error handling.
 * This module is the one client-side entry point; the ESLint rule
 * `healthlog/api-fetch-required` flags raw `fetch("/api/…")` calls in
 * `src/components/` + `src/app/` at authoring time.
 *
 * Contract:
 *   - `apiFetch<T>(path, init?)` resolves with the unwrapped `data`
 *     payload (typed via the generic) on a 2xx response. A 204 / empty
 *     body resolves with `undefined`.
 *   - On a non-OK response it throws `ApiError` — `message` extracted
 *     through `readError` (server envelope `error` string, falling back
 *     to `Request failed (<status>)`), `status` carrying the HTTP code,
 *     `meta` carrying the error envelope's `meta` object when present
 *     (e.g. `meta.errorCode`).
 *   - Network failures reject with the native `TypeError` from `fetch`,
 *     exactly as before — only HTTP-level failures become `ApiError`.
 *   - 401 / 403 / 429 are NOT special-cased: the wrapper throws the same
 *     `ApiError` and performs no redirect, no token refresh, no retry,
 *     no toast. Session expiry handling stays where it always was (the
 *     server redirects document navigations via `src/proxy.ts`; data
 *     calls surface the error to the caller's existing handler). 429
 *     callers can branch on `err.status === 429` for cooldown UX.
 *   - No toast / no global side effect ever originates here. Surfacing
 *     errors stays the call site's responsibility.
 *
 * Verb helpers `apiGet` / `apiPost` / `apiPut` / `apiPatch` /
 * `apiDelete` JSON-encode an optional body and set `Content-Type:
 * application/json` when a body is present. `init` passes through to
 * `fetch` (e.g. `signal`, `cache`, extra `headers`).
 *
 * Escape hatches (both still satisfy the ESLint rule):
 *   - `apiFetchEnvelope<T, M>` resolves with `{ data, meta }` for the
 *     few callers that read success-side `meta` (pagination totals).
 *   - `apiFetchRaw` is a plain same-origin `fetch` passthrough for call
 *     sites that need the `Response` itself — blob downloads, SSE
 *     streams, manual status branching. No `.ok` check, no unwrap.
 */

import { readError } from "./read-error";

/** HTTP-level failure from an `/api/...` route — non-OK status. */
export class ApiError extends Error {
  /** HTTP status code of the failed response. */
  readonly status: number;
  /** `meta` object of the error envelope, when the body carried one. */
  readonly meta: Record<string, unknown> | undefined;

  constructor(
    message: string,
    status: number,
    meta?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.meta = meta;
  }
}

interface Envelope<T, M = Record<string, unknown>> {
  data: T;
  error: string | null;
  meta?: M;
}

async function throwApiError(res: Response): Promise<never> {
  let meta: Record<string, unknown> | undefined;
  try {
    const json = (await res.clone().json()) as { meta?: unknown };
    if (json && typeof json.meta === "object" && json.meta !== null) {
      meta = json.meta as Record<string, unknown>;
    }
  } catch {
    /* non-JSON body — readError supplies the fallback message */
  }
  throw new ApiError(await readError(res), res.status, meta);
}

async function parseEnvelope<T, M>(
  res: Response,
): Promise<Envelope<T, M> | undefined> {
  if (res.status === 204) return undefined;
  const text = await res.text();
  if (text.length === 0) return undefined;
  return JSON.parse(text) as Envelope<T, M>;
}

/**
 * Same-origin API fetch — resolves with the unwrapped `data` payload,
 * throws {@link ApiError} on a non-OK response.
 */
export async function apiFetch<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) await throwApiError(res);
  const envelope = await parseEnvelope<T, unknown>(res);
  return (envelope === undefined ? undefined : envelope.data) as T;
}

/**
 * Like {@link apiFetch} but resolves with `{ data, meta }` for callers
 * that read success-side `meta` (e.g. pagination totals).
 */
export async function apiFetchEnvelope<
  T = unknown,
  M = Record<string, unknown>,
>(path: string, init?: RequestInit): Promise<{ data: T; meta: M | undefined }> {
  const res = await fetch(path, init);
  if (!res.ok) await throwApiError(res);
  const envelope = await parseEnvelope<T, M>(res);
  return {
    data: (envelope === undefined ? undefined : envelope.data) as T,
    meta: envelope?.meta,
  };
}

/**
 * Plain same-origin `fetch` passthrough for call sites that need the raw
 * `Response` — blob downloads, SSE streams, manual status branching.
 * Performs no `.ok` check and no envelope unwrap.
 */
export function apiFetchRaw(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(path, init);
}

function withJsonBody(
  method: string,
  body: unknown,
  init?: RequestInit,
): RequestInit {
  const merged: RequestInit = { ...init, method };
  if (body !== undefined) {
    // `HeadersInit` is a union — a plain object spreads fine, but a
    // `Headers` instance (or entries array) has no enumerable own
    // properties, so `{ ...init.headers }` silently dropped every
    // caller header. `new Headers(...)` normalises all three shapes.
    const headers = new Headers(init?.headers);
    if (!headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    merged.headers = headers;
    merged.body = JSON.stringify(body);
  }
  return merged;
}

/** GET — resolves with the unwrapped `data` payload. */
export function apiGet<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  return apiFetch<T>(path, { ...init, method: "GET" });
}

/** POST with optional JSON body — resolves with the unwrapped `data`. */
export function apiPost<T = unknown>(
  path: string,
  body?: unknown,
  init?: RequestInit,
): Promise<T> {
  return apiFetch<T>(path, withJsonBody("POST", body, init));
}

/** PUT with optional JSON body — resolves with the unwrapped `data`. */
export function apiPut<T = unknown>(
  path: string,
  body?: unknown,
  init?: RequestInit,
): Promise<T> {
  return apiFetch<T>(path, withJsonBody("PUT", body, init));
}

/** PATCH with optional JSON body — resolves with the unwrapped `data`. */
export function apiPatch<T = unknown>(
  path: string,
  body?: unknown,
  init?: RequestInit,
): Promise<T> {
  return apiFetch<T>(path, withJsonBody("PATCH", body, init));
}

/** DELETE with optional JSON body — resolves with the unwrapped `data`. */
export function apiDelete<T = unknown>(
  path: string,
  body?: unknown,
  init?: RequestInit,
): Promise<T> {
  return apiFetch<T>(path, withJsonBody("DELETE", body, init));
}
