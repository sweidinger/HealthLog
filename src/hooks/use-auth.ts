"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { queryKeys } from "@/lib/query-keys";
import { apiGet, apiFetchRaw } from "@/lib/api/api-fetch";
import { retryOnceOnTransientError } from "@/lib/queries/retry-transient";
import { useTranslations } from "@/lib/i18n/context";
import type { TimeFormatPreference } from "@/lib/format-locale";
import { isTimeFormatPreference, storeTimeFormat } from "@/lib/time-format";
import type { ModuleKey } from "@/lib/modules/registry";

export interface AuthUser {
  id: string;
  username: string;
  email: string | null;
  role: string;
  heightCm: number | null;
  dateOfBirth: string | null;
  gender: string | null;
  timezone: string;
  onboardingCompletedAt: string | null;
  /**
   * v1.4.15 Phase B5: whether the user has finished or dismissed
   * the spotlight tour overlaid on the dashboard. Distinct from
   * `onboardingCompletedAt` (the wizard at /onboarding) — see the
   * `<TourLauncher>` component for the gating logic.
   */
  onboardingTourCompleted: boolean;
  /**
   * v1.5.5 — relative URL of the user's self-hosted avatar, served
   * from `/api/user/avatar/{id}?v={updatedAtMs}`. Replaces the
   * Gravatar leak; null when the user has not uploaded an avatar
   * yet (clients paint the username-initials fallback).
   */
  avatarUrl: string | null;
  glucoseUnit: string | null;
  /**
   * v1.7.0 — global metric/imperial display preference. Canonical
   * storage stays SI; this selects the display-time transform branch
   * (km/h vs mph, km vs mi). Null on a stale /me payload coerces to
   * "metric" in `fetchMe`.
   */
  unitPreference: "metric" | "imperial";
  /**
   * Hour-cycle display preference. AUTO follows the locale convention
   * (en → AM/PM, de → 24h); H12 / H24 pin the cycle regardless of locale.
   * Mirrored into localStorage by `fetchMe` so `useFormatters()` and the
   * legacy `src/lib/format.ts` helpers render the same clock. Coerced to
   * "AUTO" against a stale /me payload.
   */
  timeFormat: TimeFormatPreference;
  /**
   * v1.4.47 W3 — per-user Coach opt-out. When `true`, every Coach
   * mount point (`<LayoutCoachFab>`, `<LayoutCoachMount>`, the
   * inline `<CoachLaunchButton>` pill, the `/targets` page CTA)
   * renders nothing. The gate sits BELOW the operator-level
   * `flags.coach` short-circuit — both must agree to render the
   * affordance. Defaults to `false` when the field is absent (e.g.
   * stale /me payload from a partial-deploy rollback).
   */
  disableCoach: boolean;
  /**
   * v1.7.0 — optional patient-identity fields used by the health-record
   * export (PDF cover + FHIR Patient). All optional; `insuranceNumber`
   * is the German KVNR, decrypted server-side for the form prefill.
   */
  fullName: string | null;
  insurerName: string | null;
  /**
   * v1.8.6 — optional German insurer institution number (IKNR, 9 digits).
   * Surfaced on the FHIR `Coverage` resource's payor Organization.
   */
  insurerIkNumber: string | null;
  insuranceNumber: string | null;
  /**
   * v1.15.0 — cycle-tracking feature gate, resolved server-side from gender
   * + the per-user opt-in. The cycle nav entry + page hide when false; every
   * `/api/cycle/*` route also enforces the gate. Coerced to `false` against a
   * stale /me payload (older server image without the field) in `fetchMe`.
   */
  cycleTrackingEnabled: boolean;
  /**
   * v1.18.0 — the resolved per-user module enable/disable map. Each
   * toggleable module key (mood, sleep, glucose, workouts, recovery, labs,
   * achievements, coach, insights, doctorReport, cycle) is `true` when the
   * module is enabled for this account, `false` when disabled. `cycle` and
   * `coach` are delegated server-side (gender + opt-in / operator flag +
   * opt-out) and already reflected here, so nav + Insights pill gates read
   * this map rather than re-deriving. Coerced to `{}` against a stale /me
   * payload (older server image without the field) so every gate fails open
   * — a missing map never blanks the nav.
   */
  modules: Partial<Record<ModuleKey, boolean>>;
}

