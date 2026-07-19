/**
 * Request schemas for the step-up elevation surface. Single-sourced here so the
 * runtime `safeParse` and the OpenAPI registry describe the identical wire
 * contract.
 */
import { z } from "zod/v4";
import { webauthnCredentialSchema } from "@/lib/validations/mfa";

/**
 * Re-prove a factor to mint an elevation.
 *
 * Two accepted proofs, discriminated on `method`:
 *   - `password` — the account password. Unavailable on an account that signed
 *     in through OIDC SSO and never set one; such an account uses the passkey
 *     arm, or manages its second factor on the web.
 *   - `passkey` — an assertion against a primary passkey the device already
 *     holds, begun at `/api/auth/step-up/options`.
 *
 * The password is length-bounded so a body cap is not the only thing standing
 * between a caller and an unbounded Argon2id verify.
 */
export const stepUpMintSchema = z
  .discriminatedUnion("method", [
    z.object({
      method: z.literal("password"),
      password: z.string().min(1).max(512),
    }),
    z.object({
      method: z.literal("passkey"),
      challengeId: z.string().min(1),
      credential: webauthnCredentialSchema,
    }),
  ])
  .meta({
    id: "StepUpMintRequest",
    description:
      "Re-prove the account password or a primary passkey to mint a single-use, token-bound step-up elevation.",
  });
