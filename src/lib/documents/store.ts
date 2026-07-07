/**
 * v1.25 (W-DOCS-IN) — server-side helpers for the inbound-document store.
 *
 * The AES-256-GCM ↔ `Bytes` codec for `InboundDocument.contentEncrypted` (the
 * raw uploaded document, base64-of-binary → `encrypt()` string → UTF-8 bytes,
 * the same `*Encrypted` format every other sensitive column uses) plus the
 * DTO serialisers that turn the persisted rows into the wire shapes.
 */
import { Buffer } from "node:buffer";

import { decryptFromBytes, encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { decrypt, decryptBytes, encrypt, encryptBytes } from "@/lib/crypto";
import type {
  ExtractedFact,
  ExtractedFactStatus,
  InboundDocument,
  InboundDocumentStatus,
} from "@/generated/prisma/client";
import { servingClassFor } from "@/lib/documents/upload-policy";
import type {
  DocumentConditionLinkDto,
  ExtractedFactDto,
  FactData,
  FactProvenance,
  InboundDocumentDetailDto,
  InboundDocumentDto,
  InboundDocumentKindValue,
  InboundFactType,
} from "@/lib/validations/inbound-documents";

/**
 * The two storage codecs `InboundDocument.contentEncrypted` may carry,
 * recorded per row in the explicit `contentCodec` column (never sniffed):
 *   - "base64v1" — the legacy string path (base64-of-binary → `encrypt()`
 *     string → UTF-8 bytes). Pre-vault rows only; kept read-compatible.
 *   - "binary2"  — the binary AES-256-GCM layout (`encryptBytes()`), no
 *     base64 detour. Every new upload writes this.
 */
export const DOCUMENT_CONTENT_CODECS = ["base64v1", "binary2"] as const;
export type DocumentContentCodec = (typeof DOCUMENT_CONTENT_CODECS)[number];

/** The codec every NEW upload is written with. */
export const ACTIVE_DOCUMENT_CODEC: DocumentContentCodec = "binary2";

/** Encrypt the raw document bytes into the `Bytes` payload the schema stores. */
export function encryptDocumentToBytes(bytes: Buffer): Uint8Array<ArrayBuffer> {
  const ciphertext = encrypt(bytes.toString("base64"));
  const encoded = Buffer.from(ciphertext, "utf8");
  const out = new Uint8Array(new ArrayBuffer(encoded.byteLength));
  out.set(encoded);
  return out;
}

/**
 * Decrypt a stored document's `Bytes` payload back to its raw bytes. The exact
 * inverse of `encryptDocumentToBytes`: the column holds `encrypt()`-string
 * UTF-8 bytes whose plaintext is the base64 of the original binary. Throws on a
 * bad / missing key id (fail-closed) — the caller must treat a throw as "cannot
 * serve" and never fall back to returning the ciphertext. The original document
 * is PHI; the owner-scoped download route and the optional extraction action are
 * the only paths that read it.
 */
export function decryptDocumentFromBytes(buf: Uint8Array): Buffer {
  const base64 = decrypt(Buffer.from(buf).toString("utf8"));
  return Buffer.from(base64, "base64");
}

/**
 * Encrypt raw document bytes with the ACTIVE codec (binary2). Returns the
 * `Bytes` payload plus the codec label the row must persist alongside it.
 */
export function encryptDocumentContent(bytes: Buffer): {
  content: Uint8Array<ArrayBuffer>;
  codec: DocumentContentCodec;
} {
  const encrypted = encryptBytes(bytes);
  const out = new Uint8Array(new ArrayBuffer(encrypted.byteLength));
  out.set(encrypted);
  return { content: out, codec: ACTIVE_DOCUMENT_CODEC };
}

/**
 * Decrypt a stored document's payload, dispatching on the row's persisted
 * codec. Fail-closed: an unknown codec value throws — a silent fallback to
 * either codec would either return garbage or mask data corruption.
 */
export function decryptDocumentContent(buf: Uint8Array, codec: string): Buffer {
  if (codec === "base64v1") return decryptDocumentFromBytes(buf);
  if (codec === "binary2") return decryptBytes(Buffer.from(buf));
  throw new Error(`Unknown document content codec '${codec}'`);
}

/**
 * Encrypt a staged fact's FHIR-staged payload into the `Bytes` column the
 * schema stores. The structured clinical values (diagnosis text, lab values,
 * medication names, stated codes) are PHI, so they ride the shared AES-256-GCM
 * note codec (JSON → `encrypt()` string → UTF-8 bytes) rather than plaintext
 * JSONB.
 */
export function encryptFactData(data: FactData): Uint8Array<ArrayBuffer> {
  return encryptToBytes(JSON.stringify(data));
}

/** Decrypt a staged fact's payload back to its DTO shape. Throws on bad key. */
export function decryptFactData(buf: Uint8Array): FactData {
  return JSON.parse(decryptFromBytes(buf)) as FactData;
}

/**
 * Encrypt a staged fact's provenance. The verbatim source span is a clinical
 * document excerpt (PHI); encrypted with the same codec as the fact data.
 */
export function encryptFactProvenance(
  provenance: FactProvenance,
): Uint8Array<ArrayBuffer> {
  return encryptToBytes(JSON.stringify(provenance));
}

/** Decrypt a staged fact's provenance back to its DTO shape. */
export function decryptFactProvenance(buf: Uint8Array): FactProvenance {
  return JSON.parse(decryptFromBytes(buf)) as FactProvenance;
}

/**
 * The row fields the serialisers read. Deliberately WITHOUT
 * `contentEncrypted`: the list path must never select the blob column
 * (hardening — see the list route's `omit`), so the DTO mappers cannot
 * require it either.
 */
export type SerialisableDocument = Omit<InboundDocument, "contentEncrypted">;

/** Map a persisted document row (+ counts + links) to the list/detail DTO. */
export function serialiseDocument(
  doc: SerialisableDocument,
  counts: { factCount: number; pendingCount: number },
  conditionLinks: DocumentConditionLinkDto[] = [],
): InboundDocumentDto {
  return {
    id: doc.id,
    kind: doc.kind as InboundDocumentKindValue,
    title: doc.title,
    filename: doc.filename,
    mimeType: doc.mimeType,
    byteSize: doc.byteSize,
    status: doc.status as InboundDocumentStatus,
    providerType: doc.providerType,
    reportDate: doc.reportDate
      ? doc.reportDate.toISOString().slice(0, 10)
      : null,
    documentDate: doc.documentDate
      ? doc.documentDate.toISOString().slice(0, 10)
      : null,
    errorReason: doc.errorReason,
    factCount: counts.factCount,
    pendingCount: counts.pendingCount,
    conditionLinks,
    servingClass: servingClassFor(doc.mimeType),
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

/** Map a persisted staged-fact row to the review DTO. */
export function serialiseFact(fact: ExtractedFact): ExtractedFactDto {
  return {
    id: fact.id,
    factType: fact.factType as InboundFactType,
    status: fact.status as ExtractedFactStatus,
    confidence: fact.confidence,
    needsReview: fact.needsReview,
    data: decryptFactData(fact.dataEncrypted),
    provenance: decryptFactProvenance(fact.provenanceEncrypted),
    committedRecordId: fact.committedRecordId,
    committedRecordType: fact.committedRecordType,
  };
}

/** Assemble the detail DTO (document + its staged facts + links). */
export function serialiseDocumentDetail(
  doc: SerialisableDocument,
  facts: ExtractedFact[],
  conditionLinks: DocumentConditionLinkDto[] = [],
): InboundDocumentDetailDto {
  const pendingCount = facts.filter((f) => f.status === "PENDING").length;
  // `factCount` excludes REJECTED facts (a rejected fact is discarded, not part
  // of the document's tally) so the badge matches the list query.
  const factCount = facts.filter((f) => f.status !== "REJECTED").length;
  return {
    ...serialiseDocument(doc, { factCount, pendingCount }, conditionLinks),
    facts: facts.map(serialiseFact),
  };
}
