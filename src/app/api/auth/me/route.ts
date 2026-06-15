import { apiSuccess } from "@/lib/api-response";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { setOnboardingPendingCookie } from "@/lib/auth/session";
import { buildAvatarUrl } from "@/lib/avatar";
import { decrypt } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { isCycleEnabled } from "@/lib/cycle/gate";
import { resolveModuleMap } from "@/lib/modules/gate";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();

  annotate({ action: { name: "auth.me" } });

  // Two independent awaits, overlapped: the onboarding-cookie resync
  // (v1.4.22 W5 Sr-H1 — fall-back for legacy sessions that predate the
  // cookie; new sessions anchor it inside `createSession`) touches only
  // the cookie store, while the cycle-profile read (v1.15.0 — resolved
  // cycle-tracking gate; no row is forced, a NULL toggle derives from
  // gender) is a Postgres round-trip. Running them sequentially added
  // the cookie hop to every /me — and /me sits on every app boot path.
  const [, cycleProfile, modules] = await Promise.all([
    setOnboardingPendingCookie(user.onboardingCompletedAt == null),
    prisma.cycleProfile.findUnique({
      where: { userId: user.id },
      select: { cycleTrackingEnabled: true },
    }),
    // v1.18.0 — resolved module enable/disable map for every toggleable
    // module. cycle/coach reflect their real delegated state (the cycle
    // gate / disableCoach + operator assistant flag); the rest read the
    // disabled-allowlist `modulePreferencesJson`. Default-on. Clients
    // hide a whole module surface end-to-end when its key is `false`.
    resolveModuleMap(user.id),
  ]);
  const cycleTrackingEnabled = isCycleEnabled(user.gender, cycleProfile);

  // v1.7.0 — patient-identity fields for the health-record export. The
  // KVNR is stored encrypted; decrypt fail-soft so a key-rotation gap on
  // one row never 500s the whole profile fetch (the field just reads
  // null and the user re-enters it).
  let insuranceNumber: string | null = null;
  if (user.insuranceNumberEncrypted) {
    try {
      insuranceNumber = decrypt(user.insuranceNumberEncrypted);
    } catch {
      insuranceNumber = null;
    }
  }

  return apiSuccess({
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role ?? "USER",
    heightCm: user.heightCm,
    dateOfBirth: user.dateOfBirth,
    gender: user.gender,
    timezone: user.timezone,
    onboardingCompletedAt: user.onboardingCompletedAt,
    onboardingTourCompleted: user.onboardingTourCompleted,
    // v1.5.5 — self-hosted avatar. Replaces the Gravatar leak; the
    // URL is relative so PWA + native clients render identically
    // and the `?v={updatedAtMs}` suffix busts the browser cache on
    // a re-upload. Null when the user has not uploaded an avatar
    // yet; clients paint the username-initials fallback.
    avatarUrl: user.avatarUpdatedAt
      ? buildAvatarUrl(user.id, user.avatarUpdatedAt)
      : null,
    glucoseUnit: user.glucoseUnit ?? null,
    // v1.7.0 — global metric/imperial display preference. Canonical
    // storage stays SI; this only drives the display-time transform
    // branch. Null defaults to "metric" on the client.
    unitPreference: user.unitPreference === "imperial" ? "imperial" : "metric",
    // Hour-cycle display preference (AUTO follows the locale convention,
    // H12 / H24 pin the cycle). Clients mirror this into their formatters.
    timeFormat: user.timeFormat ?? "AUTO",
    lastReportPracticeName: user.lastReportPracticeName ?? null,
    // v1.4.47 W3 — per-user Coach opt-out. Default `false` if the
    // column is absent (partial-deploy rollback safety, see migration
    // 0078 commentary). Every Coach mount point on the client checks
    // `user.disableCoach` BELOW the operator-level `flags.coach`
    // short-circuit; both gates must agree to paint the affordance.
    disableCoach: user.disableCoach ?? false,
    // v1.7.0 — health-record export identity fields. All optional.
    fullName: user.fullName ?? null,
    insurerName: user.insurerName ?? null,
    insurerIkNumber: user.insurerIkNumber ?? null,
    insuranceNumber,
    // v1.15.0 — cycle-tracking feature gate, resolved server-side. iOS
    // hides the whole cycle tab when this is false.
    cycleTrackingEnabled,
    // v1.18.0 — module enable/disable map. `{ <moduleKey>: boolean }`
    // for every toggleable module; `false` means the module is OFF and
    // the surface should disappear end-to-end (nav, dashboard, insights,
    // …). `cycle` mirrors `cycleTrackingEnabled` and `coach` mirrors the
    // resolved `disableCoach` + operator master flag, so this map is the
    // single thing a client needs to gate every secondary domain.
    modules,
  });
});
