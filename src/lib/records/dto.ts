/**
 * Structured-record row → wire-DTO mappers (v1.25, W-RECORDS).
 *
 * The canonical `AllergyDTO` / `FamilyHistoryEntryDTO` shapes the iOS client
 * mirrors (server-authoritative — iOS renders, never recomputes). The
 * sensitive free-text fields live in `*Encrypted` (Bytes) columns and are
 * decrypted fail-soft on read (a key-rotation gap on one row reads `null`,
 * never 500s the whole page) — the IllnessEpisode DTO precedent.
 */
import { decryptFromBytes } from "@/lib/ai/coach/bytes-codec";
import type { Allergy, FamilyHistoryEntry } from "@/generated/prisma/client";

export interface AllergyDTO {
  id: string;
  substance: string;
  category: string;
  type: string;
  severity: string | null;
  status: string;
  onsetAt: string | null;
  reaction: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FamilyHistoryEntryDTO {
  id: string;
  relationship: string;
  condition: string;
  ageAtOnset: number | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Decrypt a Bytes payload fail-soft (null on missing / undecryptable). */
function decryptOptional(buf: Uint8Array | null): string | null {
  if (!buf || buf.byteLength === 0) return null;
  try {
    return decryptFromBytes(buf);
  } catch {
    return null;
  }
}

export function toAllergyDTO(row: Allergy): AllergyDTO {
  return {
    id: row.id,
    substance: row.substance,
    category: row.category,
    type: row.type,
    severity: row.severity,
    status: row.status,
    onsetAt: row.onsetAt ? row.onsetAt.toISOString() : null,
    reaction: decryptOptional(row.reactionEncrypted),
    note: decryptOptional(row.notesEncrypted),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toFamilyHistoryEntryDTO(
  row: FamilyHistoryEntry,
): FamilyHistoryEntryDTO {
  return {
    id: row.id,
    relationship: row.relationship,
    condition: row.condition,
    ageAtOnset: row.ageAtOnset,
    note: decryptOptional(row.notesEncrypted),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
