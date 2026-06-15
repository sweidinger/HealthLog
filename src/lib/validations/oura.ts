import { z } from "zod/v4";

/**
 * Per-user Oura BYO-key credentials. Each self-hoster registers their own Oura
 * app and pastes the client id/secret into Settings. Stored encrypted on
 * `User`. When unset, the integration falls back to the shared env-configured
 * OAuth app.
 */
export const ouraCredentialsSchema = z.object({
  // Trimmed: a trailing space or newline from the portal's copy button reaches
  // Oura verbatim and answers as "unknown client".
  clientId: z.string().trim().min(1).max(200),
  clientSecret: z.string().trim().min(1).max(200),
});

export type OuraCredentialsInput = z.infer<typeof ouraCredentialsSchema>;