async function fetchMe(): Promise<AuthUser> {
  // v1.16.4 — routed through the typed wrapper; a non-OK /me (401)
  // throws `ApiError`, which `useAuth` treats as "not authenticated"
  // exactly like the old hand-rolled throw.
  //
  // v1.4.47 W3 — coerce `disableCoach` against `undefined` so a stale
  // /me payload from a partial-deploy rollback (older server image
  // without the field) keeps the Coach surface visible by default.
  const data = await apiGet<
    Partial<AuthUser> & {
      id: string;
      username: string;
      role: string;
      timezone: string;
    }
  >("/api/auth/me");
  // Hour-cycle preference: coerce against a stale /me payload, then mirror
  // into localStorage so `useFormatters()` and the legacy format helpers
  // (which cannot reach the query cache) render the same clock.
  const timeFormat: TimeFormatPreference = isTimeFormatPreference(
    data.timeFormat,
  )
    ? data.timeFormat
    : "AUTO";
  storeTimeFormat(timeFormat);
  return {
    ...(data as AuthUser),
    disableCoach: data.disableCoach ?? false,
    // v1.7.0 — coerce against a stale /me payload (older server image
    // without the field) so the display defaults to metric.
    unitPreference: data.unitPreference === "imperial" ? "imperial" : "metric",
    timeFormat,
    // v1.15.0 — coerce against a stale /me payload so the cycle nav entry
    // stays hidden by default when the field is absent.
    cycleTrackingEnabled: data.cycleTrackingEnabled === true,
    // v1.18.0 — coerce against a stale /me payload (older server image
    // without the module map) to an empty map so every module gate fails
    // open: a missing key reads as enabled and the nav stays intact.
    modules:
      data.modules && typeof data.modules === "object" ? data.modules : {},
  };
}

export function useAuth() {
  const query = useQuery({
    // v1.4.40 W-RSC — factory-routed to `queryKeys.authMe()`. Pre-fix
    // the literal `["auth", "me"]` was the canonical example in
    // audit-H1 of factory drift. The prefix `["auth"]` still matches
    // `queryKeys.auth()` invalidations.
    queryKey: queryKeys.authMe(),
    queryFn: fetchMe,
    // v1.16.8 — one retry on network errors / 5xx (never 401/403). A
    // single transient failure used to flip `isAuthenticated` false and
    // send the shell to the redirect spinner mid-session.
    retry: retryOnceOnTransientError,
    staleTime: 5 * 60 * 1000,
  });

  return {
    user: query.data ?? null,
    isLoading: query.isLoading,
    isAuthenticated: !!query.data,
    error: query.error,
    refetch: query.refetch,
  };
}

export function useLogout() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { t } = useTranslations();

  return useMutation({
    mutationFn: async () => {
      await apiFetchRaw("/api/auth/logout", { method: "POST" });
    },
    onSuccess: () => {
      queryClient.setQueryData(queryKeys.authMe(), null);
      queryClient.invalidateQueries({ queryKey: queryKeys.auth() });
      // Defense-in-depth at the session boundary: wipe the service-worker
      // page cache so no cached navigation HTML survives a logout on a
      // shared device. Scoped to `healthlog-pages-*` only — the static
      // cache (hashed chunks, icons) carries no PII and dropping it would
      // force a needless re-download on the next login. Best-effort; never
      // blocks the redirect.
      if (typeof caches !== "undefined") {
        void caches.keys().then((keys) => {
          for (const key of keys) {
            if (key.startsWith("healthlog-pages-")) void caches.delete(key);
          }
        });
      }
      router.push("/auth/login");
    },
    // v1.16.4 — a network-failed logout used to do nothing at all (the
    // menu closed, the session stayed); a toast names the failure.
    onError: () => toast.error(t("common.networkError")),
  });
}
