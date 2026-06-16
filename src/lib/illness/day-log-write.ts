/**
 * Illness day-log write helper (v1.18.1) — the upsert behind
 * `POST .../episodes/{id}/day-logs`.
 *
 * UPSERT key: the canonical `(episodeId, date)`. `note` → `noteEncrypted`
 * (AES-256-GCM via the shared Bytes codec). Symptom links carry a 0–3
 * Jackson/WURSS severity (NULL = a plain presence link).
 *
 * Partial merge: a re-post that omits a field never nulls a previously
 * stored value — the UPDATE branch only overwrites the fields actually
 * present in the input. An explicit `null` clears.
 *
 * Symptom-key resolution is scoped to the global seeded catalog (illness
 * symptoms have no per-user custom rows in the MVP); unknown keys are
 * dropped silently.
 */
import { prisma } from "@/lib/db";
import {
  decryptFromBytes,
  encryptToBytes,
} from "@/lib/ai/coach/bytes-codec";
import type { IllnessDayLogInput } from "@/lib/validations/illness";

export interface IllnessDayLogWriteResult {
  id: string;
  existed: boolean;
}

/** A symptom selection carrying its catalog key + optional 0–3 severity. */
export interface IllnessSymptomSelection {
  key: string;
  severity?: number | null;
}

/**
 * Resolve catalog symptom keys → `{ key, id }`, dropping unknown / inactive
 * keys silently.
 */
export async function resolveIllnessSymptomIds(
  keys: readonly string[],
): Promise<{ key: string; id: string }[]> {
  if (keys.length === 0) return [];
  const unique = Array.from(new Set(keys));
  const rows = await prisma.illnessSymptom.findMany({
    where: { key: { in: unique }, isActive: true },
    select: { id: true, key: true },
  });
  return rows.map((r) => ({ key: r.key, id: r.id }));
}

/**
 * Replace the symptom-link set for a day-log. Each selection's optional
 * 0–3 severity is persisted on the link (NULL = a plain presence link).
 */
export async function replaceIllnessSymptomLinks(
  dayLogId: string,
  selections: readonly IllnessSymptomSelection[],
): Promise<void> {
  const resolved = await resolveIllnessSymptomIds(
    selections.map((s) => s.key),
  );
  const severityByKey = new Map(
    selections.map((s) => [
      s.key,
      typeof s.severity === "number" ? s.severity : null,
    ]),
  );
  await prisma.illnessSymptomLink.deleteMany({ where: { dayLogId } });
  if (resolved.length > 0) {
    await prisma.illnessSymptomLink.createMany({
      data: resolved.map(({ key, id }) => ({
        dayLogId,
        symptomId: id,
        severity: severityByKey.get(key) ?? null,
      })),
      skipDuplicates: true,
    });
  }
}

/** Decrypt a Bytes note fail-soft (null on missing / undecryptable). */
function decryptNoteSoft(noteEncrypted: Uint8Array | null): string | null {
  if (!noteEncrypted || noteEncrypted.byteLength === 0) return null;
  try {
    return decryptFromBytes(noteEncrypted);
  } catch {
    return null;
  }
}

/**
 * Upsert one illness day-log on the `(episodeId, date)` key. The caller is
 * responsible for verifying the episode is owned + live before calling.
 * `tz` anchors the date string.
 */
export async function upsertIllnessDayLog(
  userId: string,
  episodeId: string,
  entry: IllnessDayLogInput,
  tz: string | null,
): Promise<IllnessDayLogWriteResult> {
  const where = { episodeId_date: { episodeId, date: entry.date } };

  const existing = await prisma.illnessDayLog.findUnique({
    where,
    select: {
      id: true,
      functionalImpact: true,
      feverC: true,
      noteEncrypted: true,
    },
  });

  // Partial merge against the stored row.
  const functionalImpact =
    entry.functionalImpact !== undefined
      ? (entry.functionalImpact ?? null)
      : (existing?.functionalImpact ?? null);
  const feverC =
    entry.feverC !== undefined
      ? (entry.feverC ?? null)
      : (existing?.feverC ?? null);

  const incomingNote =
    entry.note !== undefined
      ? (entry.note ?? null)
      : decryptNoteSoft(existing?.noteEncrypted ?? null);
  const noteEncrypted = incomingNote ? encryptToBytes(incomingNote) : null;

  const row = await prisma.illnessDayLog.upsert({
    where,
    create: {
      userId,
      episodeId,
      date: entry.date,
      tz,
      functionalImpact,
      feverC,
      noteEncrypted,
    },
    update: {
      functionalImpact,
      feverC,
      noteEncrypted,
      deletedAt: null,
    },
    select: { id: true },
  });

  if (entry.symptoms !== undefined) {
    await replaceIllnessSymptomLinks(row.id, entry.symptoms);
  }

  return { id: row.id, existed: existing !== null };
}
