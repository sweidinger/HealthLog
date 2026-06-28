/**
 * OpenAPI route table for inbound clinical documents (`/api/documents/inbound/*`).
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`. The confirm +
 * edit request bodies reuse the runtime schemas from
 * `@/lib/validations/inbound-documents` so the wire contract stays
 * single-source. The upload is a `multipart/form-data` binary body (or a JSON
 * text-mode body); the response shapes are declared here.
 *
 * Safety contract surfaced in the descriptions: extraction reproduces what the
 * document states (stated codes/status only) into a staging area — it never
 * interprets or diagnoses. Nothing reaches the structured stores until the
 * confirm route commits the user's approvals; a low-confidence fact fails
 * closed.
 */
import type { ZodOpenApiObject } from "zod-openapi";
import { z } from "zod/v4";

import {
  inboundConfirmSchema,
  inboundFactEditSchema,
} from "@/lib/validations/inbound-documents";

import { dataEnvelope, stdResponses } from "./shared";

inboundConfirmSchema.meta({
  id: "InboundConfirmRequest",
  description:
    "The approve/reject decisions a human made on the review screen. Each names a staged fact by id. Approved facts are committed to the structured stores (labs / conditions / medications) through their normal create paths; rejected facts are discarded. A fact still flagged `needsReview` (below the confidence floor, never edited) cannot be approved — it is reported back as `needsReview`. No `userId` field — it is narrowed from the session; every fact id is re-scoped to the document + caller.",
});

inboundFactEditSchema.meta({
  id: "InboundFactEditRequest",
  description:
    "A correction to a staged fact before approval (fixes OCR / units / dates / codes). Discriminated by `factType` so the edit cannot change the fact's resource type. A successful edit clears `needsReview` — the values become user-asserted.",
});

const factProvenance = z.object({
  sourceText: z.string(),
  page: z.number().nullable(),
  confidence: z.number(),
});

const extractedFact = z
  .object({
    id: z.string(),
    factType: z.enum(["CONDITION", "OBSERVATION", "MEDICATION_STATEMENT"]),
    status: z.enum(["PENDING", "APPROVED", "REJECTED"]),
    confidence: z.number(),
    needsReview: z.boolean(),
    data: z.record(z.string(), z.unknown()),
    provenance: factProvenance,
    committedRecordId: z.string().nullable(),
    committedRecordType: z.string().nullable(),
  })
  .meta({
    id: "ExtractedFact",
    description:
      "One STATED fact transcribed from the document, FHIR-staged (Condition / Observation / MedicationStatement) with per-field provenance + a confidence gate. STATED status only — codes (SNOMED/ICD-10/LOINC/RxNorm/ATC) are present only when the document wrote them; no range-flag, no inferred links. `needsReview` is true when the fact scored below the confidence floor (it cannot be approved until edited).",
  });

