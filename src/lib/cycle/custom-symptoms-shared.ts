import { z } from "zod/v4";

/**
 * v1.15.1 — client-safe constants + Zod schemas for custom cycle symptoms.
 *
 * Split out of `custom-symptoms.ts` so a `"use client"` component (the log
 * sheet's chip grid) can read the icon allow-list and key helpers WITHOUT
 * pulling the server-only crypto / `node:crypto` the mint + label-encryption
 * helpers depend on into the browser bundle. The server module re-exports
 * everything here, so existing server import sites are unaffected.
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
