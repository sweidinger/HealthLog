/**
 * Cycle-tracking feature gate.
 *
 * Two gates collapse into one resolved boolean (ios-contract §1):
 *   (a) the per-user `CycleProfile.cycleTrackingEnabled` toggle, and
 *   (b) a gender-derived default when that toggle is NULL.
 *
 * `isCycleEnabled` is the single source of truth. The server gender enum
 * ships UPPERCASE (`"MALE" | "FEMALE" | null`); the gate keys on
 * `"FEMALE"`. A NULL toggle derives `gender === "FEMALE"`; an explicit
 * `true`/`false` overrides the derivation (so a non-FEMALE account can
 * opt in and a FEMALE account can opt out).
 *
 * NOTE: the gender enum normalisation (adding `OTHER` / lowercasing) is a
 * separate, iOS-blocked decision (migration 0131, reserved). Until that
 * lands, `OTHER` / non-binary accounts gate purely on the explicit
 * `cycleTrackingEnabled = true` opt-in via the Settings toggle.
 */
import { apiError } from "@/lib/api-response";
import { getOrCreateCycleProfile } from "@/lib/cycle/profile";
import type { CycleProfile } from "@/generated/prisma/client";

/** Wire `errorCode` the iOS retry classifier branches on. */
export const CYCLE_DISABLED_ERROR_CODE = "cycle.disabled";

/**
 * Resolve whether cycle tracking is enabled for an account.
 *
 * @param gender the user's `gender` column (`"MALE" | "FEMALE" | null`).
 * @param profile the user's `CycleProfile`, or just its
 *   `cycleTrackingEnabled` field (NULL ⇒ derive from gender).
 */
export function isCycleEnabled(
  gender: string | null | undefined,
  profile: { cycleTrackingEnabled: boolean | null } | null | undefined,
): boolean {
  const toggle = profile?.cycleTrackingEnabled;
  if (toggle === true) return true;
  if (toggle === false) return false;
  // NULL toggle → derive from gender.
  return gender === "FEMALE";
}

/**
 * Route-guard outcome: either the resolved profile (enabled) or a ready
 * 403 envelope (disabled) to return verbatim.
 */
export type CycleGateResult =
  | { enabled: true; profile: CycleProfile }
  | { enabled: false; response: Response };

/**
 * Enforce the gate for a `/api/cycle/*` route. Lazily upserts the
 * `CycleProfile` (so the toggle row exists), resolves `isCycleEnabled`,
 * and returns a 403 `cycle.disabled` envelope when the account may not
 * write/read cycle data — even with a valid Bearer token.
 */
export async function requireCycleEnabled(
  userId: string,
  gender: string | null | undefined,
): Promise<CycleGateResult> {
  const profile = await getOrCreateCycleProfile(userId);
  if (!isCycleEnabled(gender, profile)) {
    return {
      enabled: false,
      response: apiError("Cycle tracking is not enabled", 403, {
        errorCode: CYCLE_DISABLED_ERROR_CODE,
      }),
    };
  }
  return { enabled: true, profile };
}
