/**
 * GET /api/fhir/MedicationAdministration — FHIR R4 `searchset` of the caller's
 * own acted intakes (`completed` taken / `not-done` skip), with the same
 * ATC/RxNorm + dose/route/site coding the document export carries.
 *
 * Read-only. `userId` narrowed from `requireAuth`; shared emitter is the
 * single source of the coding. Offset paging via `_count` (≤200) / `_offset`.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit } from "@/lib/rate-limit";
import { medicationAdministrationsFromReportData } from "@/lib/fhir/resources";
import {
  FHIR_READ_SCOPE,
  loadFhirContext,
  operationOutcome,
  parsePaging,
  searchsetResponse,
} from "@/lib/fhir/rest";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth(FHIR_READ_SCOPE);
  annotate({ action: { name: "fhir.medicationadministration.search" } });

  const rl = await checkRateLimit(`fhir:${user.id}`, 120, 60 * 60 * 1000);
  if (!rl.allowed) {
    return operationOutcome(429, "throttled", "Rate limit exceeded");
  }

  const { count, offset } = parsePaging(request.nextUrl.searchParams);
  const { data, germanAtc } = await loadFhirContext(user.id);

  const all = medicationAdministrationsFromReportData(data, { germanAtc });
  const page = all.slice(offset, offset + count);
  annotate({ meta: { total: all.length, count, offset } });
  return searchsetResponse(request.nextUrl, page, all.length, count, offset);
});
