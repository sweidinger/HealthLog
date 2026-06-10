/**
 * v1.15.20 — request schema for `PUT /api/coach/about-me`.
 *
 * Lives outside the route file so the OpenAPI registry
 * (`src/lib/openapi/routes.ts`) can import it without touching the
 * route module (route files may only export handlers + config), and
 * without dragging the Prisma-backed helper module
 * (`src/lib/ai/coach/about-me.ts`) into the generator script.
 */
import { z } from "zod/v4";

/** Hard cap enforced BEFORE encryption. */
export const ABOUT_ME_MAX_CHARS = 4000;

export const aboutMePutSchema = z.object({
  /**
   * The user's free-text self-description. An empty / whitespace-only
   * value clears the stored text.
   */
  aboutMe: z
    .string()
    .max(ABOUT_ME_MAX_CHARS, `Maximum ${ABOUT_ME_MAX_CHARS} characters`),
});

export type AboutMePutInput = z.infer<typeof aboutMePutSchema>;
