/**
 * v1.11.0 — shared helpers for the read-only FHIR R4 REST face.
 *
 * The `GET /api/fhir/*` search routes are thin: each resolves the caller's own
 * `DoctorReportData` (the SAME aggregator the PDF + document export consume),
 * runs the matching shared emitter from `./resources`, then wraps the result
 * in a `type: "searchset"` Bundle via the helpers here. Keeping the bundling,
 * paging, content-type and `OperationOutcome` shaping in one place means every
 * resource endpoint answers identically.
 *
 * Read-only: there are no write handlers anywhere under `/api/fhir`. Auth is a
 * narrow `fhir:read` Bearer scope (cookie sessions also pass); `userId` is
 * always narrowed from the auth context, never accepted from the wire.
 */
import { NextResponse } from "next/server";

import { decrypt } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import {
  collectDoctorReportData,
  normaliseDateRange,
  type DoctorReportData,
} from "@/lib/doctor-report-data";
import { GERMAN_ATC_DEFAULT_LOCALES } from "@/lib/fhir/resources";
import { isModuleEnabled } from "@/lib/modules/gate";
import type {
  FhirBundleEntry,
  FhirBundleLink,
  FhirOperationOutcome,
  FhirResource,
  FhirSearchsetBundle,
} from "@/lib/fhir/types";

/** The Bearer scope a narrow-scoped token must carry to read the FHIR face. */
export const FHIR_READ_SCOPE = "fhir:read";

/**
 * Canonical catalogue of FHIR R4 resource types the read-only REST face serves
 * (`read` + `search-type` interactions only — no write, ever). One source of
 * truth: the `metadata` CapabilityStatement, the `/api/meta/capabilities`
 * discovery surface, and the share-link resource-type enum all derive from
 * this so the advertised set can never drift from what is actually routed.
 */
export const FHIR_REST_RESOURCE_TYPES = [
  "Patient",
  "Observation",
  "MedicationStatement",
  "MedicationAdministration",
] as const;

/**
 * The whole-record operation the REST face exposes (`GET /api/fhir/$everything`),
 * returning the existing `type: "document"` Bundle. Surfaced in discovery so a
 * client knows the snapshot pull exists alongside the per-resource searches.
 */
export const FHIR_EVERYTHING_OPERATION = "$everything";

/** Search parameters honoured uniformly across the search routes. */
export const FHIR_SEARCH_PARAMS = ["_count", "_offset"] as const;

/** Canonical FHIR media type for every response (success or outcome). */
export const FHIR_CONTENT_TYPE = "application/fhir+json; charset=utf-8";

/** Default page size; clamped to `[1, MAX_COUNT]`. */
export const DEFAULT_COUNT = 50;
/** Hard ceiling on `_count` so a single search can never page the whole store. */
export const MAX_COUNT = 200;

/**
 * Parsed + clamped paging parameters. `count` is bounded to `[1, MAX_COUNT]`;
 * `offset` floors at 0. A non-numeric / negative input collapses to the
 * default rather than erroring — FHIR search is forgiving on paging params.
 */
export function parsePaging(searchParams: URLSearchParams): {
  count: number;
  offset: number;
} {
  const rawCount = Number(searchParams.get("_count"));
  const count =
    Number.isFinite(rawCount) && rawCount > 0
      ? Math.min(Math.floor(rawCount), MAX_COUNT)
      : DEFAULT_COUNT;
  const rawOffset = Number(searchParams.get("_offset"));
  const offset =
    Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
  return { count, offset };
}

/**
 * Build the absolute self link, and a next link when more rows remain. The
 * URL is rebuilt from the request URL with the paging params normalised, so
 * the echoed link always carries the clamped `_count` and concrete `_offset`.
 */
function pagingLinks(
  requestUrl: URL,
  total: number,
  count: number,
  offset: number,
): FhirBundleLink[] {
  const self = new URL(requestUrl.toString());
  self.searchParams.set("_count", String(count));
  self.searchParams.set("_offset", String(offset));
  const links: FhirBundleLink[] = [{ relation: "self", url: self.toString() }];

  const nextOffset = offset + count;
  if (nextOffset < total) {
    const next = new URL(requestUrl.toString());
    next.searchParams.set("_count", String(count));
    next.searchParams.set("_offset", String(nextOffset));
    links.push({ relation: "next", url: next.toString() });
  }
  return links;
}

