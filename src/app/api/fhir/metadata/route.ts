/**
 * GET /api/fhir/metadata — FHIR R4 `CapabilityStatement`.
 *
 * Declares the read-only REST face: the resource types served, the search
 * parameters honoured (`_count`, `_offset`), the `$everything` operation, and
 * the `application/fhir+json` format. Static — no per-user data — but still
 * gated behind the `fhir:read` scope so the whole `/api/fhir` tree answers
 * uniformly. Read-only: no write interactions are advertised.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { FHIR_READ_SCOPE, fhirJsonResponse } from "@/lib/fhir/rest";

const READ_RESOURCES = [
  "Patient",
  "Observation",
  "MedicationStatement",
  "MedicationAdministration",
] as const;

export const GET = apiHandler(async () => {
  await requireAuth(FHIR_READ_SCOPE);
  annotate({ action: { name: "fhir.metadata.read" } });

  const capability = {
    resourceType: "CapabilityStatement",
    status: "active",
    date: new Date().toISOString(),
    kind: "instance",
    fhirVersion: "4.0.1",
    format: ["application/fhir+json"],
    rest: [
      {
        mode: "server",
        documentation:
          "Read-only access to the authenticated user's own health record.",
        resource: [
          ...READ_RESOURCES.map((type) => ({
            type,
            interaction: [{ code: "read" }, { code: "search-type" }],
            searchParam: [
              { name: "_count", type: "number" },
              { name: "_offset", type: "number" },
            ],
          })),
          {
            type: "Patient",
            operation: [
              {
                name: "everything",
                definition:
                  "http://hl7.org/fhir/OperationDefinition/Patient-everything",
              },
            ],
          },
        ],
      },
    ],
  };

  return fhirJsonResponse(capability);
});
