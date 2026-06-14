import { z } from "zod/v4";

/**
 * Per-user Polar BYO-key credentials. Each self-hoster registers their own
 * Polar AccessLink app and pastes the client id/secret into Settings. Stored
 * encrypted on `User`. When unset, the integration falls back to the shared
 * env-configured OAuth app.
 */
export const polarCredentialsSchema = z.object({
  // Trimmed: a trailing space or newline from the portal's copy button reaches
  // Polar verbatim and answers as "unknown client".
  clientId: z.string().trim().min(1).max(200),
  clientSecret: z.string().trim().min(1).max(200),
});

export type PolarCredentialsInput = z.infer<typeof polarCredentialsSchema>;
