import { prisma } from "@/lib/db";
import { apiSuccess } from "@/lib/api-response";
import { apiHandler } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  try {
    const settings = await prisma.appSettings.findUnique({
      where: { id: "singleton" },
    });

    annotate({ action: { name: "auth.registration-status" } });

    return apiSuccess({
      registrationEnabled: settings?.registrationEnabled ?? true,
    });
  } catch {
    // Fail closed on backend errors.
    annotate({ action: { name: "auth.registration-status" } });
    return apiSuccess({ registrationEnabled: false });
  }
});
