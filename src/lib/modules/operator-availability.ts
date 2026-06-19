/**
 * v1.18.0 — operator-level server-wide module availability.
 *
 * The SECOND layer of the two-layer module model. The first layer is the
 * per-user opt-out (`User.modulePreferencesJson`, resolved in
 * `./gate.ts`); this layer is the operator's server-wide kill-switch
 * (`AppSettings.moduleAvailabilityJson`). A module the operator turns off
 * is off for EVERY account regardless of that account's personal
 * preference — exactly mirroring how the coach master flag
 * (`assistant_coach_enabled`) sits above the per-user `User.disableCoach`.
 *
 * Persisted shape: a DISABLED allowlist, identical in semantics to the
 * per-user blob —
 *
 *   - NULL / empty / key absent  ⇒ available
 *   - key present & `false`       ⇒ disabled server-wide
 *   - key present & `true`        ⇒ available (redundant-but-allowed)
 *
 * Default-available, no backfill: a fresh / upgraded instance keeps every
 * module available until an operator flips one off.
 *
 * Fail-open posture: a null column, a malformed blob, an unknown key, or a
 * read error all resolve to "available". Only an explicit, well-typed
 * `false` for a known toggleable key disables a module server-wide. This
 * matches the per-user resolver's posture so a storage glitch never
 * silently hides a domain from the whole server.
 *
 * CORE domains (weight, BP, pulse, medications) are NOT `ModuleKey`s, are
 * never written here, and the admin write endpoint refuses them — the
 * measurement engine + meds can never be disabled.
 */
import { prisma } from "@/lib/db";
import { getEvent } from "@/lib/logging/context";
import { memoizePerRequest } from "@/lib/request-cache";

import { MODULE_KEYS, isModuleKey, type ModuleKey } from "./registry";

/**
 * The resolved operator availability map: one boolean per toggleable
 * module. `true` ⇒ available server-wide, `false` ⇒ disabled server-wide.
 */
export type OperatorModuleAvailability = Record<ModuleKey, boolean>;

/**
 * Coerce the persisted blob into a normalised availability map. Every
 * known toggleable key gets an entry; absent / non-boolean / unknown keys
 * collapse to `true` (available) per the disabled-allowlist contract.
 *
 * Exposed for unit tests so the coercion + allowlist logic can be asserted
 * without a DB.
 */
export function resolveOperatorAvailability(
  raw: unknown,
): OperatorModuleAvailability {
  const blob =
    raw != null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  const out = {} as OperatorModuleAvailability;
  for (const key of MODULE_KEYS) {
    // Only an explicit `false` disables; everything else is available.
    out[key] = blob[key] !== false;
  }
  return out;
}

/**
 * Load the operator availability map once per request. Mirrors the
 * `getAssistantFlags()` / `getGlobalServiceAvailability()` read-through:
 * a missing row, a null column, or a read error all fall back to
 * all-available so the modules stay visible on first boot.
 */
export async function getOperatorModuleAvailability(): Promise<OperatorModuleAvailability> {
  return memoizePerRequest("operator-module-availability", async () => {
    try {
      const settings = await prisma.appSettings.findUnique({
        where: { id: "singleton" },
        select: { moduleAvailabilityJson: true },
      });
      return resolveOperatorAvailability(settings?.moduleAvailabilityJson);
    } catch {
      getEvent()?.addWarning(
        "Failed to load operator module availability, defaulting to all-available",
      );
      return resolveOperatorAvailability(null);
    }
  });
}

/**
 * Narrow + validate an operator write patch (the admin route's parsed
 * body) into a sanitised `{ <ModuleKey>: boolean }` map. Drops any key
 * that is not a known toggleable module — so a crafted `{ weight: false }`
 * (a core domain) or junk key can never land in the persisted blob.
 *
 * Returns the merged blob to persist (existing availability overlaid with
 * the validated patch) so a partial PATCH leaves untouched keys intact.
 */
export function mergeAvailabilityPatch(
  existing: unknown,
  patch: Record<string, boolean>,
): Record<string, boolean> {
  // Start from the existing persisted blob, keeping only known boolean
  // entries, then overlay the validated patch.
  const merged: Record<string, boolean> = {};
  if (
    existing != null &&
    typeof existing === "object" &&
    !Array.isArray(existing)
  ) {
    for (const [k, v] of Object.entries(existing as Record<string, unknown>)) {
      if (isModuleKey(k) && typeof v === "boolean") {
        merged[k] = v;
      }
    }
  }
  for (const [k, v] of Object.entries(patch)) {
    if (isModuleKey(k)) {
      merged[k] = v;
    }
  }
  return merged;
}
