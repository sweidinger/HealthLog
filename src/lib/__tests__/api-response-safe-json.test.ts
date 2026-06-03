import { describe, it, expect } from "vitest";

import { safeJson } from "../api-response";

// `safeJson`'s opt-in `maxBytes` cap is the DoS ceiling the batch /
// export ingest routes lean on. The check runs against the raw text
// before `JSON.parse`, so an over-limit body never lands in heap and
// the caller gets a clean 413 envelope.

function jsonRequest(body: string): Request {
  return new Request("https://example.test/api/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

describe("safeJson maxBytes", () => {
  it("parses a body at or under the cap", async () => {
    const payload = JSON.stringify({ entries: [1, 2, 3] });
    const result = await safeJson(jsonRequest(payload), {
      maxBytes: 1024,
    });
    expect(result.error).toBeUndefined();
    expect(result.data).toEqual({ entries: [1, 2, 3] });
  });

  it("rejects an over-limit body with a 413 envelope", async () => {
    const payload = JSON.stringify({ blob: "x".repeat(2048) });
    const result = await safeJson(jsonRequest(payload), {
      maxBytes: 1024,
    });
    expect(result.data).toBeUndefined();
    expect(result.error).toBeDefined();
    expect(result.error!.status).toBe(413);

    const body = (await result.error!.json()) as {
      data: null;
      error: string;
    };
    expect(body.data).toBeNull();
    expect(body.error).toContain("1024");
  });

  it("returns 400 on invalid JSON within the cap", async () => {
    const result = await safeJson(jsonRequest("{not json"), {
      maxBytes: 1024,
    });
    expect(result.data).toBeUndefined();
    expect(result.error!.status).toBe(400);
  });

  it("still rejects a non-JSON content-type before measuring bytes", async () => {
    const request = new Request("https://example.test/api/x", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "x".repeat(4096),
    });
    const result = await safeJson(request, { maxBytes: 1024 });
    expect(result.error!.status).toBe(415);
  });

  it("parses unbounded when maxBytes is omitted", async () => {
    const payload = JSON.stringify({ ok: true });
    const result = await safeJson(jsonRequest(payload));
    expect(result.error).toBeUndefined();
    expect(result.data).toEqual({ ok: true });
  });
});
