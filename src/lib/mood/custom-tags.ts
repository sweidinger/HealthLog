import { randomUUID } from "node:crypto";

import { z } from "zod/v4";

import { encrypt, decrypt } from "@/lib/crypto";

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

/**
 * Allow-list of Lucide icon names a custom tag may use. Kept to names the iOS
 * client maps to an SF Symbol (`MoodTagSFSymbol`) so a custom tag never falls
 * back to the generic glyph on one platform; iOS extends its map to cover the
 * final list. An unknown name → 422. `Tag` is the default.
 */
export const CUSTOM_TAG_ICON_ALLOWLIST = [
  "Tag",
  "Heart",
  "Smile",
  "Frown",
  "Dumbbell",
  "Moon",
  "Sun",
  "Wine",
  "Coffee",
  "House",
  "Briefcase",
  "Book",
  "Music",
  "Plane",
  "Car",
  "Users",
  "Pill",
  "Activity",
  "Brain",
  "Cloud",
  "Star",
  "Zap",
] as const;

const ICON_SET = new Set<string>(CUSTOM_TAG_ICON_ALLOWLIST);

/** Is `key` a custom-tag key (vs a bare catalogue slug)? */
export function isCustomTagKey(key: string): boolean {
  return key.startsWith(CUSTOM_TAG_KEY_PREFIX);
}

/** Mint a fresh, collision-proof custom-tag key. */
export function mintCustomTagKey(): string {
  return `${CUSTOM_TAG_KEY_PREFIX}${randomUUID()}`;
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

/** POST body — create a custom tag. */
export const createCustomTagSchema = z.object({
  label: labelSchema,
  icon: iconSchema,
  // Reserved for a future per-tag category choice; v1 pins everything to the
  // `custom` category, so a supplied value other than `custom` is rejected.
  categoryKey: z.literal(CUSTOM_CATEGORY_KEY).optional(),
});

/** PATCH body — update a custom tag (every field optional). */
export const updateCustomTagSchema = z
  .object({
    label: labelSchema.optional(),
    icon: iconSchema,
    isActive: z.boolean().optional(),
  })
  .refine(
    (v) => v.label !== undefined || v.icon !== undefined || v.isActive !== undefined,
    "At least one field is required",
  );

/** PUT body — hide / show a catalogue tag for the user. */
export const hideCatalogueTagSchema = z.object({
  hidden: z.boolean(),
});
