/**
 * Family-history request/response validation (v1.25, W-RECORDS).
 *
 * Source of truth for the `/api/family-history/*` wire contract. The Zod
 * schemas here are reused by the OpenAPI registry so the spec stays
 * single-source. `userId` is NEVER a body field — it is narrowed from the
 * session/Bearer in every route and fed to the Prisma `where`.
 *
 * A structured FamilyMemberHistory-style RECORD (one condition per relative;
 * not a time-series signal): `relationship` + `condition` label + optional
 * `ageAtOnset`; the optional free-text note is encrypted at rest
 * (`notesEncrypted` Bytes column). Patient-reported.
 */
import { z } from "zod/v4";

/* ── enum (mirrors the Prisma enum) ──────────────────────────────── */

export const familyRelationshipEnum = z.enum([
  "MOTHER",
  "FATHER",
  "SISTER",
  "BROTHER",
  "DAUGHTER",
  "SON",
  "GRANDMOTHER_MATERNAL",
  "GRANDFATHER_MATERNAL",
  "GRANDMOTHER_PATERNAL",
  "GRANDFATHER_PATERNAL",
  "AUNT",
  "UNCLE",
  "COUSIN",
  "HALF_SIBLING",
  "OTHER",
]);

/* ── CRUD ─────────────────────────────────────────────────────────── */

/**
 * Create a family-history entry. `condition` is the user-facing condition
 * name; `ageAtOnset` is the relative's age (years) when it began; the
 * free-text `note` is encrypted at rest.
 */
export const familyHistoryCreateSchema = z.object({
  relationship: familyRelationshipEnum,
  condition: z.string().min(1).max(160),
  ageAtOnset: z.number().int().min(0).max(120).nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
});

export type FamilyHistoryCreate = z.infer<typeof familyHistoryCreateSchema>;

/**
 * Edit a family-history entry — every field optional; an omitted field is
 * left untouched. Rejects unknown keys.
 */
export const familyHistoryUpdateSchema = z
  .object({
    relationship: familyRelationshipEnum.optional(),
    condition: z.string().min(1).max(160).optional(),
    ageAtOnset: z.number().int().min(0).max(120).nullable().optional(),
    note: z.string().max(2000).nullable().optional(),
  })
  .strict();

export type FamilyHistoryUpdate = z.infer<typeof familyHistoryUpdateSchema>;

/** History/list query — bounded. */
export const familyHistoryListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export type FamilyHistoryListQuery = z.infer<
  typeof familyHistoryListQuerySchema
>;
