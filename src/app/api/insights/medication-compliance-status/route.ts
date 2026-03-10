import { NextRequest } from "next/server";
import { apiSuccess } from "@/lib/api-response";
import {
  generateMedicationComplianceStatusForUser,
  resolveMedicationComplianceStatusLocale,
} from "@/lib/insights/medication-compliance-status";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const localeParam = request.nextUrl.searchParams.get("locale");
  const locale = resolveMedicationComplianceStatusLocale(
    localeParam ?? user.locale ?? "de",
  );

  const result = await generateMedicationComplianceStatusForUser(
    user.id,
    {
      locale,
      force: false,
    },
  );

  annotate({ action: { name: "insights.medication-compliance-status" } });

  return apiSuccess(result);
});
