/**
 * GET /api/fhir/Patient — FHIR R4 `searchset` of the caller's own Patient.
 *
 * Read-only. A FHIR `Patient` search always yields exactly the authenticated
 * user's single Patient resource (the `userId` is narrowed from `requireAuth`;
 * there is no cross-user search). Returned as a one-entry `searchset` Bundle
 * so a generic FHIR client can page it like any other resource type.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit } from "@/lib/rate-limit";
import { patientResource } from "@/lib/fhir/resources";
import {
  FHIR_READ_SCOPE,
  loadFhirContext,
  operationOutcome,
  parsePaging,
  searchsetResponse,
} from "@/lib/fhir/rest";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth(FHIR_READ_SCOPE);
  annotate({ action: { name: "fhir.patient.search" } });

  const rl = await checkRateLimit(`fhir:${user.id}`, 120, 60 * 60 * 1000);
  if (!rl.allowed) {
    return operationOutcome(429, "throttled", "Rate limit exceeded");
  }

  const { count, offset } = parsePaging(request.nextUrl.searchParams);
  const { data, identity } = await loadFhirContext(user.id);

  const all = [patientResource(data, identity)];
  const page = all.slice(offset, offset + count);
  annotate({ meta: { total: all.length, count, offset } });
  return searchsetResponse(request.nextUrl, page, all.length, count, offset);
});
