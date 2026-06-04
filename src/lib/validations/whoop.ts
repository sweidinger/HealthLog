import { z } from "zod/v4";

/**
 * Per-user WHOOP BYO-key credentials. Each self-hoster registers their own
 * WHOOP dev app and pastes the client id/secret into Settings (the per-app
 * authorized-user cap makes a single shared app unworkable for a
 * multi-operator product). Stored encrypted on `User`.
 */
export const whoopCredentialsSchema = z.object({
  clientId: z.string().min(1).max(200),
  clientSecret: z.string().min(1).max(200),
});

export type WhoopCredentialsInput = z.infer<typeof whoopCredentialsSchema>;
