/**
 * Request schema for the first-party web-handoff token exchange
 * (`POST /api/auth/native/token`, iOS #65). Single-sourced here so the runtime
 * `safeParse` and the OpenAPI registry (`src/lib/openapi/routes/auth.ts`)
 * describe the identical wire contract. Same shape as the OIDC native exchange
 * — the code prefix and PKCE verifier grammar are shared across both flows.
 */
import { z } from "zod/v4";

/**
 * `{ code, codeVerifier }`.
 *
 * - `code` is the opaque handoff code from the
 *   `healthlog://login-callback?code=` redirect: the `hlh_` prefix + the 43-char
 *   base64url body of a 256-bit CSPRNG value. Pinned exactly so only well-formed
 *   codes reach the hash lookup.
 * - `codeVerifier` is the app's PKCE verifier (RFC 7636 §4.1 — 43–128 chars of
 *   the unreserved set); the server checks `S256(codeVerifier)` against the
 *   challenge bound at mint (constant-time) before consuming the code.
 */
export const nativeHandoffTokenSchema = z
  .object({
    code: z
      .string()
      .regex(/^hlh_[A-Za-z0-9_-]{43}$/, "Malformed handoff code.")
      .describe(
        "One-time handoff code from the healthlog://login-callback?code= redirect.",
      ),
    codeVerifier: z
      .string()
      .regex(
        /^[A-Za-z0-9\-._~]{43,128}$/,
        "The PKCE code_verifier must be 43–128 chars of the RFC 7636 unreserved set.",
      )
      .describe("The app's PKCE code_verifier (RFC 7636)."),
  })
  .meta({
    id: "NativeHandoffTokenRequest",
    description:
      "Exchange a one-time web-handoff code (+ its PKCE verifier) for the standard native token bundle.",
  });

export type NativeHandoffTokenRequest = z.infer<
  typeof nativeHandoffTokenSchema
>;
