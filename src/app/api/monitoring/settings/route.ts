import { apiHandler } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess } from "@/lib/api-response";
import { getPublicMonitoringSettings } from "@/lib/monitoring-settings";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  annotate({ action: { name: "monitoring.settings.get" } });

  const settings = await getPublicMonitoringSettings();
  return apiSuccess({
    umamiEnabled: settings.umamiEnabled,
    umamiWebsiteId: settings.umamiWebsiteId,
    glitchtipEnabled: settings.glitchtipEnabled,
  });
});
