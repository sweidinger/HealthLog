/**
 * v1.15.20 — request schema for `PUT /api/coach/about-me`.
 * v1.16.0 — extended with three structured self-context fields
 * (conditions, allergies, coach focus). Age/gender deliberately stay
 * on the User profile and are merged into the prompt block at assembly
 * time — the questionnaire never duplicates them.
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

/** Per-field cap for the structured answers, BEFORE encryption. */
export const ABOUT_ME_FIELD_MAX_CHARS = 500;

const structuredField = z
  .string()
  .max(
    ABOUT_ME_FIELD_MAX_CHARS,
    `Maximum ${ABOUT_ME_FIELD_MAX_CHARS} characters`,
  )
  // Optional so older clients that only send `aboutMe` keep working;
  // an omitted field leaves the stored value untouched, an empty
  // string clears it (mirrors the `aboutMe` semantics).
  .optional();

export const aboutMePutSchema = z.object({
  /**
   * The user's free-text self-description. An empty / whitespace-only
   * value clears the stored text.
   */
  aboutMe: z
    .string()
    .max(ABOUT_ME_MAX_CHARS, `Maximum ${ABOUT_ME_MAX_CHARS} characters`),
  /** Chronic conditions, short free text. */
  conditions: structuredField,
  /** Allergies / intolerances, short free text. */
  allergies: structuredField,
  /** What the Coach should pay attention to, short free text. */
  coachFocus: structuredField,
});

export type AboutMePutInput = z.infer<typeof aboutMePutSchema>;

/**
 * v1.16.4 — request schema for `POST /api/coach/about-me/adopt`: a
 * clarifying-question answer the user chose to fold back into the
 * stored self-context. The server picks the matching structured field
 * from the question wording, dedupes against the stored text, and
 * appends encrypted.
 */
export const aboutMeAdoptSchema = z.object({
  /** The clarifying question the answer belongs to (field matching). */
  question: z.string().trim().min(1).max(500),
  /** The user's answer, as typed into the Coach composer. */
  answer: z.string().trim().min(1).max(ABOUT_ME_FIELD_MAX_CHARS),
});

export type AboutMeAdoptInput = z.infer<typeof aboutMeAdoptSchema>;
