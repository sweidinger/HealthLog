import { z } from "zod/v4";

/**
 * Per-user WHOOP BYO-key credentials. Each self-hoster registers their own
 * WHOOP dev app and pastes the client id/secret into Settings (the per-app
 * authorized-user cap makes a single shared app unworkable for a
 * multi-operator product). Stored encrypted on `User`.
 */
export const whoopCredentialsSchema = z.object({
  // Trimmed: a trailing space or newline from the portal's copy button
  // reaches WHOOP verbatim and answers as "unknown client".
  clientId: z.string().trim().min(1).max(200),
  clientSecret: z.string().trim().min(1).max(200),
});

export type WhoopCredentialsInput = z.infer<typeof whoopCredentialsSchema>;
