import { NextRequest } from "next/server";
import { apiSuccess } from "@/lib/api-response";
import {
  generateBmiStatusForUser,
  resolveBmiStatusLocale,
} from "@/lib/insights/bmi-status";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const localeParam = request.nextUrl.searchParams.get("locale");
  const locale = resolveBmiStatusLocale(
    localeParam ?? user.locale ?? "de",
  );

  const result = await generateBmiStatusForUser(user.id, {
    locale,
    force: false,
  });

  annotate({ action: { name: "insights.bmi-status" } });

  return apiSuccess(result);
});
