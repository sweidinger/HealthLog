import { apiSuccess } from "@/lib/api-response";
import { getGravatarUrl } from "@/lib/gravatar";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { setOnboardingPendingCookie } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();

  // v1.4.22 C4 — keep the proxy-readable onboarding cookie in sync
  // with the DB state on every /me roundtrip. Old sessions that
  // predate the cookie pick it up on first dashboard load; the
  // /onboarding/complete handler always wins on the cleared edge.
  await setOnboardingPendingCookie(user.onboardingCompletedAt == null);

  annotate({ action: { name: "auth.me" } });

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
    gravatarUrl: user.email ? getGravatarUrl(user.email) : null,
    glucoseUnit: user.glucoseUnit ?? null,
    lastReportPracticeName: user.lastReportPracticeName ?? null,
  });
});
