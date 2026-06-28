/**
 * `GET /api/environment` — the environmental-context module overview.
 *
 * Returns the account's coarse home location, its travel overrides, a small
 * summary of stored daily observations (count + latest day), and the upstream
 * attribution string. Module-gated: a 403 `module.disabled` envelope when the
 * opt-in module is off. `userId` is narrowed from auth, never a body field.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { prisma } from "@/lib/db";
import { OPEN_METEO_ATTRIBUTION } from "@/lib/environment/open-meteo";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();

  const gate = await requireModuleEnabled(user.id, "environment");
  if (!gate.enabled) return gate.response;

  const [profile, travel, contextCount, latest] = await Promise.all([
    prisma.user.findUnique({
      where: { id: user.id },
      select: {
        homeLat: true,
        homeLon: true,
        homeLabel: true,
        homeTimezone: true,
        timezone: true,
      },
    }),
    prisma.environmentTravelLocation.findMany({
      where: { userId: user.id },
      orderBy: { startDate: "desc" },
      select: {
        id: true,
        startDate: true,
        endDate: true,
        lat: true,
        lon: true,
        label: true,
      },
    }),
    prisma.environmentContext.count({ where: { userId: user.id } }),
    prisma.environmentContext.findFirst({
      where: { userId: user.id },
      orderBy: { date: "desc" },
      select: { date: true, fetchedAt: true },
    }),
  ]);

  const home =
    profile?.homeLat != null && profile?.homeLon != null
      ? {
          lat: profile.homeLat,
          lon: profile.homeLon,
          label: profile.homeLabel,
          timezone: profile.homeTimezone ?? profile.timezone,
        }
      : null;

  annotate({
    action: { name: "environment.overview.read" },
    meta: {
      has_home: home !== null,
      travel_count: travel.length,
      context_days: contextCount,
    },
  });

  return apiSuccess({
    home,
    travel,
    context: {
      days: contextCount,
      latestDate: latest?.date ?? null,
      latestFetchedAt: latest?.fetchedAt?.toISOString() ?? null,
    },
    attribution: OPEN_METEO_ATTRIBUTION,
  });
});
