import { describe, it, expect } from "vitest";
import {
  redactSensitiveFields,
  redactForExcerpt,
  SENSITIVE_KEY_PATTERNS,
} from "../redact-payload";
import { buildPayloadDiagnostic } from "@/lib/api-response";

// v1.4.49 — pinned redactor for the wide-event `received_shape_excerpt`
// surface introduced in v1.4.48 H-iOS-1 / H-iOS-2. The helper must
// strip values for any key matching the SENSITIVE_KEY_PATTERNS denylist
// before the caller's `JSON.stringify` lands in the meta excerpt.

describe("redactSensitiveFields", () => {
  it("passes a body with no sensitive keys through unchanged", () => {
    const body = {
      version: 1,
      widgets: [{ id: "weight", visible: true, order: 0 }],
      comparisonBaseline: "lastMonth",
    };
    const result = redactSensitiveFields(body);
    expect(result).toEqual(body);
    // Returns a clone, not the original reference.
    expect(result).not.toBe(body);
  });

  it("redacts a top-level `password` key", () => {
    const body = { username: "alice", password: "hunter2" };
    expect(redactSensitiveFields(body)).toEqual({
      username: "alice",
      password: "[redacted]",
    });
  });

  it("redacts `Authorization` regardless of case (Bearer prefix preserved as redacted)", () => {
    const body = { Authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.xxx" };
    expect(redactSensitiveFields(body)).toEqual({
      Authorization: "[redacted]",
    });
  });

  it("redacts a nested object's sensitive fields recursively", () => {
    const body = {
      kind: "device.register",
      payload: {
        deviceId: "abc-123",
        apnsToken: "ff".repeat(32),
        meta: { secret: "shh", model: "iPhone15" },
      },
    };
    expect(redactSensitiveFields(body)).toEqual({
      kind: "device.register",
      payload: {
        deviceId: "abc-123",
        apnsToken: "[redacted]",
        meta: { secret: "[redacted]", model: "iPhone15" },
      },
    });
  });

  it("redacts inside array members", () => {
    const body = {
      entries: [
        { id: "1", apiKey: "sk_live_xxx" },
        { id: "2", token: "bearer-xyz" },
        { id: "3", note: "free text" },
      ],
    };
    expect(redactSensitiveFields(body)).toEqual({
      entries: [
        { id: "1", apiKey: "[redacted]" },
        { id: "2", token: "[redacted]" },
        { id: "3", note: "free text" },
      ],
    });
  });

  it("matches the token denylist patterns case-insensitively (apnsToken, bearerToken, csrf_state)", () => {
    const body = {
      apnsToken: "ff".repeat(32),
      bearerToken: "abc",
      csrf_state: "xyz",
      csrfState: "xyz2",
      api_key: "sk_xxx",
      Nonce: "01234",
      randomField: "kept",
    };
    expect(redactSensitiveFields(body)).toEqual({
      apnsToken: "[redacted]",
      bearerToken: "[redacted]",
      csrf_state: "[redacted]",
      csrfState: "[redacted]",
      api_key: "[redacted]",
      Nonce: "[redacted]",
      randomField: "kept",
    });
  });

  it("passes scalars + null + undefined through unchanged", () => {
    expect(redactSensitiveFields(null)).toBeNull();
    expect(redactSensitiveFields(undefined)).toBeUndefined();
    expect(redactSensitiveFields("string")).toBe("string");
    expect(redactSensitiveFields(42)).toBe(42);
    expect(redactSensitiveFields(true)).toBe(true);
  });

  it("does not recurse into non-plain objects (Date stays intact)", () => {
    const date = new Date("2026-05-22T10:00:00Z");
    const body = { measuredAt: date, password: "x" };
    const result = redactSensitiveFields(body) as Record<string, unknown>;
    expect(result.measuredAt).toBe(date);
    expect(result.password).toBe("[redacted]");
  });

  it("exposes the SENSITIVE_KEY_PATTERNS denylist as a readonly tuple", () => {
    // Pin the public surface so a future commit can't silently drop
    // one of the documented patterns.
    const required = [
      "password",
      "passphrase",
      "token",
      "secret",
      "apikey",
      "authorization",
      "csrfstate",
      "nonce",
      "otp",
      "recoveryCode",
      "glitchtipDsn",
    ];
    for (const key of required) {
      const matched = SENSITIVE_KEY_PATTERNS.some((re) => re.test(key));
      expect(matched, `pattern set should match ${key}`).toBe(true);
    }
  });

  it("redacts the credential-adjacent additions (passphrase / otp / recovery / dsn)", () => {
    const body = {
      backupPassphrase: "correct horse battery staple",
      emailOtp: "123456",
      recoveryCode: "abcd-efgh-ijkl",
      glitchtipDsn: "https://abc@glitchtip.example/1",
      benignField: "kept",
    };
    expect(redactSensitiveFields(body)).toEqual({
      backupPassphrase: "[redacted]",
      emailOtp: "[redacted]",
      recoveryCode: "[redacted]",
      glitchtipDsn: "[redacted]",
      benignField: "kept",
    });
  });

  it("redacts the health-insurance identity additions (insuranceNumber / kvnr / insurerName)", () => {
    const body = {
      insuranceNumber: "A123456780",
      kvnr: "A123456780",
      insurerName: "Example Krankenkasse",
      benignField: "kept",
    };
    expect(redactSensitiveFields(body)).toEqual({
      insuranceNumber: "[redacted]",
      kvnr: "[redacted]",
      insurerName: "[redacted]",
      benignField: "kept",
    });
  });

  it("redacts the webhook shared secret (headerValue) and the Live Activity token", () => {
    const body = {
      headerValue: "super-secret-webhook-key",
      liveActivityPushToken: "abc123",
      webhookUrl: "https://example.com/hook",
    };
    expect(redactSensitiveFields(body)).toEqual({
      headerValue: "[redacted]",
      // Covered by the existing /token/i pattern.
      liveActivityPushToken: "[redacted]",
      webhookUrl: "https://example.com/hook",
    });
  });
});

describe("redactForExcerpt (v1.25 — note/notes excerpt-only redaction)", () => {
  it("redacts a free-text `notes` value the generic denylist deliberately keeps", () => {
    const body = {
      entry: "NAUSEA",
      severity: 3,
      notes: "felt dizzy after the 7.5 mg step-up — Nürnberg",
    };
    // The generic denylist leaves note/notes verbatim (too generic to add).
    expect(redactSensitiveFields(body)).toEqual(body);
    // The excerpt path redacts the value so it cannot reach a wide event.
    expect(redactForExcerpt(body)).toEqual({
      entry: "NAUSEA",
      severity: 3,
      notes: "[redacted]",
    });
  });

  it("redacts a singular `note` key and recurses into nested objects + arrays", () => {
    const body = {
      doseChange: { doseValue: 7.5, note: "titration note" },
      logs: [
        { id: "1", note: "a" },
        { id: "2", note: "b" },
      ],
    };
    expect(redactForExcerpt(body)).toEqual({
      doseChange: { doseValue: 7.5, note: "[redacted]" },
      logs: [
        { id: "1", note: "[redacted]" },
        { id: "2", note: "[redacted]" },
      ],
    });
  });

  it("does not over-redact note-adjacent keys (noteId / footnotes stay)", () => {
    const body = { noteId: "abc", footnotes: "kept", noteCount: 3 };
    expect(redactForExcerpt(body)).toEqual(body);
  });

  it("still redacts the global sensitive keys on the excerpt path", () => {
    const body = { note: "secret", token: "abc", keep: 1 };
    expect(redactForExcerpt(body)).toEqual({
      note: "[redacted]",
      token: "[redacted]",
      keep: 1,
    });
  });

  it("keeps a free-text note value out of the wide-event excerpt end to end", () => {
    const body = { notes: "a very private free-text health note value" };
    const diag = buildPayloadDiagnostic(redactForExcerpt(body));
    expect(diag.received_shape_excerpt).not.toContain("private free-text");
    expect(diag.received_shape_excerpt).toContain("[redacted]");
  });
});
