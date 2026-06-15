/**
 * OpenAPI route table for the structured lab-result store (`/api/labs`).
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`. The request
 * bodies + query reuse the runtime Zod schemas from `@/lib/validations/labs`
 * so the wire contract stays single-source. Response shapes are declared
 * here (the route serialises a derived `rangeStatus` + `hasNote` the input
 * schema doesn't carry).
 */
import type { ZodOpenApiObject } from "zod-openapi";
import { z } from "zod/v4";

import {
  createLabResultSchema,
  listLabResultsSchema,
  updateLabResultSchema,
} from "@/lib/validations/labs";

import { dataEnvelope, errorEnvelope, stdResponses } from "./shared";

createLabResultSchema.meta({
  id: "CreateLabResultRequest",
  description:
    "Record a single biomarker reading (HbA1c, LDL, ferritin, TSH, …). `analyte` + `unit` are free-form (a lab prints its own naming). Reference bounds are independently optional; when both are present `referenceLow` must not exceed `referenceHigh`. `takenAt` is a backdatable ISO instant (no future, ≤ 50 years past). The optional `note` is encrypted at rest.",
});

updateLabResultSchema.meta({
  id: "UpdateLabResultRequest",
  description:
    "Partial edit of a lab result. An omitted key leaves the column untouched; an explicit `null` on `panel` / `note` / a reference bound clears it.",
});

listLabResultsSchema.meta({
  id: "ListLabResultsQuery",
  description:
    "Query params for the lab-result list: optional `analyte` (exact) + `panel` filters, an inclusive `from`/`to` date range, and `limit` (≤ 500) / `offset` pagination. Defaults to `takenAt` DESC.",
});

const rangeStatusEnum = z
  .enum(["in-range", "below", "above", "unknown"])
  .meta({
    id: "LabReferenceRangeStatus",
    description:
      "Server-computed, NEUTRAL reference-range verdict. `unknown` when the lab reported no usable bounds. Inclusive bounds: a value on the limit reads in-range. The badge that renders this must stay calm and informative — not an alarming red.",
  });

const labResultRow = z
  .object({
    id: z.string(),
    panel: z.string().nullable(),
    analyte: z.string(),
    value: z.number(),
    unit: z.string(),
    referenceLow: z.number().nullable(),
    referenceHigh: z.number().nullable(),
    takenAt: z.string(),
    source: z.string(),
    hasNote: z.boolean(),
    rangeStatus: rangeStatusEnum,
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({
    id: "LabResult",
    description:
      "A stored lab result. The encrypted note is never echoed in list rows; `hasNote` flags its presence and the single-resource GET returns the decrypted `note`.",
  });

const labResultDetail = labResultRow
  .omit({ hasNote: true })
  .extend({ note: z.string().nullable() })
  .meta({
    id: "LabResultDetail",
    description:
      "Single lab result including its decrypted free-text `note` (or null).",
  });

const listResponse = z
  .object({
    results: z.array(labResultRow),
    meta: z.object({
      total: z.number(),
      limit: z.number(),
      offset: z.number(),
    }),
  })
  .meta({ id: "ListLabResultsResponse" });

const notFound = {
  "404": {
    description: "Lab result not found (or owned by another user).",
    content: { "application/json": { schema: errorEnvelope } },
  },
};

export const labsPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/labs": {
    get: {
      tags: ["Labs"],
      summary: "List the caller's lab results",
      description:
        "Returns the caller's live (non-deleted) lab results, newest first, with optional analyte / panel / date-range filters. Each row carries a server-computed neutral `rangeStatus` and a `hasNote` flag (the encrypted note itself is not echoed).",
      requestParams: { query: listLabResultsSchema },
      responses: {
        "200": {
          description: "Lab-result list.",
          content: {
            "application/json": {
              schema: dataEnvelope(listResponse, "ListLabResultsEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
    post: {
      tags: ["Labs"],
      summary: "Record a lab result",
      description:
        "Creates a single lab result for the caller. `source` is hardcoded MANUAL on this path. The optional note is AES-256-GCM encrypted before write. Audits as `labResult.create`.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: createLabResultSchema } },
      },
      responses: {
        "201": {
          description: "Created lab result.",
          content: {
            "application/json": {
              schema: dataEnvelope(labResultRow, "CreateLabResultResponse"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/labs/{id}": {
    get: {
      tags: ["Labs"],
      summary: "Fetch a single lab result",
      description:
        "Returns the lab result including its decrypted `note`. Cross-user rows surface as 404.",
      requestParams: { path: z.object({ id: z.string() }) },
      responses: {
        "200": {
          description: "Lab-result detail.",
          content: {
            "application/json": {
              schema: dataEnvelope(labResultDetail, "GetLabResultResponse"),
            },
          },
        },
        ...notFound,
        ...stdResponses,
      },
    },
    put: {
      tags: ["Labs"],
      summary: "Edit a lab result",
      description:
        "Partial edit; omitted fields are untouched, an explicit null clears `panel` / `note` / a reference bound. Audits as `labResult.update`.",
      requestParams: { path: z.object({ id: z.string() }) },
      requestBody: {
        required: true,
        content: { "application/json": { schema: updateLabResultSchema } },
      },
      responses: {
        "200": {
          description: "Updated lab result.",
          content: {
            "application/json": {
              schema: dataEnvelope(labResultRow, "UpdateLabResultResponse"),
            },
          },
        },
        ...notFound,
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Labs"],
      summary: "Delete a lab result",
      description:
        "Soft-deletes the lab result (stamps `deletedAt`). Idempotent. Audits as `labResult.delete`.",
      requestParams: { path: z.object({ id: z.string() }) },
      responses: {
        "200": {
          description: "Deletion succeeded.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ deleted: z.boolean() }),
                "DeleteLabResultResponse",
              ),
            },
          },
        },
        ...notFound,
        ...stdResponses,
      },
    },
  },
};
