/**
 * OpenAPI route table for the documents library (`/api/documents/inbound/*`).
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`. The confirm +
 * edit + list request bodies reuse the runtime schemas from
 * `@/lib/validations/inbound-documents` so the wire contract stays
 * single-source.
 *
 * The v1.25.x library inverts the original OCR-inbox: upload is STORE-ONLY and
 * provider-free (a file is always filable, encrypted at rest); AI extraction is
 * a separate, opt-in action on an already-stored document. Extraction
 * reproduces what the document states (stated codes/status only) into a staging
 * area — it never interprets or diagnoses. Nothing reaches the structured
 * stores until the confirm route commits the user's approvals; a low-confidence
 * fact fails closed.
 */
import type { ZodOpenApiObject } from "zod-openapi";
import { z } from "zod/v4";

import {
  documentUpdateSchema,
  inboundConfirmSchema,
  inboundFactEditSchema,
  INBOUND_DOCUMENT_KINDS,
  INBOUND_DOCUMENT_STATUSES,
} from "@/lib/validations/inbound-documents";

import { dataEnvelope, errorEnvelope, stdResponses } from "./shared";

const kindEnum = z.enum(INBOUND_DOCUMENT_KINDS);
const statusEnum = z.enum(INBOUND_DOCUMENT_STATUSES);

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

