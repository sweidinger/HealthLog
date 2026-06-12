import { randomUUID } from "node:crypto";

import { z } from "zod/v4";

import { encrypt, decrypt } from "@/lib/crypto";
import { MOOD_TAG_ICON_NAMES } from "@/lib/mood/icon-catalog";

/**
 * v1.13.0 — per-user custom mood-tag helpers (iOS v1.13.0 contract).
 *
 * Custom tags live in the same `mood_tags` table as the global catalogue,
 * distinguished by a non-null `userId`. Their key carries a reserved
 * `custom:` prefix so it never collides with a bare catalogue slug, and the
 * write path (`tag-links.ts`) routes a `custom:` key to the caller's own rows
 * and a bare key to the catalogue. v1 customs are BINARY only; the label is
 * held AES-256-GCM-encrypted at rest (it is user prose, possibly
 * health-adjacent — iOS F4 push-back).
 */

/** Reserved key prefix for a user-minted custom tag. */
export const CUSTOM_TAG_KEY_PREFIX = "custom:";

/** Stable category key + seeded id every custom tag hangs under. */
export const CUSTOM_CATEGORY_KEY = "custom";
export const CUSTOM_CATEGORY_ID = "mtc_custom";

/** Per-user ceiling on custom tags (422 over the cap). */
export const MAX_CUSTOM_TAGS_PER_USER = 50;

/** v1.17.0 — reserved key prefix for a user-minted custom group. */
export const CUSTOM_CATEGORY_KEY_PREFIX = "customcat:";

/** v1.17.0 — per-user ceiling on custom groups (422 over the cap). */
export const MAX_CUSTOM_GROUPS_PER_USER = 12;

/**
 * Allow-list of Lucide icon names a custom tag or group may use — derived
 * from the curated catalog in `icon-catalog.ts` (the shared server/client
 * seam). Every name has an iOS SF-Symbol mapping (`MoodTagSFSymbol`) so a
 * custom tag never falls back to the generic glyph on one platform; iOS
 * extends its map before the catalog grows. An unknown name → 422. `Tag`
 * is the default.
 */
export const CUSTOM_TAG_ICON_ALLOWLIST: readonly string[] = MOOD_TAG_ICON_NAMES;

const ICON_SET = new Set<string>(CUSTOM_TAG_ICON_ALLOWLIST);

/** Is `key` a custom-tag key (vs a bare catalogue slug)? */
export function isCustomTagKey(key: string): boolean {
  return key.startsWith(CUSTOM_TAG_KEY_PREFIX);
}

/** Mint a fresh, collision-proof custom-tag key. */
export function mintCustomTagKey(): string {
  return `${CUSTOM_TAG_KEY_PREFIX}${randomUUID()}`;
}

/** v1.17.0 — is `key` a custom-group key (vs a seeded category slug)? */
export function isCustomCategoryKey(key: string): boolean {
  return key.startsWith(CUSTOM_CATEGORY_KEY_PREFIX);
}

/** v1.17.0 — mint a fresh, collision-proof custom-group key. */
export function mintCustomCategoryKey(): string {
  return `${CUSTOM_CATEGORY_KEY_PREFIX}${randomUUID()}`;
}

/** Encrypt a custom label for storage in `label_encrypted`. */
export function encryptCustomLabel(label: string): string {
  return encrypt(label);
}

/**
 * Decrypt a stored custom label. Returns null on a missing or corrupt
 * ciphertext so one bad row never throws the whole effective-set read.
 */
export function decryptCustomLabel(encoded: string | null): string | null {
  if (!encoded) return null;
  try {
    return decrypt(encoded);
  } catch {
    return null;
  }
}

const labelSchema = z
  .string()
  .trim()
  .min(1, "Label must not be empty")
  .max(40, "Label must be at most 40 characters");

const iconSchema = z
  .string()
  .refine((v) => ICON_SET.has(v), "Unknown icon")
  .nullish();

/**
 * v1.17.0 — a category key on the wire: a seeded slug (`feelings`, `custom`,
 * …) or a user's own `customcat:<uuid>` group key. The handler resolves it
 * against the seeded set OR the caller's own groups; anything else → 422.
 */
const categoryKeySchema = z.string().trim().min(1).max(80);

/** POST body — create a custom tag. */
export const createCustomTagSchema = z.object({
  label: labelSchema,
  icon: iconSchema,
  // v1.17.0 — home group for the new tag. Omitted → the seeded `custom`
  // category (the v1.13.0 behaviour).
  categoryKey: categoryKeySchema.optional(),
});

/** PATCH body — update a custom tag (every field optional). */
export const updateCustomTagSchema = z
  .object({
    label: labelSchema.optional(),
    icon: iconSchema,
    isActive: z.boolean().optional(),
    // v1.17.0 — move the tag to another group (real `categoryId` move).
    categoryKey: categoryKeySchema.optional(),
  })
  .refine(
    (v) =>
      v.label !== undefined ||
      v.icon !== undefined ||
      v.isActive !== undefined ||
      v.categoryKey !== undefined,
    "At least one field is required",
  );

/** v1.17.0 — POST body — create a custom group. */
export const createCustomGroupSchema = z.object({
  label: labelSchema,
  icon: iconSchema,
});

/** v1.17.0 — PATCH body — update a custom group (every field optional). */
export const updateCustomGroupSchema = z
  .object({
    label: labelSchema.optional(),
    icon: iconSchema,
    isActive: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.label !== undefined || v.icon !== undefined || v.isActive !== undefined,
    "At least one field is required",
  );

/** PUT body — hide / show a catalogue tag for the user. */
export const hideCatalogueTagSchema = z.object({
  hidden: z.boolean(),
});
