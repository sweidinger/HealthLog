/**
 * v1.25 (W-DOCS-IN) — inbound clinical-document ingestion contract.
 *
 * A self-hoster uploads a doctor report / discharge letter they received. The
 * dedicated OCR/vision provider transcribes STRUCTURED FACTS that land on a
 * MANDATORY review-then-confirm screen; only the user-approved facts reach the
 * structured stores (labs / conditions / medications) through their normal
 * create paths.
 *
 * The safety line this module encodes: EXTRACT, NEVER INTERPRET. The provider
 * is asked to reproduce what is written (text, value, code, date) with
 * provenance and a confidence gate — it never infers a code, never flags a
 * value high/low, never links a condition to a medication, never assigns
 * meaning, severity, or a diagnosis. Diagnoses are stored as the document's
 * STATED assertion about the patient, never as the app's conclusion.
 *
 * This module holds:
 *   - `inboundExtractionSchema` — the schema the provider's JSON is validated
 *     against (UNTRUSTED model output). Liberal on shape; the review screen is
 *     the safety boundary.
 *   - the staged-fact DTO shapes the routes return + the UI consumes.
 *   - `inboundFactEditSchema` — the per-fact correction the review screen sends
 *     before approval (fixes OCR / units / dates / codes).
 *   - `inboundConfirmSchema` — the approve/reject decisions. No `userId` field;
 *     it is always narrowed from the session.
 */
import { z } from "zod/v4";

/** Max facts a single document may stage / confirm. A dense letter is ~40. */
export const INBOUND_MAX_FACTS = 120;

/**
 * Confidence floor. A fact scoring below this fails closed: it is staged with
 * `needsReview = true` and cannot be approved until the user edits it (the
 * values then become user-asserted). When unsure, the app surfaces raw text
 * for manual entry rather than guessing a value.
 */
export const INBOUND_CONFIDENCE_FLOOR = 0.6;

/** The three FHIR resources a fact maps to (stated status only). */
export const INBOUND_FACT_TYPES = [
  "CONDITION",
  "OBSERVATION",
  "MEDICATION_STATEMENT",
] as const;
export type InboundFactType = (typeof INBOUND_FACT_TYPES)[number];

/** The document-kind labels (no interpretation — a label only). */
export const INBOUND_DOCUMENT_KINDS = [
  "DOCTOR_REPORT",
  "DISCHARGE_LETTER",
  "LAB_RESULT",
  "IMAGING",
  "PRESCRIPTION",
  "INSURANCE",
  "VACCINATION",
  "OTHER",
] as const;
export type InboundDocumentKindValue = (typeof INBOUND_DOCUMENT_KINDS)[number];

/** The document lifecycle states. STORED is the library default. */
export const INBOUND_DOCUMENT_STATUSES = [
  "STORED",
  "EXTRACTING",
  "EXTRACTED",
  "FAILED",
  "CONFIRMED",
  "DISCARDED",
] as const;
export type InboundDocumentStatusValue =
  (typeof INBOUND_DOCUMENT_STATUSES)[number];

/**
 * The coding systems a fact's STATED code may belong to. The provider emits a
 * code ONLY when the document writes one — it never machine-guesses. Mirrors
 * the systems the existing FHIR mappers already speak (SNOMED/ICD-10 for a
 * Condition, LOINC for an Observation, RxNorm/ATC for a MedicationStatement).
 */
export const INBOUND_CODE_SYSTEMS = [
  "SNOMED",
  "ICD10",
  "LOINC",
  "RXNORM",
  "ATC",
] as const;
export type InboundCodeSystem = (typeof INBOUND_CODE_SYSTEMS)[number];

const confidenceScore = z.number().min(0).max(1).catch(0);
const nullableText = (max: number) =>
  z.string().trim().min(1).max(max).nullable().catch(null);

/**
 * One fact as the PROVIDER returns it (untrusted). A single flat shape across
 * the three fact types so the wire stays simple; the route maps it to the
 * per-type staged payload. Everything is `.catch`-guarded so a malformed field
 * degrades to null + low confidence rather than 422-ing the whole extraction.
 */
export const extractedFactRawSchema = z.object({
  type: z.enum(INBOUND_FACT_TYPES),
  /** Verbatim label / diagnosis text / medication name as written. */
  label: z.string().trim().min(1).max(300).catch(""),
  /** STATED code, present only when the document writes one. */
  code: nullableText(64),
  codeSystem: z.enum(INBOUND_CODE_SYSTEMS).nullable().catch(null),
  /** Condition: stated clinical / verification status (verbatim). */
  clinicalStatus: nullableText(64),
  verificationStatus: nullableText(64),
  /** Observation: numeric XOR qualitative value, unit, stated ref bounds. */
  value: z.number().finite().nullable().catch(null),
  valueText: nullableText(300),
  unit: nullableText(80),
  referenceLow: z.number().finite().nullable().catch(null),
  referenceHigh: z.number().finite().nullable().catch(null),
  /** MedicationStatement: dose + stated status (verbatim). */
  dose: nullableText(120),
  medicationStatus: nullableText(64),
  /** A stated date for the fact (onset / effective / report), ISO or null. */
  effectiveDate: z.string().nullable().catch(null),
  /** Provenance: the verbatim source span this fact came from. */
  sourceText: z.string().trim().max(2000).catch(""),
  /** Optional 0-based page index the fact was read from. */
  page: z.number().int().min(0).max(10000).nullable().catch(null),
  /** The model's self-reported overall confidence for this fact (0..1). */
  confidence: confidenceScore.default(0),
});

