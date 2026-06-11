/**
 * OpenAPI route table — health-record export, clinician share links, FHIR R4 read surface.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 * Schemas come from `src/lib/validations/*` where shared with the
 * runtime request parsing, so the wire contract stays single-source.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";
import { exportSelectionSchema } from "@/lib/validations/health-record-export";
import { createShareLinkSchema } from "@/lib/validations/clinician-share-link";
import { dataEnvelope, errorEnvelope, stdResponses } from "./shared";

// v1.11.0 — clinician share-link owner-facing summary (never the raw token).
const shareLinkSummary = z.object({
  id: z.string(),
  label: z.string(),
  rangeStart: z.string(),
  rangeEnd: z.string().nullable(),
  resourceTypes: z.array(z.string()),
  allowFhirApi: z.boolean(),
  expiresAt: z.string(),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
  lastAccessAt: z.string().nullable(),
  accessCount: z.number(),
  active: z.boolean(),
});

const shareLinkCreatedResponse = shareLinkSummary.extend({
  token: z
    .string()
    .describe("Raw `hls_` token — returned ONCE and unrecoverable thereafter."),
});

const shareLinkListResponse = z.object({
  shareLinks: z.array(shareLinkSummary),
});

const shareLinkRevokedResponse = z.object({
  id: z.string(),
  revoked: z.boolean(),
});

export const healthRecordPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/export/health-record": {
    post: {
      tags: ["Export"],
      summary: "Generate a health-record export (PDF / FHIR / package)",
      description:
        "v1.7.0 flagship export. Returns the doctor-handover artefact in the requested `format`: `pdf` → application/pdf, `fhir` → application/fhir+json (HL7 FHIR R4 document Bundle), `package` → application/zip (PDF + FHIR + README). Auth via cookie or Bearer; shared `export:<userId>` rate bucket (10/h). Strict validation: unknown keys 422.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: exportSelectionSchema },
        },
      },
      responses: {
        "200": {
          description:
            "Export generated. Content-Type varies by `format`: application/pdf, application/fhir+json, or application/zip.",
          content: {
            "application/pdf": {
              schema: z.string().meta({ format: "binary" }),
            },
            "application/fhir+json": {
              schema: z.string().meta({ format: "binary" }),
            },
            "application/zip": {
              schema: z.string().meta({ format: "binary" }),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/share-links": {
    post: {
      tags: ["Export"],
      summary: "Create a clinician share link (v1.11.0)",
      description:
        "Owner-only. Mints an `hls_` token (192-bit), stores only its HMAC hash, and returns the raw token EXACTLY ONCE in the response. Every scope column (window, sections, FHIR resource types, API toggle) is frozen write-once. `expiresAt` is required and capped at 90 days. Auth via cookie or Bearer; rate-limited (`share-link:<userId>`, 20/h). Strict: unknown keys 422.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: createShareLinkSchema },
        },
      },
      responses: {
        "201": {
          description:
            "Share link created. `token` carries the raw `hls_` value and is unrecoverable after this response.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                shareLinkCreatedResponse,
                "ShareLinkCreated",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    get: {
      tags: ["Export"],
      summary: "List own clinician share links (v1.11.0)",
      description:
        "Owner-only. Returns the caller's own share links (never the raw token — it is unrecoverable after creation). Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "Share links owned by the caller.",
          content: {
            "application/json": {
              schema: dataEnvelope(shareLinkListResponse, "ShareLinkList"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/share-links/{id}": {
    delete: {
      tags: ["Export"],
      summary: "Revoke a clinician share link (v1.11.0)",
      description:
        "Owner-only. Sets `revokedAt` on the caller's own link. A cross-user or unknown id is sealed as 404. Auth via cookie or Bearer; rate-limited.",
      requestParams: { path: z.object({ id: z.string() }) },
      responses: {
        "200": {
          description: "Link revoked.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                shareLinkRevokedResponse,
                "ShareLinkRevoked",
              ),
            },
          },
        },
        "404": {
          description: "Link not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/fhir/metadata": {
    get: {
      tags: ["FHIR"],
      summary: "FHIR R4 CapabilityStatement (v1.11.0)",
      description:
        "Read-only FHIR R4 capability statement for the REST face. Declares the served resource types (Patient, Observation, MedicationStatement, MedicationAdministration), the `$everything` operation, and the `application/fhir+json` format. Auth: `fhir:read` scope (cookie sessions also pass).",
      responses: {
        "200": {
          description: "CapabilityStatement (application/fhir+json).",
          content: {
            "application/fhir+json": {
              schema: z.string().meta({ format: "binary" }),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/fhir/Patient": {
    get: {
      tags: ["FHIR"],
      summary: "FHIR R4 Patient search (v1.11.0)",
      description:
        "Read-only `searchset` Bundle of the caller's own Patient resource. Auth: `fhir:read` scope. Offset paging via `_count` (clamped ≤200) / `_offset`. `userId` is narrowed from auth.",
      requestParams: {
        query: z.object({
          _count: z.coerce.number().optional(),
          _offset: z.coerce.number().optional(),
        }),
      },
      responses: {
        "200": {
          description: "searchset Bundle (application/fhir+json).",
          content: {
            "application/fhir+json": {
              schema: z.string().meta({ format: "binary" }),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/fhir/Observation": {
    get: {
      tags: ["FHIR"],
      summary: "FHIR R4 Observation search (v1.11.0)",
      description:
        "Read-only `searchset` Bundle of the caller's own Observations (vitals / activity / lab / survey). Auth: `fhir:read` scope. Offset paging via `_count` (clamped ≤200) / `_offset`.",
      requestParams: {
        query: z.object({
          _count: z.coerce.number().optional(),
          _offset: z.coerce.number().optional(),
        }),
      },
      responses: {
        "200": {
          description: "searchset Bundle (application/fhir+json).",
          content: {
            "application/fhir+json": {
              schema: z.string().meta({ format: "binary" }),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/fhir/MedicationStatement": {
    get: {
      tags: ["FHIR"],
      summary: "FHIR R4 MedicationStatement search (v1.11.0)",
      description:
        "Read-only `searchset` Bundle of the caller's own active-medication statements. Auth: `fhir:read` scope. Offset paging via `_count` (≤200) / `_offset`.",
      requestParams: {
        query: z.object({
          _count: z.coerce.number().optional(),
          _offset: z.coerce.number().optional(),
        }),
      },
      responses: {
        "200": {
          description: "searchset Bundle (application/fhir+json).",
          content: {
            "application/fhir+json": {
              schema: z.string().meta({ format: "binary" }),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/fhir/MedicationAdministration": {
    get: {
      tags: ["FHIR"],
      summary: "FHIR R4 MedicationAdministration search (v1.11.0)",
      description:
        "Read-only `searchset` Bundle of the caller's own acted intakes (completed / not-done). Auth: `fhir:read` scope. Offset paging via `_count` (≤200) / `_offset`.",
      requestParams: {
        query: z.object({
          _count: z.coerce.number().optional(),
          _offset: z.coerce.number().optional(),
        }),
      },
      responses: {
        "200": {
          description: "searchset Bundle (application/fhir+json).",
          content: {
            "application/fhir+json": {
              schema: z.string().meta({ format: "binary" }),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/fhir/$everything": {
    get: {
      tags: ["FHIR"],
      summary: "FHIR R4 $everything (v1.11.0)",
      description:
        "Read-only `$everything` operation: every resource in the caller's own record (Patient, Coverage, Observations, MedicationStatements, MedicationAdministrations) in one `searchset` Bundle. Auth: `fhir:read` scope. Offset paging via `_count` (≤200) / `_offset`.",
      requestParams: {
        query: z.object({
          _count: z.coerce.number().optional(),
          _offset: z.coerce.number().optional(),
        }),
      },
      responses: {
        "200": {
          description: "searchset Bundle (application/fhir+json).",
          content: {
            "application/fhir+json": {
              schema: z.string().meta({ format: "binary" }),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
};
