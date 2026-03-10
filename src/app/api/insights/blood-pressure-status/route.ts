import { NextRequest } from "next/server";
import { apiSuccess } from "@/lib/api-response";
import {
  generateBloodPressureStatusForUser,
  resolveBloodPressureStatusLocale,
} from "@/lib/insights/blood-pressure-status";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const localeParam = request.nextUrl.searchParams.get("locale");
  const locale = resolveBloodPressureStatusLocale(
    localeParam ?? user.locale ?? "de",
  );

  const result = await generateBloodPressureStatusForUser(
    user.id,
    {
      locale,
      force: false,
    },
  );

  annotate({ action: { name: "insights.blood-pressure-status" } });

  return apiSuccess(result);
});
