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
import { decrypt, encrypt } from "@/lib/crypto";
import type {
  ExtractedFact,
  ExtractedFactStatus,
  InboundDocument,
  InboundDocumentStatus,
} from "@/generated/prisma/client";
import type {
  ExtractedFactDto,
  FactData,
  FactProvenance,
  InboundDocumentDetailDto,
  InboundDocumentDto,
  InboundDocumentKindValue,
  InboundFactType,
} from "@/lib/validations/inbound-documents";

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

/** Map a persisted document row (+ counts) to the list/detail DTO. */
export function serialiseDocument(
  doc: InboundDocument,
  counts: { factCount: number; pendingCount: number },
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

/** Assemble the detail DTO (document + its staged facts). */
export function serialiseDocumentDetail(
  doc: InboundDocument,
  facts: ExtractedFact[],
): InboundDocumentDetailDto {
  const pendingCount = facts.filter((f) => f.status === "PENDING").length;
  return {
    ...serialiseDocument(doc, { factCount: facts.length, pendingCount }),
    facts: facts.map(serialiseFact),
  };
}
