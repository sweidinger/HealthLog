/**
 * Bounded body reader (M3) — reject oversized bodies WITHOUT buffering them.
 */
import { describe, it, expect } from "vitest";

import { readBodyCapped } from "../read-capped";

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
  });
}

const enc = (s: string) => new TextEncoder().encode(s);

describe("readBodyCapped", () => {
  it("returns the decoded text under the cap", async () => {
    const res = await readBodyCapped(
      { headers: new Headers(), body: streamOf([enc("hello "), enc("world")]) },
      1024,
    );
    expect(res).toEqual({ ok: true, text: "hello world" });
  });

  it("rejects up front on an oversized Content-Length without consuming the body", async () => {
    const body = streamOf([enc("x")]);
    let getReaderCalled = false;
    const original = body.getReader.bind(body);
    body.getReader = ((...args: unknown[]) => {
      getReaderCalled = true;
      // @ts-expect-error — passthrough spy
      return original(...args);
    }) as typeof body.getReader;
    const res = await readBodyCapped(
      { headers: new Headers({ "content-length": "999999" }), body },
      16,
    );
    expect(res).toEqual({ ok: false, reason: "too_large" });
    expect(getReaderCalled).toBe(false);
  });

  it("aborts mid-stream the moment the running total exceeds the cap", async () => {
    let chunksPulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        chunksPulled++;
        // 10 bytes per chunk; cap is 16, so the 2nd chunk overflows.
        c.enqueue(enc("0123456789"));
      },
    });
    const res = await readBodyCapped({ headers: new Headers(), body }, 16);
    expect(res).toEqual({ ok: false, reason: "too_large" });
    // It must stop pulling once it overflows, not drain the (infinite) stream.
    expect(chunksPulled).toBeLessThanOrEqual(2);
  });

  it("treats a null body as empty", async () => {
    const res = await readBodyCapped(
      { headers: new Headers(), body: null },
      16,
    );
    expect(res).toEqual({ ok: true, text: "" });
  });
});