const inboundDocument = z
  .object({
    id: z.string(),
    kind: z.enum(["DOCTOR_REPORT", "DISCHARGE_LETTER", "OTHER"]),
    filename: z.string().nullable(),
    mimeType: z.string(),
    byteSize: z.number(),
    status: z.enum([
      "EXTRACTING",
      "EXTRACTED",
      "FAILED",
      "CONFIRMED",
      "DISCARDED",
    ]),
    providerType: z.string().nullable(),
    reportDate: z.string().nullable(),
    errorReason: z.string().nullable(),
    factCount: z.number(),
    pendingCount: z.number(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({
    id: "InboundDocument",
    description:
      "An uploaded clinical document. The raw bytes are stored encrypted at rest and never returned; this is the metadata + staging summary.",
  });

const inboundDocumentDetail = inboundDocument
  .extend({ facts: z.array(extractedFact) })
  .meta({ id: "InboundDocumentDetail" });

const listResponse = z
  .object({ documents: z.array(inboundDocument) })
  .meta({ id: "InboundDocumentList" });

const confirmResponse = z
  .object({
    approved: z.array(
      z.object({
        factId: z.string(),
        recordType: z.string(),
        recordId: z.string(),
      }),
    ),
    rejected: z.array(z.string()),
    needsReview: z.array(z.string()),
    failed: z.array(z.object({ factId: z.string(), reason: z.string() })),
  })
  .meta({
    id: "InboundConfirmResponse",
    description:
      "The outcome per decision: `approved` (committed, with the new record ref), `rejected` (discarded), `needsReview` (refused — edit first, fail-closed), `failed` (a per-fact commit miss, e.g. a numeric observation with no unit).",
  });

export const inboundDocumentPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/documents/inbound": {
    get: {
      tags: ["Documents"],
      summary: "List inbound clinical documents",
      description:
        "The caller's uploaded doctor reports / discharge letters (newest first, live only). Owner-scoped; gated on the opt-in `inboundDocuments` module.",
      responses: {
        "200": {
          description: "The document list.",
          content: {
            "application/json": {
              schema: dataEnvelope(listResponse, "InboundDocumentListEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
    post: {
      tags: ["Documents"],
      summary: "Upload + extract a clinical document",
      description:
        'Ingests a doctor report / discharge letter through the dedicated OCR/vision provider, stores the raw document ENCRYPTED at rest, and stages the extracted STRUCTURED FACTS for review. Two modes by content-type. VISION (`multipart/form-data`): a `file` (JPEG/PNG/WebP, or PDF on an Anthropic vision provider; ≤ 12 MiB) plus an optional `kind`. TEXT (`application/json`, opt-in local OCR): `{ mode: "text", text, kind? }` — only the extracted text reaches the server. Both modes are AI-consent / rate / budget gated. Extraction reproduces what the document states (stated codes/status only) — it never interprets. Nothing reaches the structured stores here; the confirm route is the only write path.',
      requestBody: {
        required: true,
        content: {
          "multipart/form-data": {
            schema: z.object({
              file: z.string().meta({
                format: "binary",
                description:
                  "The clinical-document image or PDF. Validated by magic-byte MIME sniff, not the wire Content-Type.",
              }),
              kind: z
                .enum(["DOCTOR_REPORT", "DISCHARGE_LETTER", "OTHER"])
                .optional()
                .meta({ description: "Optional document-type label." }),
            }),
          },
          "application/json": {
            schema: z
              .object({
                mode: z.literal("text"),
                text: z.string(),
                kind: z
                  .enum(["DOCTOR_REPORT", "DISCHARGE_LETTER", "OTHER"])
                  .optional(),
              })
              .meta({ id: "InboundTextUploadRequest" }),
          },
        },
      },
      responses: {
        "201": {
          description: "The created document + staging summary.",
          content: {
            "application/json": {
              schema: dataEnvelope(inboundDocument, "InboundDocumentEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/documents/inbound/{id}": {
    get: {
      tags: ["Documents"],
      summary: "Get a document + its staged facts",
      description:
        "The document plus every staged fact for the review screen. Owner-scoped.",
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "Document detail.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                inboundDocumentDetail,
                "InboundDocumentDetailEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Documents"],
      summary: "Discard an inbound document",
      description:
        "Soft-deletes the document + its staging. Facts already approved into the structured stores are independent rows and are NOT affected.",
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "Discarded.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ id: z.string(), discarded: z.boolean() }),
                "InboundDiscardEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/documents/inbound/{id}/facts/{factId}": {
    patch: {
      tags: ["Documents"],
      summary: "Edit a staged fact before approval",
      description:
        "Corrects OCR / units / dates / codes on a pending fact. Clears `needsReview` (the values become user-asserted). The fact's resource type cannot change.",
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
        {
          name: "factId",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      requestBody: {
        required: true,
        content: { "application/json": { schema: inboundFactEditSchema } },
      },
      responses: {
        "200": {
          description: "The updated fact.",
          content: {
            "application/json": {
              schema: dataEnvelope(extractedFact, "ExtractedFactEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/documents/inbound/{id}/confirm": {
    post: {
      tags: ["Documents"],
      summary: "Confirm the review decisions",
      description:
        "The ONLY write path out of staging. Commits the user's approvals into the structured stores (labs / conditions / medications) and discards rejections. A low-confidence fact that was never edited cannot be approved (fail-closed). Idempotent (Idempotency-Key). Audits as `documents.inbound.confirm`.",
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      requestBody: {
        required: true,
        content: { "application/json": { schema: inboundConfirmSchema } },
      },
      responses: {
        "200": {
          description: "Per-decision outcome.",
          content: {
            "application/json": {
              schema: dataEnvelope(confirmResponse, "InboundConfirmEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
};
