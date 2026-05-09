import { describe, expect, it } from "vitest";
import { redactSecrets, redactOptional } from "../redact";

describe("redactSecrets", () => {
  it("redacts Bearer tokens", () => {
    expect(redactSecrets("Authorization: Bearer hlk_abc123def456")).toBe(
      "Authorization: Bearer [REDACTED]",
    );
    expect(redactSecrets("auth=Bearer  whitespace_token")).toBe(
      "auth=Bearer [REDACTED]",
    );
  });

  it("redacts Telegram bot tokens in path-style URLs", () => {
    expect(
      redactSecrets(
        "fetch failed: https://api.telegram.org/bot1234567890:AAEhBP-w-secret/sendMessage",
      ),
    ).toBe("fetch failed: https://api.telegram.org/bot[REDACTED]/sendMessage");
  });

  it("redacts query-string secrets", () => {
    expect(redactSecrets("Withings webhook ?secret=abc123 failed")).toBe(
      "Withings webhook ?secret=[REDACTED] failed",
    );
    expect(redactSecrets("OAuth ?code=xyz&state=abc")).toBe(
      "OAuth ?code=[REDACTED]&state=abc",
    );
    expect(redactSecrets("api?api_key=secret")).toBe("api?api_key=[REDACTED]");
  });

  it("redacts OpenAI and Anthropic API keys", () => {
    expect(redactSecrets("error: invalid key sk-1234567890abcdefABCDEF")).toBe(
      "error: invalid key [REDACTED]",
    );
    expect(
      redactSecrets("Authorization: Bearer sk-ant-api03-xyzABC_42-token"),
    ).toBe("Authorization: Bearer [REDACTED]");
    // Standalone Anthropic key (no Bearer prefix) — make sure the sk-ant-
    // path matches independently of the Bearer rule.
    expect(redactSecrets("body={apiKey: sk-ant-abcDEF123_-}")).toBe(
      "body={apiKey: [REDACTED]}",
    );
  });

  it("leaves non-secret-shaped strings alone", () => {
    expect(redactSecrets("HTTP 503 from upstream")).toBe(
      "HTTP 503 from upstream",
    );
    expect(redactSecrets("user-7 measurement saved")).toBe(
      "user-7 measurement saved",
    );
  });

  // v1.4.6 P11 hardening: the original `/sk-(?:ant-)?[A-Za-z0-9_-]+/`
  // regex over-matched any word ending in `sk-…`, redacting common
  // English compounds in error messages and PR descriptions. v1.5
  // tightens the regex to require a non-alphanumeric prefix so the
  // `sk-` token must actually start a secret.
  it("does NOT redact common English compounds containing 'sk-'", () => {
    expect(redactSecrets("task-force ABC")).toBe("task-force ABC");
    expect(redactSecrets("risk-management note")).toBe("risk-management note");
    expect(redactSecrets("disk-io 1234")).toBe("disk-io 1234");
    // Mid-word matches must also be ignored (the `sk-` is preceded by a
    // letter / digit, so it's part of an identifier, not a secret).
    expect(redactSecrets("workflow:risk-management")).toBe(
      "workflow:risk-management",
    );
    expect(redactSecrets("e2e_disk-io_check")).toBe("e2e_disk-io_check");
  });

  it("still redacts genuine sk- and sk-ant- API keys", () => {
    // Start of string.
    expect(redactSecrets("sk-1234567890abcdef")).toBe("[REDACTED]");
    expect(redactSecrets("sk-ant-1234567890abcdef")).toBe("[REDACTED]");
    // Preceded by whitespace, equals, brace, comma, etc. — the
    // non-alphanumeric-prefix requirement.
    expect(redactSecrets("apiKey=sk-1234567890abcdef end")).toBe(
      "apiKey=[REDACTED] end",
    );
    expect(redactSecrets("OPENAI_API_KEY=sk-prod-abcDEF123456789012")).toBe(
      "OPENAI_API_KEY=[REDACTED]",
    );
    // Trailing context preserved, leading separator preserved.
    expect(redactSecrets(",sk-1234567890abcdef,")).toBe(",[REDACTED],");
  });

  it("redacts standalone HealthLog native API tokens (hlk_ / hlr_)", () => {
    // Start of string.
    expect(
      redactSecrets("hlk_abc123def4567890abcdef1234567890ABCDEF1234567890abcd"),
    ).toBe("[REDACTED]");
    expect(
      redactSecrets("hlr_abc123def4567890abcdef1234567890ABCDEF1234567890abcd"),
    ).toBe("[REDACTED]");
    // Preceded by separator, leading separator preserved.
    expect(
      redactSecrets(
        "refresh: hlr_abc123def4567890abcdef1234567890ABCDEF1234567890abcd end",
      ),
    ).toBe("refresh: [REDACTED] end");
    expect(
      redactSecrets('{"token": "hlk_0123456789abcdef0123456789abcdef0123"}'),
    ).toBe('{"token": "[REDACTED]"}');
  });

  it("does NOT redact non-token strings starting with `hl`", () => {
    expect(redactSecrets("html_render finished")).toBe("html_render finished");
    expect(redactSecrets("healthcheck ok")).toBe("healthcheck ok");
    // Too-short trailing hex — keep as-is.
    expect(redactSecrets("hlk_short")).toBe("hlk_short");
  });

  it("handles multiple secrets in one string", () => {
    // Bearer matches `\S+` so it greedily consumes `hlk_x;` — that's
    // safe (over-redaction is fine when the alternative is leaking).
    expect(redactSecrets("Bearer hlk_x bot999:tok ?code=abc123")).toBe(
      "Bearer [REDACTED] bot[REDACTED] ?code=[REDACTED]",
    );
  });
});

describe("redactOptional", () => {
  it("returns undefined for undefined input", () => {
    expect(redactOptional(undefined)).toBeUndefined();
  });

  it("redacts when present", () => {
    expect(redactOptional("Bearer x")).toBe("Bearer [REDACTED]");
  });
});