/**
 * Wrap a page of resources in a `searchset` Bundle and return it as a FHIR
 * JSON response. `total` is the FULL unpaged match count; `page` is the
 * already-sliced window. Each entry is tagged `search.mode: "match"`.
 */
export function searchsetResponse(
  requestUrl: URL,
  page: FhirResource[],
  total: number,
  count: number,
  offset: number,
): NextResponse {
  const entry: FhirBundleEntry[] = page.map((resource) => ({
    fullUrl: `${requestUrl.origin}/api/fhir/${resource.resourceType}/${resource.id}`,
    resource,
    search: { mode: "match" },
  }));

  const bundle: FhirSearchsetBundle = {
    resourceType: "Bundle",
    type: "searchset",
    timestamp: new Date().toISOString(),
    total,
    link: pagingLinks(requestUrl, total, count, offset),
    entry,
  };

  return new NextResponse(JSON.stringify(bundle), {
    status: 200,
    headers: { "Content-Type": FHIR_CONTENT_TYPE, "Cache-Control": "no-store" },
  });
}

/** Return a raw FHIR resource (e.g. CapabilityStatement) as a FHIR response. */
export function fhirJsonResponse(body: unknown): NextResponse {
  return new NextResponse(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": FHIR_CONTENT_TYPE, "Cache-Control": "no-store" },
  });
}

/**
 * Build an `OperationOutcome` JSON response — the FHIR error envelope. Used
 * for 404 (no such resource) and any other FHIR-shaped error the routes
 * surface. (Auth 401/403 stay on the standard envelope via `requireAuth`.)
 */
export function operationOutcome(
  status: number,
  code: string,
  diagnostics: string,
  severity: FhirOperationOutcome["issue"][number]["severity"] = "error",
): NextResponse {
  const outcome: FhirOperationOutcome = {
    resourceType: "OperationOutcome",
    issue: [{ severity, code, diagnostics }],
  };
  return new NextResponse(JSON.stringify(outcome), {
    status,
    headers: { "Content-Type": FHIR_CONTENT_TYPE, "Cache-Control": "no-store" },
  });
}

/**
 * Resolve everything an emitter needs for a caller: the aggregated report data
 * over the default reporting window, plus the decrypted KVNR identity and the
 * BfArM-ATC flag (derived from the user's locale). Centralised so each
 * resource route is a one-liner over the shared emitters.
 *
 * The window matches the document export's default (`normaliseDateRange`
 * with no override). KVNR decryption is fail-soft: a key-rotation gap on a
 * single row omits the identifier rather than 500-ing the read.
 *
 * MODULE BACKSTOP. Every `/api/fhir/*` data route calls
 * `requireModuleEnabled(userId, "doctorReport")` itself, which is what
 * produces the clean 403 envelope. This assertion is the second layer: the
 * loader is the one door to the whole-record aggregate (including the
 * decrypted insurance number), so it refuses outright rather than trusting
 * that every present and future caller remembered the gate. It throws
 * instead of returning an envelope because reaching it means a caller is
 * missing its gate — a bug to surface, not a flow to serve.
 */
export async function loadFhirContext(userId: string): Promise<{
  data: DoctorReportData;
  identity: { insuranceNumber: string | null };
  germanAtc: boolean;
}> {
  if (!(await isModuleEnabled(userId, "doctorReport"))) {
    throw new Error(
      'loadFhirContext called with the "doctorReport" module disabled — ' +
        "the calling route is missing its requireModuleEnabled gate",
    );
  }

  const range = normaliseDateRange(undefined);
  const [data, userRow] = await Promise.all([
    collectDoctorReportData(userId, range, {}),
    prisma.user.findUnique({
      where: { id: userId },
      select: { insuranceNumberEncrypted: true, locale: true },
    }),
  ]);

  let insuranceNumber: string | null = null;
  if (userRow?.insuranceNumberEncrypted) {
    try {
      insuranceNumber = decrypt(userRow.insuranceNumberEncrypted);
    } catch {
      insuranceNumber = null;
    }
  }

  const germanAtc = (GERMAN_ATC_DEFAULT_LOCALES as readonly string[]).includes(
    userRow?.locale ?? "",
  );

  return { data, identity: { insuranceNumber }, germanAtc };
}
