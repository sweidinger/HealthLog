import { z } from "zod/v4";

/**
 * Per-user Strava BYO-key credentials. Strava caps every newly-created API app
 * at single-player mode (athlete capacity 1), so a single shared app cannot
 * serve many self-hosters — each registers their own Strava app and pastes the
 * client id/secret into Settings. Stored encrypted on `User`. When unset, the
 * integration falls back to the shared env-configured OAuth app.
 */
export const stravaCredentialsSchema = z.object({
  // Trimmed: a trailing space or newline from the portal's copy button reaches
  // Strava verbatim and answers as "invalid client".
  clientId: z.string().trim().min(1).max(200),
  clientSecret: z.string().trim().min(1).max(200),
});

export type StravaCredentialsInput = z.infer<typeof stravaCredentialsSchema>;
