/**
 * v1.11.0 — clinician share-link lifecycle validation (Epic C, C4).
 *
 * The OWNER creates a time-boxed, scope-frozen share link to their own health
 * record. On create the server mints an `hls_<48 hex>` token (192-bit), stores
 * ONLY its HMAC hash, and returns the raw token exactly once. Every scope
 * column (window, sections, FHIR resource types, API toggle) is write-once at
 * creation — there is no widen/update path. `expiresAt` is REQUIRED and capped
 * at `SHARE_LINK_MAX_DAYS` so no link ever lives forever.
 *
 * Strict: `.strict()` rejects unknown keys; there is intentionally no `userId`
 * field (the owner is always narrowed from `requireAuth()`).
 */
import { z } from "zod/v4";

import { exportSectionsSchema } from "@/lib/validations/health-record-export";

/** Maximum lifetime of a share link, in days. No never-expiring share. */
export const SHARE_LINK_MAX_DAYS = 90;

/**
 * The FHIR resource types a share link may be scoped to serve — the read-only
 * catalogue the REST face exposes. A create request may select any subset;
 * an empty array means "no FHIR resources" (view-only, when `allowFhirApi` is
 * off this is moot).
 */
export const SHARE_LINK_RESOURCE_TYPES = [
  "Patient",
  "Observation",
  "MedicationStatement",
  "MedicationAdministration",
] as const;

export const shareLinkResourceTypeEnum = z.enum(SHARE_LINK_RESOURCE_TYPES);

const MAX_FUTURE_MS = SHARE_LINK_MAX_DAYS * 24 * 60 * 60 * 1000;

/**
 * Create payload. `expiresAt` is an absolute ISO instant, must be in the
 * future, and at most `SHARE_LINK_MAX_DAYS` ahead of now. `rangeStart` /
 * `rangeEnd` are the frozen reporting window (rangeEnd null = rolling).
 */
export const createShareLinkSchema = z
  .object({
    label: z.string().trim().min(1).max(120),
    rangeStart: z.iso.datetime({ offset: true }),
    rangeEnd: z.iso.datetime({ offset: true }).nullable().optional(),
    sections: exportSectionsSchema.optional(),
    resourceTypes: z.array(shareLinkResourceTypeEnum).max(8).optional(),
    allowFhirApi: z.boolean().optional(),
    expiresAt: z.iso
      .datetime({ offset: true })
      .refine((v) => new Date(v).getTime() > Date.now(), {
        message: "expiresAt must be in the future",
      })
      .refine((v) => new Date(v).getTime() <= Date.now() + MAX_FUTURE_MS, {
        message: `expiresAt must be within ${SHARE_LINK_MAX_DAYS} days`,
      }),
  })
  .strict()
  .refine(
    (v) =>
      v.rangeEnd == null ||
      new Date(v.rangeEnd).getTime() >= new Date(v.rangeStart).getTime(),
    { message: "rangeEnd must not precede rangeStart", path: ["rangeEnd"] },
  );

export type CreateShareLinkInput = z.infer<typeof createShareLinkSchema>;
