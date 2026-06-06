import { randomUUID } from "node:crypto";

import { z } from "zod/v4";

import { encrypt, decrypt } from "@/lib/crypto";

/**
 * v1.15.1 — per-user custom cycle-symptom helpers (the v1.13 custom-mood-tag
 * precedent, mirrored 1:1).
 *
 * Custom symptoms live in the same `cycle_symptoms` table as the seeded
 * catalogue, distinguished by a non-null `userId`. Their key carries a
 * reserved `custom:` prefix so it never collides with a bare catalogue slug,
 * and the write path (`day-log-write.ts:resolveSymptomIds`) already resolves a
 * key against the catalogue rows (userId NULL) PLUS the caller's own rows —
 * so a `custom:` key routes to the user's symptom by construction. The label
 * is held AES-256-GCM-encrypted at rest (`labelEncrypted`): a symptom name is
 * intent-revealing free text, the highest-sensitivity category in the
 * post-Dobbs threat model.
 */

/** Reserved key prefix for a user-minted custom symptom. */
export const CUSTOM_SYMPTOM_KEY_PREFIX = "custom:";

/** Stable category key + seeded id every custom symptom hangs under. */
export const CUSTOM_SYMPTOM_CATEGORY_KEY = "custom";
export const CUSTOM_SYMPTOM_CATEGORY_ID = "csc_custom";

/** Per-user ceiling on custom symptoms (422 over the cap). */
export const MAX_CUSTOM_SYMPTOMS_PER_USER = 50;

/**
 * Allow-list of Lucide icon names a custom symptom may use. Kept to names the
 * iOS client maps to an SF Symbol so a custom symptom never falls back to the
 * generic glyph on one platform. An unknown name → 422. `Tag` is the default.
 */
export const CUSTOM_SYMPTOM_ICON_ALLOWLIST = [
  "Tag",
  "Activity",
  "Heart",
  "HeartPulse",
  "Brain",
  "Zap",
  "Flame",
  "Snowflake",
  "Droplet",
  "CircleDot",
  "BatteryLow",
  "MoonStar",
  "PersonStanding",
  "Drama",
  "Frown",
  "Cookie",
  "Soup",
  "Pill",
  "Thermometer",
  "Stethoscope",
] as const;

const ICON_SET = new Set<string>(CUSTOM_SYMPTOM_ICON_ALLOWLIST);

/** Is `key` a custom-symptom key (vs a bare catalogue slug)? */
export function isCustomSymptomKey(key: string): boolean {
  return key.startsWith(CUSTOM_SYMPTOM_KEY_PREFIX);
}

/** Mint a fresh, collision-proof custom-symptom key. */
export function mintCustomSymptomKey(): string {
  return `${CUSTOM_SYMPTOM_KEY_PREFIX}${randomUUID()}`;
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

/** POST body — create a custom symptom. */
export const createCustomSymptomSchema = z.object({
  label: labelSchema,
  icon: iconSchema,
  // Reserved for a future per-symptom category choice; v1 pins everything to
  // the `custom` category, so a supplied value other than `custom` is rejected.
  categoryKey: z.literal(CUSTOM_SYMPTOM_CATEGORY_KEY).optional(),
});

/** PATCH body — update a custom symptom (every field optional). */
export const updateCustomSymptomSchema = z
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
