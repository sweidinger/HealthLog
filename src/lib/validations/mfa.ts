/**
 * Request schemas for the second-factor (MFA) surface. Single-sourced here so
 * the runtime `safeParse` and the OpenAPI registry (`src/lib/openapi/routes/
 * auth.ts`) describe the identical wire contract.
 */
import { z } from "zod/v4";

/** A 6-digit TOTP code. */
export const totpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, "Enter the 6-digit code from your authenticator app");

/**
 * A recovery code as displayed (`XXXXX-XXXXX`) — accepted case-insensitively
 * with or without the separator; the server normalises before comparing.
 */
export const recoveryCodeSchema = z.string().trim().min(8).max(32);

export const totpConfirmSchema = z.object({
  code: totpCodeSchema,
});

/** Disable MFA: prove possession of a current factor (TOTP or recovery code). */
export const mfaDisableSchema = z
  .object({
    code: z.string().trim().min(6).max(32),
    method: z.enum(["totp", "recovery"]).default("totp"),
  })
  .meta({
    id: "MfaDisableRequest",
    description:
      "Disable the second factor. Requires fresh step-up plus a current TOTP or recovery code.",
  });

/** Login second-factor completion: ticket + a TOTP or recovery code. */
export const mfaVerifySchema = z
  .object({
    mfaTicket: z
      .string()
      .min(1)
      .describe("The opaque single-use ticket from the login response."),
    method: z.enum(["totp", "recovery"]).default("totp"),
    code: z.string().trim().min(6).max(32),
  })
  .meta({
    id: "MfaVerifyRequest",
    description:
      "Complete a second-factor login challenge and receive the same token bundle the password path issues.",
  });
