/**
 * v1.21.3 (B1) — request schemas for the Coach goal / if-then plan surface
 * (`/api/coach/plans` + `/api/coach/plans/[id]`).
 *
 * Lives outside the route files so the OpenAPI registry can import it without
 * touching the route modules (route files may only export handlers + config)
 * and without dragging the Prisma-backed helper module into the generator
 * script.
 *
 * No `userId` field anywhere — the owner is always narrowed from the session.
 * The extractor is the only writer of plan TEXT; this surface only lets the
 * user CONFIRM (proposed → active), mark a plan met / abandoned, set a review
 * date, or soft-delete. It never accepts the encrypted free-text fields, so a
 * client can never inject or overwrite a plan's prose.
 */
import { z } from "zod/v4";

import { COACH_PLAN_STATUSES } from "@/lib/ai/coach/plans";

/** Optional `?status=` filter on the list endpoint. */
export const coachPlansListQuerySchema = z.object({
  status: z.enum(COACH_PLAN_STATUSES).optional(),
});

/**
 * The user-facing PATCH body. `status` is the only mutable lifecycle field; a
 * `proposed` plan moves to `active` (confirm), or a plan moves to `met` /
 * `abandoned`. `reviewDate` optionally pins / clears a check-in checkpoint
 * (null clears). Strict: unknown keys 422, so a client cannot smuggle a
 * userId, a metric, or the encrypted text.
 */
export const coachPlanPatchSchema = z
  .object({
    status: z.enum(COACH_PLAN_STATUSES).optional(),
    reviewDate: z.iso.datetime({ offset: true }).nullable().optional(),
  })
  .strict()
  .refine(
    (v) => v.status !== undefined || v.reviewDate !== undefined,
    "At least one of status or reviewDate must be provided",
  );
