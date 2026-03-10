import { apiSuccess } from "@/lib/api-response";
import { getGlobalServiceAvailability } from "@/lib/app-settings";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  await requireAuth();

  const availability = await getGlobalServiceAvailability();

  annotate({ action: { name: "settings.global-services.get" } });

  return apiSuccess(availability);
});
