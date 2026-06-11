/**
 * Unit tests for the typed client-side API fetch wrapper.
 *
 * The wrapper owns the `.ok` check, the `{ data, error, meta? }`
 * envelope unwrap, and the `ApiError` shape (message via `readError`,
 * `status`, error-side `meta`). These tests pin that contract against a
 * mocked global `fetch`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  apiDelete,
  apiFetch,
  apiFetchEnvelope,
  apiFetchRaw,
  apiGet,
  apiPatch,
  apiPost,
  apiPut,
} from "../api-fetch";

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe("apiFetch", () => {
  it("unwraps the data payload from the envelope", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: { id: "m1" }, error: null }),
    );

    const data = await apiFetch<{ id: string }>("/api/measurements/m1");

    expect(data).toEqual({ id: "m1" });
    expect(fetchMock).toHaveBeenCalledWith("/api/measurements/m1", undefined);
  });

  it("passes init through to fetch (signal, cache, headers)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: null, error: null }));
    const controller = new AbortController();

    await apiFetch("/api/version", {
      cache: "no-store",
      signal: controller.signal,
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/version", {
      cache: "no-store",
      signal: controller.signal,
    });
  });

  it("resolves undefined for a 204 response", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(apiFetch("/api/foo")).resolves.toBeUndefined();
  });

  it("resolves undefined for an empty 200 body", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }));

    await expect(apiFetch("/api/foo")).resolves.toBeUndefined();
  });

  it("throws ApiError with the envelope error message and status", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: null, error: "Not found" }, 404),
    );

    const err = await apiFetch("/api/foo").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe("Not found");
    expect((err as ApiError).status).toBe(404);
    expect((err as ApiError).meta).toBeUndefined();
  });

  it("carries the error envelope meta (e.g. errorCode)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { data: null, error: "Boom", meta: { errorCode: "rate_limited" } },
        429,
      ),
    );

    const err = await apiFetch("/api/foo").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(429);
    expect((err as ApiError).meta).toEqual({ errorCode: "rate_limited" });
  });

  it("falls back to a stable message for a non-JSON error body", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("<html>upstream</html>", { status: 502 }),
    );

    const err = await apiFetch("/api/foo").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe("Request failed (502)");
    expect((err as ApiError).status).toBe(502);
  });

  it("does not special-case 401/403 — same ApiError, no side effect", async () => {
    for (const status of [401, 403]) {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ data: null, error: "Unauthorized" }, status),
      );
      const err = await apiFetch("/api/foo").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(status);
    }
  });

  it("lets network failures reject with the native error", async () => {
    const netErr = new TypeError("fetch failed");
    fetchMock.mockRejectedValueOnce(netErr);

    await expect(apiFetch("/api/foo")).rejects.toBe(netErr);
  });
});

describe("apiFetchEnvelope", () => {
  it("returns data and meta", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: [1, 2], error: null, meta: { total: 7 } }),
    );

    const { data, meta } = await apiFetchEnvelope<number[], { total: number }>(
      "/api/items",
    );

    expect(data).toEqual([1, 2]);
    expect(meta).toEqual({ total: 7 });
  });

  it("throws ApiError on non-OK like apiFetch", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: null, error: "Nope" }, 422),
    );

    await expect(apiFetchEnvelope("/api/items")).rejects.toMatchObject({
      name: "ApiError",
      message: "Nope",
      status: 422,
    });
  });
});

describe("apiFetchRaw", () => {
  it("returns the raw Response without ok-check or unwrap", async () => {
    const res = new Response("plain", { status: 500 });
    fetchMock.mockResolvedValueOnce(res);

    await expect(apiFetchRaw("/api/foo")).resolves.toBe(res);
  });
});

describe("verb helpers", () => {
  it("apiGet sets the method", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: 1, error: null }));

    await apiGet("/api/foo");

    expect(fetchMock).toHaveBeenCalledWith("/api/foo", { method: "GET" });
  });

  it.each([
    ["apiPost", apiPost, "POST"],
    ["apiPut", apiPut, "PUT"],
    ["apiPatch", apiPatch, "PATCH"],
    ["apiDelete", apiDelete, "DELETE"],
  ] as const)("%s JSON-encodes the body", async (_name, helper, method) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: null, error: null }));

    await helper("/api/foo", { a: 1 });

    expect(fetchMock).toHaveBeenCalledWith("/api/foo", {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ a: 1 }),
    });
  });

  it("omits body and Content-Type when no body is given", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: null, error: null }));

    await apiPost("/api/foo");

    expect(fetchMock).toHaveBeenCalledWith("/api/foo", { method: "POST" });
  });

  it("merges caller headers with the JSON Content-Type", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: null, error: null }));

    await apiPost("/api/foo", { a: 1 }, { headers: { "X-Req": "1" } });

    expect(fetchMock).toHaveBeenCalledWith("/api/foo", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Req": "1" },
      body: JSON.stringify({ a: 1 }),
    });
  });
});
