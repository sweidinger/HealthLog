import { NextRequest } from "next/server";
import { apiSuccess } from "@/lib/api-response";
import {
  generateGeneralStatusForUser,
  resolveGeneralStatusLocale,
} from "@/lib/insights/general-status";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const localeParam = request.nextUrl.searchParams.get("locale");
  const locale = resolveGeneralStatusLocale(
    localeParam ?? user.locale ?? "de",
  );

  const result = await generateGeneralStatusForUser(user.id, {
    locale,
    force: false,
  });

  annotate({ action: { name: "insights.general-status" } });

  return apiSuccess(result);
});
