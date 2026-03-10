import { apiSuccess } from "@/lib/api-response";
import { getReminderThresholds } from "@/lib/app-settings";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  await requireAuth();

  const thresholds = await getReminderThresholds();

  annotate({ action: { name: "settings.reminder-thresholds.get" } });

  return apiSuccess(thresholds);
});
