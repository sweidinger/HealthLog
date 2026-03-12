import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { annotate, getEvent } from "@/lib/logging/context";
import { apiError, apiSuccess } from "@/lib/api-response";
import { getGlitchtipSettings } from "@/lib/monitoring-settings";
import { sendGlitchtipEvent } from "@/lib/monitoring/glitchtip";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async () => {
  await requireAdmin();
  annotate({ action: { name: "admin.monitoring.glitchtip-test" } });

  const settings = await getGlitchtipSettings();
  if (!settings.glitchtipEnabled) {
    return apiError("Glitchtip is disabled", 422);
  }
  if (!settings.glitchtipDsn) {
    return apiError("Glitchtip DSN is missing", 422);
  }

  const delivery = await sendGlitchtipEvent({
    dsn: settings.glitchtipDsn,
    input: {
      environment: settings.glitchtipEnvironment || "production",
      message: "HealthLog Monitoring Test",
      level: "error",
      type: "HealthLogMonitoringTest",
      sourceTag: "healthlog-admin-test",
    },
  });

  if (!delivery.ok) {
    getEvent()?.addWarning("Glitchtip test event rejected: " + delivery.method + " " + delivery.status + " " + delivery.details);
    return apiError(
      `Glitchtip test event rejected (HTTP ${delivery.status ?? 502})`,
      502,
    );
  }

  return apiSuccess({
    sent: true,
    message: "Glitchtip test event sent",
  });
});