documentUpdateSchema.meta({
  id: "DocumentUpdateRequest",
  description:
    "Metadata edit for a stored document: `title` (user label; null clears it), `kind` (category), `documentDate` (user filing date, YYYY-MM-DD; null clears it). At least one field required. No `userId` field — narrowed from the session and fed to the Prisma `where` with the row id.",
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
    kind: kindEnum,
    title: z.string().nullable(),
    filename: z.string().nullable(),
    mimeType: z.string(),
    byteSize: z.number(),
    status: statusEnum,
    providerType: z.string().nullable(),
    reportDate: z.string().nullable(),
    documentDate: z.string().nullable(),
    errorReason: z.string().nullable(),
    factCount: z.number(),
    pendingCount: z.number(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({
    id: "InboundDocument",
    description:
      "A stored document. The raw bytes are stored encrypted at rest and never returned; this is the metadata + staging summary. `status` is STORED for a freshly uploaded file (no extraction run). `title` is the user label (plaintext); `documentDate` is the user filing date; `reportDate` is the model-transcribed date (null until extraction runs).",
  });

const inboundDocumentDetail = inboundDocument
  .extend({ facts: z.array(extractedFact) })
  .meta({ id: "InboundDocumentDetail" });

const listResponse = z
  .object({
    documents: z.array(inboundDocument),
    nextCursor: z.string().nullable(),
  })
  .meta({
    id: "InboundDocumentList",
    description:
      "A page of documents plus an opaque `nextCursor` (the id to pass back as `cursor` for the next page; null when the list is exhausted).",
  });

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

const kindValues = [...INBOUND_DOCUMENT_KINDS];

export const inboundDocumentPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/documents/inbound": {
    get: {
      tags: ["Documents"],
      summary: "List stored documents",
      description:
        "The caller's stored documents with title/filename search, category filter, a `documentDate` range, sort, and keyset pagination. Owner-scoped; gated on the opt-in `inboundDocuments` module.",
      parameters: [
        {
          name: "q",
          in: "query",
          required: false,
          schema: { type: "string", maxLength: 100 },
          description: "Case-insensitive search over title + filename.",
        },
        {
          name: "kind",
          in: "query",
          required: false,
          schema: { type: "string", enum: kindValues },
          description: "Category filter.",
        },
        {
          name: "from",
          in: "query",
          required: false,
          schema: { type: "string", format: "date" },
          description: "Inclusive lower bound on documentDate (YYYY-MM-DD).",
        },
        {
          name: "to",
          in: "query",
          required: false,
          schema: { type: "string", format: "date" },
          description: "Inclusive upper bound on documentDate (YYYY-MM-DD).",
        },
        {
          name: "sort",
          in: "query",
          required: false,
          schema: {
            type: "string",
            enum: ["documentDate", "createdAt", "title"],
            default: "documentDate",
          },
        },
        {
          name: "order",
          in: "query",
          required: false,
          schema: { type: "string", enum: ["asc", "desc"], default: "desc" },
        },
        {
          name: "cursor",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Keyset cursor (the `nextCursor` from a prior page).",
        },
        {
          name: "limit",
          in: "query",
          required: false,
          schema: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            default: 50,
          },
        },
      ],
      responses: {
        "200": {
          description: "A page of documents.",
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
      summary: "Store a document (no extraction)",
      description:
        "STORE-ONLY upload. Stores the raw document ENCRYPTED at rest with `status: STORED` and runs NO extraction — provider-free, no AI consent / budget / egress. A file is always filable, even with no document-scan provider configured. `multipart/form-data`: a `file` (JPEG/PNG/WebP/PDF, validated by magic-byte MIME sniff, ≤ 12 MiB) plus optional `title`, `kind`, and `documentDate` (YYYY-MM-DD) form fields. AI extraction is a separate opt-in action — see `POST /api/documents/inbound/{id}/extract`.",
      requestBody: {
        required: true,
        content: {
          "multipart/form-data": {
            schema: z.object({
              file: z.string().meta({
                format: "binary",
                description:
                  "The document image or PDF. Validated by magic-byte MIME sniff, not the wire Content-Type.",
              }),
              title: z
                .string()
                .optional()
                .meta({ description: "Optional user label." }),
              kind: kindEnum
                .optional()
                .meta({ description: "Optional category." }),
              documentDate: z.string().optional().meta({
                description:
                  "Optional user filing date (YYYY-MM-DD). Defaults to the upload day when omitted so the library sort/filter/display stay aligned.",
              }),
            }),
          },
        },
      },
      responses: {
        "201": {
          description: "The stored document.",
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
    patch: {
      tags: ["Documents"],
      summary: "Edit a document's metadata",
      description:
        "Rename / recategorise / set the user filing date on a stored document. Owner-scoped; no mass assignment. Returns the updated document + its staged facts.",
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
        content: { "application/json": { schema: documentUpdateSchema } },
      },
      responses: {
        "200": {
          description: "The updated document.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                inboundDocumentDetail,
                "InboundDocumentUpdateEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Documents"],
      summary: "Discard a document",
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
  "/api/documents/inbound/{id}/original": {
    get: {
      tags: ["Documents"],
      summary: "View / download the original document",
      description:
        "Decrypts and serves the raw uploaded document (the bytes stored encrypted at rest under `InboundDocument.contentEncrypted`). Owner-scoped + gated on the opt-in `inboundDocuments` module. Uploads are constrained at the store path to the inline-safe set (JPEG / PNG / WebP / PDF), so the document is always served `Content-Disposition: inline` for in-tab rendering; a non-ASCII filename is carried via RFC 5987 `filename*`. Fails closed (500) on a decrypt error — it never returns the ciphertext.",
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
          description:
            "The decrypted original document bytes with the stored MIME type.",
          content: {
            "application/pdf": {
              schema: { type: "string", format: "binary" },
            },
            "image/*": {
              schema: { type: "string", format: "binary" },
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/documents/inbound/{id}/extract": {
    post: {
      tags: ["Documents"],
      summary: "Extract facts from a stored document",
      description:
        'Optional AI enhancement on an already-stored document. Runs the dedicated OCR/vision provider over the stored original and stages STRUCTURED FACTS for review. AI-consent / rate / budget gated. With no provider configured this returns 422 (`documents.inbound.providerUnsupported`) — the stored document is untouched, only the enhancement fails. Two modes by content-type: VISION (empty body) decrypts and scans the stored original (PDF needs an Anthropic vision provider); TEXT (`application/json`, opt-in local OCR) `{ mode: "text", text }` structures browser-OCR\'d text. Extraction reproduces what the document states — it never interprets. Nothing reaches the structured stores here; the confirm route is the only write path.',
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: z
              .object({
                mode: z.literal("text"),
                text: z.string(),
                kind: kindEnum.optional(),
              })
              .meta({ id: "InboundTextExtractRequest" }),
          },
        },
      },
      responses: {
        "200": {
          description: "The document with its newly staged facts.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                inboundDocumentDetail,
                "InboundExtractEnvelope",
              ),
            },
          },
        },
        "409": {
          description:
            "Re-extraction refused: at least one fact on this document is already APPROVED. `meta.errorCode` = `documents.inbound.alreadyPartlyConfirmed`. Re-extracting would sever committed-record provenance and duplicate committed records, so the user must finish reviewing or discard the document first.",
          content: { "application/json": { schema: errorEnvelope } },
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