export type ExtractedFactRaw = z.infer<typeof extractedFactRawSchema>;

/** The full JSON envelope the provider returns. */
export const inboundExtractionSchema = z.object({
  reportDate: z.string().nullable().catch(null),
  kind: z.enum(INBOUND_DOCUMENT_KINDS).nullable().catch(null),
  facts: z.array(extractedFactRawSchema).max(INBOUND_MAX_FACTS).catch([]),
});

export type InboundExtraction = z.infer<typeof inboundExtractionSchema>;

// ─── Staged-fact payloads (FHIR-staged, stated status only) ────────────────

/** Per-field provenance carried on every staged fact. */
export interface FactProvenance {
  /** The verbatim source span the value was transcribed from. */
  sourceText: string;
  /** Optional 0-based page index. */
  page: number | null;
  /** The model's self-reported confidence (0..1). */
  confidence: number;
}

/** Condition staging payload — maps to FHIR `Condition` (stated status). */
export interface ConditionFactData {
  label: string;
  code: string | null;
  codeSystem: InboundCodeSystem | null;
  clinicalStatus: string | null;
  verificationStatus: string | null;
  onsetDate: string | null;
}

/** Observation staging payload — maps to FHIR `Observation` (no range-flag). */
export interface ObservationFactData {
  label: string;
  code: string | null;
  codeSystem: InboundCodeSystem | null;
  value: number | null;
  valueText: string | null;
  unit: string | null;
  referenceLow: number | null;
  referenceHigh: number | null;
  effectiveDate: string | null;
}

/** MedicationStatement staging payload — maps to FHIR `MedicationStatement`. */
export interface MedicationStatementFactData {
  name: string;
  dose: string | null;
  rxNormCode: string | null;
  atcCode: string | null;
  statusStated: string | null;
  effectiveDate: string | null;
}

export type FactData =
  ConditionFactData | ObservationFactData | MedicationStatementFactData;

/** The staged-fact DTO the routes return + the review UI consumes. */
export interface ExtractedFactDto {
  id: string;
  factType: InboundFactType;
  status: "PENDING" | "APPROVED" | "REJECTED";
  confidence: number;
  needsReview: boolean;
  data: FactData;
  provenance: FactProvenance;
  committedRecordId: string | null;
  committedRecordType: string | null;
}

/** The document DTO (list + detail). */
export interface InboundDocumentDto {
  id: string;
  kind: InboundDocumentKindValue;
  /** User-given title (plaintext), or null when never set. */
  title: string | null;
  filename: string | null;
  mimeType: string;
  byteSize: number;
  status: InboundDocumentStatusValue;
  providerType: string | null;
  /** Model-transcribed report/collection date (YYYY-MM-DD), or null. */
  reportDate: string | null;
  /** User-set filing date (YYYY-MM-DD), or null. */
  documentDate: string | null;
  errorReason: string | null;
  /** Count of the document's non-REJECTED staged facts. */
  factCount: number;
  /** Count of staged facts still PENDING review. */
  pendingCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface InboundDocumentDetailDto extends InboundDocumentDto {
  facts: ExtractedFactDto[];
}

// ─── Edit (correction before approval) ─────────────────────────────────────

const reqText = (max: number) => z.string().trim().min(1).max(max);
const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === "" ? null : v));
const optCode = z.enum(INBOUND_CODE_SYSTEMS).nullable().optional();
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, "Expected a YYYY-MM-DD date")
  .nullable()
  .optional();

const conditionEditSchema = z.object({
  factType: z.literal("CONDITION"),
  label: reqText(300),
  code: optText(64),
  codeSystem: optCode,
  clinicalStatus: optText(64),
  verificationStatus: optText(64),
  onsetDate: isoDate,
});

const observationEditSchema = z
  .object({
    factType: z.literal("OBSERVATION"),
    label: reqText(300),
    code: optText(64),
    codeSystem: optCode,
    value: z.number().finite().nullable().optional(),
    valueText: optText(300),
    unit: optText(80),
    referenceLow: z.number().finite().nullable().optional(),
    referenceHigh: z.number().finite().nullable().optional(),
    effectiveDate: isoDate,
  })
  // Numeric XOR qualitative, mirroring the lab-result discipline. A null/absent
  // value with a null/absent valueText is allowed (the user may still be
  // entering it) but not BOTH set.
  .refine(
    (d) => !(typeof d.value === "number" && typeof d.valueText === "string"),
    {
      message: "Provide a numeric value OR qualitative text, not both",
      path: ["value"],
    },
  );

