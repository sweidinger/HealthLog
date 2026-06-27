import { describe, it, expect } from "vitest";

import { encodeOffsetCursor, decodeOffsetCursor } from "../pagination";

describe("opaque cursor pagination", () => {
  it("round-trips an offset through encode → decode", () => {
    for (const offset of [0, 1, 8, 50, 200, 9999]) {
      expect(decodeOffsetCursor(encodeOffsetCursor(offset))).toBe(offset);
    }
  });

  it("encodes deterministically (stable token for the same offset)", () => {
    expect(encodeOffsetCursor(8)).toBe(encodeOffsetCursor(8));
  });

  it("emits an opaque token, not the raw number", () => {
    const cursor = encodeOffsetCursor(8);
    expect(cursor).not.toBe("8");
    expect(cursor).not.toContain("8");
  });

  it("degrades a missing / malformed / foreign cursor to the first page", () => {
    expect(decodeOffsetCursor(undefined)).toBe(0);
    expect(decodeOffsetCursor("")).toBe(0);
    expect(decodeOffsetCursor("not-base64!@#")).toBe(0);
    expect(
      decodeOffsetCursor(Buffer.from("[1,2,3]").toString("base64url")),
    ).toBe(0);
    expect(decodeOffsetCursor(42 as unknown)).toBe(0);
  });

  it("clamps a negative or non-finite offset to zero", () => {
    expect(encodeOffsetCursor(-5)).toBe(encodeOffsetCursor(0));
    expect(encodeOffsetCursor(Number.NaN)).toBe(encodeOffsetCursor(0));
  });
});
