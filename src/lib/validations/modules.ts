/**
 * v1.18.0 — module enable/disable request validation.
 *
 * The PATCH body is a partial map of TOGGLEABLE module keys → boolean.
 * Only keys in the canonical registry (`MODULE_KEYS`) are accepted; a
 * core-domain key (`weight`, `bloodPressure`, `pulse`, `medications`) or
 * any unknown key is a 422 — so the core measurement engine + meds can
 * never be disabled through this surface (defence-in-depth on top of the
 * gate, which has no key to flip for core domains anyway).
 *
 * `strict()` rejects unknown keys outright rather than silently dropping
 * them, so a client gets a clear error instead of a no-op.
 *
 * The shared shape is reused by the OpenAPI registry so the wire
 * contract stays single-source.
 */
import { z } from "zod/v4";

import { MODULE_KEYS } from "@/lib/modules/registry";

/** Build `{ <toggleableKey>?: boolean }` from the canonical key list. */
const moduleShape = Object.fromEntries(
  MODULE_KEYS.map((k) => [k, z.boolean().optional()]),
) as Record<(typeof MODULE_KEYS)[number], z.ZodOptional<z.ZodBoolean>>;

/**
 * Partial module-preferences PATCH body. Every key is an optional
 * boolean; omitted keys are left untouched server-side. `strict()`
 * rejects any key not in `MODULE_KEYS` (including core domains).
 */
export const modulePrefsPatchSchema = z.object(moduleShape).strict();

export type ModulePrefsPatch = z.infer<typeof modulePrefsPatchSchema>;