const medicationEditSchema = z.object({
  factType: z.literal("MEDICATION_STATEMENT"),
  name: reqText(200),
  dose: optText(120),
  rxNormCode: optText(20),
  atcCode: optText(16),
  statusStated: optText(64),
  effectiveDate: isoDate,
});

/**
 * A correction to a staged fact (the review screen edits OCR / units / dates /
 * codes before approval). Discriminated by `factType` so the edit can never
 * change a fact's resource type. A successful edit clears `needsReview` — the
 * values become user-asserted.
 */
export const inboundFactEditSchema = z.discriminatedUnion("factType", [
  conditionEditSchema,
  observationEditSchema,
  medicationEditSchema,
]);

export type InboundFactEdit = z.infer<typeof inboundFactEditSchema>;

// ─── Confirm (approve / reject) ────────────────────────────────────────────

/**
 * The approve/reject decisions the user made on the review screen. Each
 * decision names a staged fact by id. Approved facts are committed to the
 * structured stores; rejected facts are discarded. No `userId` field — it is
 * always narrowed from the session; the route also re-scopes every fact id to
 * the document + the caller.
 */
export const inboundConfirmSchema = z.object({
  decisions: z
    .array(
      z.object({
        factId: z.string().trim().min(1).max(40),
        action: z.enum(["approve", "reject"]),
      }),
    )
    .min(1)
    .max(INBOUND_MAX_FACTS),
});

export type InboundConfirmInput = z.infer<typeof inboundConfirmSchema>;

/** The text-mode (local-OCR) extract body, mirroring the Lab-OCR text mode. */
export const INBOUND_TEXT_MAX_CHARS = 200_000;

export const inboundTextExtractSchema = z.object({
  mode: z.literal("text"),
  text: z.string().trim().min(1).max(INBOUND_TEXT_MAX_CHARS),
  kind: z.enum(INBOUND_DOCUMENT_KINDS).optional(),
});

export type InboundTextExtractInput = z.infer<typeof inboundTextExtractSchema>;

// ─── Library: store / edit / list ──────────────────────────────────────────

/** A bare YYYY-MM-DD date string (no time component). */
const isoDateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, "Expected a YYYY-MM-DD date");

export const DOCUMENT_TITLE_MAX = 200;

/**
 * The store-only upload metadata (the multipart form fields beside the file).
 * Every field is optional — a bare file upload is valid and lands as a STORED
 * document with no title / category / filing date. No `userId` field; it is
 * always narrowed from the session.
 */
export const documentCreateSchema = z.object({
  title: z.string().trim().min(1).max(DOCUMENT_TITLE_MAX).optional(),
  kind: z.enum(INBOUND_DOCUMENT_KINDS).optional(),
  documentDate: isoDateString.optional(),
});

export type DocumentCreateInput = z.infer<typeof documentCreateSchema>;

/**
 * Metadata edit (rename / recategorise / set the filing date). At least one
 * field must be present. `title` accepts null to clear it; `documentDate`
 * accepts null to clear it. No `userId` field — narrowed from the session and
 * fed to the Prisma `where` alongside the row id.
 */
export const documentUpdateSchema = z
  .object({
    title: z
      .string()
      .trim()
      .max(DOCUMENT_TITLE_MAX)
      .nullable()
      .optional()
      .transform((v) => (v === "" ? null : v)),
    kind: z.enum(INBOUND_DOCUMENT_KINDS).optional(),
    documentDate: isoDateString.nullable().optional(),
  })
  .refine(
    (d) =>
      d.title !== undefined ||
      d.kind !== undefined ||
      d.documentDate !== undefined,
    { message: "Provide at least one field to update" },
  );

export type DocumentUpdateInput = z.infer<typeof documentUpdateSchema>;

/** Library list sort columns + page size. */
export const DOCUMENT_LIST_SORTS = [
  "documentDate",
  "createdAt",
  "title",
] as const;
export type DocumentListSort = (typeof DOCUMENT_LIST_SORTS)[number];

export const DOCUMENT_LIST_MAX_LIMIT = 100;
export const DOCUMENT_LIST_DEFAULT_LIMIT = 50;

/**
 * The library list query: title/filename search, category filter, a
 * `documentDate` range, sort + keyset pagination. Parsed off `searchParams`;
 * `safeParse` returns 422 on a bad value.
 */
export const documentListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  kind: z.enum(INBOUND_DOCUMENT_KINDS).optional(),
  from: isoDateString.optional(),
  to: isoDateString.optional(),
  sort: z.enum(DOCUMENT_LIST_SORTS).default("documentDate"),
  order: z.enum(["asc", "desc"]).default("desc"),
  cursor: z.string().trim().min(1).max(40).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(DOCUMENT_LIST_MAX_LIMIT)
    .default(DOCUMENT_LIST_DEFAULT_LIMIT),
});

export type DocumentListQuery = z.infer<typeof documentListQuerySchema>;
