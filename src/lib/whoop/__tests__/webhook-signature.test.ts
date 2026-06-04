import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyWhoopSignature } from "../webhook-handler";

const SECRET = "test-whoop-webhook-secret";

function sign(rawBody: string, timestamp: string, secret = SECRET): string {
  return createHmac("sha256", secret)
    .update(timestamp + rawBody, "utf8")
    .digest("base64");
}

describe("verifyWhoopSignature", () => {
  const now = 1_700_000_000_000;
  const rawBody = JSON.stringify({
    user_id: 42,
    id: "abc",
    type: "recovery.updated",
  });

  it("accepts a valid signature over `timestamp + rawBody`", () => {
    const timestamp = String(now);
    expect(
      verifyWhoopSignature({
        rawBody,
        signature: sign(rawBody, timestamp),
        timestamp,
        secret: SECRET,
        now,
      }),
    ).toBe(true);
  });

  it("rejects a forged signature", () => {
    const timestamp = String(now);
    expect(
      verifyWhoopSignature({
        rawBody,
        signature: sign(rawBody, timestamp, "wrong-secret"),
        timestamp,
        secret: SECRET,
        now,
      }),
    ).toBe(false);
  });

  it("rejects a body that doesn't match the signed bytes", () => {
    const timestamp = String(now);
    const sig = sign(rawBody, timestamp);
    expect(
      verifyWhoopSignature({
        rawBody: rawBody + " tampered",
        signature: sig,
        timestamp,
        secret: SECRET,
        now,
      }),
    ).toBe(false);
  });

  it("rejects a stale timestamp (> 5 min skew)", () => {
    const timestamp = String(now - 6 * 60 * 1000);
    expect(
      verifyWhoopSignature({
        rawBody,
        signature: sign(rawBody, timestamp),
        timestamp,
        secret: SECRET,
        now,
      }),
    ).toBe(false);
  });

  it("rejects a missing signature or timestamp", () => {
    const timestamp = String(now);
    expect(
      verifyWhoopSignature({
        rawBody,
        signature: null,
        timestamp,
        secret: SECRET,
        now,
      }),
    ).toBe(false);
    expect(
      verifyWhoopSignature({
        rawBody,
        signature: sign(rawBody, timestamp),
        timestamp: null,
        secret: SECRET,
        now,
      }),
    ).toBe(false);
  });

  it("rejects a non-numeric timestamp", () => {
    expect(
      verifyWhoopSignature({
        rawBody,
        signature: sign(rawBody, "not-a-number"),
        timestamp: "not-a-number",
        secret: SECRET,
        now,
      }),
    ).toBe(false);
  });
});
