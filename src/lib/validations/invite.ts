/**
 * v1.15.20 — request schema for `POST /api/admin/invites`.
 *
 * Lives outside the route file (and outside the Prisma-backed helper
 * `src/lib/auth/invite-token.ts`) so the OpenAPI registry can import it
 * without dragging `@/lib/db` into the generator script — the same
 * split as `src/lib/validations/about-me.ts`.
 */
import { z } from "zod/v4";

/** Hard ceiling on the admin-selectable invite lifetime (days). */
export const INVITE_MAX_TTL_DAYS = 30;

/** Hard ceiling on multi-use invites — generous for a household / small
 * practice, far below anything that would re-open registration at scale. */
export const INVITE_MAX_USES_CAP = 50;

export const inviteCreateSchema = z.object({
  /** Lifetime in days. The admin UI offers 7 / 14 / 30; the API accepts
   * any integer 1–30 so an operator can script shorter invites. */
  expiresInDays: z.number().int().min(1).max(INVITE_MAX_TTL_DAYS).default(7),
  /** How many signups this invite admits. Default: single-use. */
  maxUses: z.number().int().min(1).max(INVITE_MAX_USES_CAP).default(1),
});

export type InviteCreateInput = z.infer<typeof inviteCreateSchema>;
