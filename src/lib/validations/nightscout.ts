import { z } from "zod/v4";

/**
 * Per-user Nightscout connection input (v1.17.0). The self-hoster points
 * HealthLog at their own Nightscout instance (Railway / Heroku / Fly / a LAN
 * box) and pastes the instance's API token. Both fields are stored encrypted
 * on `User` (`nightscoutUrlEncrypted` / `nightscoutTokenEncrypted`); the
 * private-host opt-in maps to `nightscoutAllowPrivateHost`.
 *
 * The URL is validated to be a parseable http(s) origin at input time. The
 * SSRF floor (public-host requirement, unless `allowPrivateHost` is set) is
 * enforced at fetch time by the client through `safeFetch` — input-shape
 * validation here only rejects garbage early so the connect route can return
 * a clear 422 instead of letting a malformed string reach the egress layer.
 */
export const nightscoutConnectSchema = z.object({
  // Trimmed: a trailing space / newline from a copy button reaches the
  // instance verbatim and produces an opaque DNS failure.
  url: z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .refine((value) => {
      try {
        const u = new URL(value);
        return u.protocol === "http:" || u.protocol === "https:";
      } catch {
        return false;
      }
    }, "Must be a valid http(s) URL"),
  // Nightscout API tokens are opaque strings (a role-scoped access token or
  // the raw `API_SECRET`). Optional: a fully public instance with
  // `AUTH_DEFAULT_ROLES=readable` serves SGV entries without a token.
  token: z.string().trim().max(512).optional().default(""),
  // The explicit self-hoster opt-in to allow a private / LAN Nightscout host
  // past the public-host SSRF floor. Defaults false (public instances).
  allowPrivateHost: z.boolean().optional().default(false),
});

export type NightscoutConnectInput = z.infer<typeof nightscoutConnectSchema>;
