/**
 * GET /api/fhir/MedicationStatement — FHIR R4 `searchset` of the caller's own
 * active-medication statements (one per active medication, with additive
 * ATC/RxNorm codings).
 *
 * Read-only. `userId` narrowed from `requireAuth`; shared emitter is the
 * single source of the drug coding. Offset paging via `_count` (≤200) /
 * `_offset`.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit } from "@/lib/rate-limit";
import { medicationStatementsFromReportData } from "@/lib/fhir/resources";
import {
  FHIR_READ_SCOPE,
  loadFhirContext,
  operationOutcome,
  parsePaging,
  searchsetResponse,
} from "@/lib/fhir/rest";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth(FHIR_READ_SCOPE);
  annotate({ action: { name: "fhir.medicationstatement.search" } });

  // v1.30 — the FHIR REST face serves the SAME whole-record aggregate as
  // `/api/export/health-record` (the doctor-report builder), right down to
  // the decrypted insurance number on the Patient resource. That export
  // gates on the `doctorReport` module; this surface did not, so the module
  // could be off and `/api/fhir/*` still handed out the full record.
  //
  // REFUSE, NOT OMIT — deliberately, and unlike the sync delta feed. This is
  // a whole-record export, not an incremental feed: there is no partial
  // answer that is still a truthful FHIR Bundle, and no background client
  // depends on it draining to stay consistent. Mirroring the sibling export's
  // 403 `module.disabled` envelope (rather than an OperationOutcome) keeps
  // the errorCode the clients already branch on for a disabled module.
  const gate = await requireModuleEnabled(user.id, "doctorReport");
  if (!gate.enabled) return gate.response;

  const rl = await checkRateLimit(`fhir:${user.id}`, 120, 60 * 60 * 1000);
  if (!rl.allowed) {
    return operationOutcome(429, "throttled", "Rate limit exceeded");
  }

  const { count, offset } = parsePaging(request.nextUrl.searchParams);
  const { data, germanAtc } = await loadFhirContext(user.id);

  const all = medicationStatementsFromReportData(data, { germanAtc });
  const page = all.slice(offset, offset + count);
  annotate({ meta: { total: all.length, count, offset } });
  return searchsetResponse(request.nextUrl, page, all.length, count, offset);
});
