/**
 * GET /api/fhir/$everything — FHIR R4 `$everything` operation.
 *
 * Returns every resource in the caller's own record — Patient, Coverage,
 * Observations, MedicationStatements, MedicationAdministrations — in one
 * `searchset` Bundle, in the canonical document order. Read-only; `userId`
 * narrowed from `requireAuth`. Offset paging applies across the flattened
 * resource list via `_count` (clamped ≤200) / `_offset`.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  coverageResource,
  medicationAdministrationsFromReportData,
  medicationStatementsFromReportData,
  observationsFromReportData,
  patientResource,
} from "@/lib/fhir/resources";
import type { FhirResource } from "@/lib/fhir/types";
import {
  FHIR_READ_SCOPE,
  loadFhirContext,
  operationOutcome,
  parsePaging,
  searchsetResponse,
} from "@/lib/fhir/rest";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth(FHIR_READ_SCOPE);
  annotate({ action: { name: "fhir.everything.read" } });

  const rl = await checkRateLimit(`fhir:${user.id}`, 120, 60 * 60 * 1000);
  if (!rl.allowed) {
    return operationOutcome(429, "throttled", "Rate limit exceeded");
  }

  const { count, offset } = parsePaging(request.nextUrl.searchParams);
  const { data, identity, germanAtc } = await loadFhirContext(user.id);

  const all: FhirResource[] = [patientResource(data, identity)];
  const coverage = coverageResource(data, identity);
  if (coverage) all.push(coverage);
  all.push(...observationsFromReportData(data, identity, { germanAtc }));
  all.push(...medicationStatementsFromReportData(data, { germanAtc }));
  all.push(...medicationAdministrationsFromReportData(data, { germanAtc }));

  const page = all.slice(offset, offset + count);
  annotate({ meta: { total: all.length, count, offset } });
  return searchsetResponse(request.nextUrl, page, all.length, count, offset);
});
