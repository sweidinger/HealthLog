/**
 * Illness / condition-journal feature gate (v1.18.1).
 *
 * The illness journal is BORN-GATED (opt-in / default-off) and resolves
 * its enabled-state through the module foundation — there is no per-domain
 * profile row and no second source of truth. `isIllnessEnabled` and the
 * `requireIllnessEnabled` 403 guard both delegate to the module gate's
 * `isModuleEnabled(userId, "illness")`, which (for a born-gated key) reads
 * an explicit `modulePreferencesJson.illness === true` AND the operator
 * server-wide availability. This mirrors `src/lib/cycle/gate.ts` so every
 * `/api/illness/*` route gates identically.
 */
import { apiError } from "@/lib/api-response";
import { isModuleEnabled, requireModuleEnabled } from "@/lib/modules/gate";

/** Wire `errorCode` the iOS retry classifier branches on. */
export const ILLNESS_DISABLED_ERROR_CODE = "illness.disabled";

/**
 * Fully-resolved illness availability for an account: the born-gated opt-in
 * AND the operator server-wide kill-switch, via the module foundation.
 */
export function isIllnessEnabled(userId: string): Promise<boolean> {
  return isModuleEnabled(userId, "illness");
}

/**
 * Route-guard outcome: a clear pass or a ready 403 envelope to return
 * verbatim — mirrors `CycleGateResult`.
 */
export type IllnessGateResult =
  | { enabled: true }
  | { enabled: false; response: Response };

/**
 * Enforce the gate for an `/api/illness/*` route. Returns a 403
 * `illness.disabled` envelope when the account has not opted in (or the
 * operator turned the module off server-wide) — even with a valid Bearer
 * token. Delegates to `requireModuleEnabled` but re-stamps the
 * illness-specific `errorCode` so the iOS classifier branches cleanly.
 */
export async function requireIllnessEnabled(
  userId: string,
): Promise<IllnessGateResult> {
  const gate = await requireModuleEnabled(userId, "illness");
  if (gate.enabled) return { enabled: true };
  return {
    enabled: false,
    response: apiError("Illness journal is not enabled", 403, {
      errorCode: ILLNESS_DISABLED_ERROR_CODE,
      module: "illness",
    }),
  };
}
