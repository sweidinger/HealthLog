/**
 * GET /api/fhir/Observation — FHIR R4 `searchset` of the caller's own
 * Observations (vitals / activity / lab / survey), one latest reading per
 * type plus the BP panel, BMI, glucose, adherence, mood and wellness scores.
 *
 * Read-only. `userId` is narrowed from `requireAuth`; the shared emitter is
 * the single source of the LOINC/UCUM coding. Offset paging via `_count`
 * (clamped ≤200) / `_offset`.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit } from "@/lib/rate-limit";
import { observationsFromReportData } from "@/lib/fhir/resources";
import {
  FHIR_READ_SCOPE,
  loadFhirContext,
  operationOutcome,
  parsePaging,
  searchsetResponse,
} from "@/lib/fhir/rest";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth(FHIR_READ_SCOPE);
  annotate({ action: { name: "fhir.observation.search" } });

  const rl = await checkRateLimit(`fhir:${user.id}`, 120, 60 * 60 * 1000);
  if (!rl.allowed) {
    return operationOutcome(429, "throttled", "Rate limit exceeded");
  }

  const { count, offset } = parsePaging(request.nextUrl.searchParams);
  const { data, identity, germanAtc } = await loadFhirContext(user.id);

  const all = observationsFromReportData(data, identity, { germanAtc });
  const page = all.slice(offset, offset + count);
  annotate({ meta: { total: all.length, count, offset } });
  return searchsetResponse(request.nextUrl, page, all.length, count, offset);
});
