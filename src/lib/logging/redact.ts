/**
 * Redact secrets from strings before they leave the process boundary
 * (Loki, Glitchtip, console). Applied in `WideEventBuilder.setError()`
 * and `reportToGlitchtip()` so every error reaching observability is
 * scrubbed once, centrally.
 *
 * Patterns:
 *   - `Bearer <token>` — generic API tokens incl. our `hlk_` /
 *     `hlr_` formats and external OAuth bearers (Withings, AI providers).
 *   - `bot<digits>:<token>` — Telegram bot URLs embed the token in the
 *     path: `https://api.telegram.org/bot1234567:ABC-…/sendMessage`.
 *     If `fetch()` rejects with a `cause` that surfaces the URL (some
 *     Node runtimes), the token would land in error reports.
 *   - `?secret=…` and `?code=…` — query-string leaks for legacy
 *     Withings webhooks and OAuth callbacks (already scrubbed at the
 *     URL level in `reportToGlitchtip`, but error.message can carry
 *     the URL too).
 *   - `sk-…` and `sk-ant-…` — OpenAI / Anthropic API keys. We never
 *     log them on purpose, but a misconfigured client error or a
 *     dump of the request body could carry one. Scrub before egress.
 *
 * The substitution is intentionally generic ([REDACTED]) — we don't
 * want partial revelation of token entropy.
 */
export function redactSecrets(input: string): string {
  return (
    input
      .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
      .replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot[REDACTED]")
      // `sk-` is a common English-prefix substring (task-force, risk-
      // management, disk-io). Without a word-boundary, the original
      // `/sk-(?:ant-)?[A-Za-z0-9_-]+/g` over-matched and made server logs
      // unreadable. Require the `sk-` token to be at the start of the
      // string OR preceded by a non-alphanumeric character (whitespace,
      // `=`, `{`, `,`, `:`, etc.). The minimum length-8 tail keeps a
      // tiny safety margin against `sk-1`-style false-positives in code
      // identifiers. Capture group 1 = the leading separator (preserved).
      .replace(/(^|[^A-Za-z0-9])sk-(?:ant-)?[A-Za-z0-9_-]{8,}/g, "$1[REDACTED]")
      .replace(
        /([?&])(secret|code|token|api[_-]?key)=[^&\s]+/gi,
        "$1$2=[REDACTED]",
      )
  );
}

/** Apply `redactSecrets` to a possibly-undefined string. */
export function redactOptional(s: string | undefined): string | undefined {
  return s === undefined ? undefined : redactSecrets(s);
}
