/**
 * v1.18.0 — module enable/disable gate.
 *
 * The ONE enforcement point for the module foundation. Every leak-point
 * (nav, dashboard tiles, insights sections, coach snapshot, status
 * routes, reminder jobs, achievements, doctor-report / FHIR, search,
 * quick-add) resolves its decision through `isModuleEnabled(userId, key)`
 * and `requireModuleEnabled(userId, key)`. Mirrors the cycle gate
 * (`src/lib/cycle/gate.ts`) and the assistant feature flags
 * (`src/lib/feature-flags/index.ts`).
 *
 * Source-of-truth discipline (NO double source of truth):
 *
 *   - `cycle`  delegates to `isCycleEnabled(gender, CycleProfile)` — the
 *              existing cycle gate. `modulePreferencesJson.cycle` is
 *              ignored on purpose.
 *   - `coach`  delegates to `User.disableCoach` AND the operator-level
 *              assistant master flag (`getAssistantFlags().coach`). Both
 *              must agree, matching the two-layer model the client gates
 *              already enforce.
 *   - every other module resolves purely from `modulePreferencesJson`
 *              as a DISABLED allowlist (absent / empty / `true` ⇒ on; an
 *              explicit `false` ⇒ off). Default-on.
 *
 * Fail-closed posture: the resolver only ever DISABLES a module when it
 * sees an explicit, well-typed `false` (or, for delegated modules, the
 * delegated source returning disabled). A malformed blob, a missing
 * column, an unknown key — none of these can silently disable a module
 * (default-on), and none can enable a delegated one against its real
 * source. A crafted `{ "weight": false }` blob is inert because `weight`
 * is a core domain, not a `ModuleKey`.
 *
 * Reads are memoised per-request (the assistant-flags pattern) so a
 * single request that gates several modules hits the row once.
 */
import { apiError } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { isCycleEnabled } from "@/lib/cycle/gate";
import { getAssistantFlags } from "@/lib/feature-flags";
import { memoizePerRequest } from "@/lib/request-cache";
import {
  MODULE_KEYS,
  moduleDelegatesTo,
  type ModuleKey,
} from "./registry";

export { MODULE_KEYS } from "./registry";
export type { ModuleKey } from "./registry";

/** Wire `errorCode` the iOS retry classifier branches on. */
export const MODULE_DISABLED_ERROR_CODE = "module.disabled";

/**
 * The per-user fields the gate needs. Bundled so the resolver does a
 * single round-trip and the memo caches one row per request.
 */
export interface ModuleGateInputs {
  gender: string | null;
  disableCoach: boolean;
  modulePreferences: Record<string, boolean>;
  /** `CycleProfile.cycleTrackingEnabled`; NULL ⇒ derive from gender. */
  cycleTrackingEnabled: boolean | null;
}

/**
 * Coerce the persisted blob into a plain `Record<string, boolean>`,
 * keeping only boolean values. A null column, a non-object, or junk
 * entries all collapse to an empty / partial map — which the
 * disabled-allowlist semantics read as "all on". Fail-open per key:
 * only a literal `false` disables.
 */
export function normalisePrefs(raw: unknown): Record<string, boolean> {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "boolean") {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Pure resolver — exposed for unit tests so the disabled-allowlist +
 * delegation logic can be asserted without a DB. `assistantCoach` is the
 * resolved operator-level `getAssistantFlags().coach`; pass it in so this
 * stays synchronous and side-effect-free.
 */
export function resolveModuleEnabled(
  key: ModuleKey,
  inputs: ModuleGateInputs,
  assistantCoach: boolean,
): boolean {
  const delegate = moduleDelegatesTo(key);

  if (delegate === "cycle") {
    // Single source of truth: the cycle gate. The module blob is ignored.
    return isCycleEnabled(inputs.gender, {
      cycleTrackingEnabled: inputs.cycleTrackingEnabled,
    });
  }

  if (delegate === "coach") {
    // Two-layer model: operator master flag AND per-user opt-out.
    return assistantCoach && !inputs.disableCoach;
  }

  // Disabled allowlist: only an explicit `false` turns the module off.
  return inputs.modulePreferences[key] !== false;
}

/** Internal: load the gate inputs once per request. */
function loadInputs(userId: string): Promise<ModuleGateInputs> {
  return memoizePerRequest(`module-gate-inputs:${userId}`, async () => {
    const [user, cycleProfile] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          gender: true,
          disableCoach: true,
          modulePreferencesJson: true,
        },
      }),
      prisma.cycleProfile.findUnique({
        where: { userId },
        select: { cycleTrackingEnabled: true },
      }),
    ]);
    return {
      gender: user?.gender ?? null,
      disableCoach: user?.disableCoach ?? false,
      modulePreferences: normalisePrefs(user?.modulePreferencesJson),
      cycleTrackingEnabled: cycleProfile?.cycleTrackingEnabled ?? null,
    };
  });
}

/**
 * Resolve whether a module is enabled for an account. Default-on:
 * an unknown / absent / non-`false` state reads as enabled. Delegated
 * modules (`cycle`, `coach`) resolve through their real source.
 */
export async function isModuleEnabled(
  userId: string,
  moduleKey: ModuleKey,
): Promise<boolean> {
  const inputs = await loadInputs(userId);
  const delegate = moduleDelegatesTo(moduleKey);
  // Only pay the assistant-flags read when resolving the coach delegate.
  const assistantCoach =
    delegate === "coach" ? (await getAssistantFlags()).coach : false;
  return resolveModuleEnabled(moduleKey, inputs, assistantCoach);
}

/**
 * Resolve the full `{ <key>: boolean }` map for every toggleable module,
 * suitable for the `GET /api/auth/me` projection. cycle/coach reflect
 * their real delegated state.
 */
export async function resolveModuleMap(
  userId: string,
): Promise<Record<ModuleKey, boolean>> {
  const inputs = await loadInputs(userId);
  const assistantCoach = (await getAssistantFlags()).coach;
  const out = {} as Record<ModuleKey, boolean>;
  for (const key of MODULE_KEYS) {
    out[key] = resolveModuleEnabled(key, inputs, assistantCoach);
  }
  return out;
}

/**
 * Route-guard outcome: either a clear pass or a ready 403 envelope to
 * return verbatim — mirrors `CycleGateResult`.
 */
export type ModuleGateResult =
  | { enabled: true }
  | { enabled: false; response: Response };

/**
 * Enforce the gate for a module-scoped route. Returns a 403
 * `module.disabled` envelope (carrying the module key in `meta`) when the
 * account has the module turned off — even with a valid Bearer token.
 */
export async function requireModuleEnabled(
  userId: string,
  moduleKey: ModuleKey,
): Promise<ModuleGateResult> {
  if (await isModuleEnabled(userId, moduleKey)) {
    return { enabled: true };
  }
  return {
    enabled: false,
    response: apiError(`Module "${moduleKey}" is not enabled`, 403, {
      errorCode: MODULE_DISABLED_ERROR_CODE,
      module: moduleKey,
    }),
  };
}
