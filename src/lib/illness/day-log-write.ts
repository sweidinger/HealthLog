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
import { dayLogSymptomInclude, toIllnessDayLogDTO } from "@/lib/illness/dto";
import type { IllnessDayLogDTO } from "@/lib/illness/dto";
import type { Prisma } from "@/generated/prisma/client";

export interface IllnessDayLogWriteResult {
  id: string;
  existed: boolean;
  /** The full DTO of the written row — no second round-trip needed. */
  dto: IllnessDayLogDTO;
}

/** A symptom selection carrying its catalog key + optional 0–3 severity. */
export interface IllnessSymptomSelection {
  key: string;
  severity?: number | null;
}

/** A Prisma client OR an interactive-transaction client. */
type Db = typeof prisma | Prisma.TransactionClient;

/**
 * Resolve catalog symptom keys → `{ key, id }`, dropping unknown / inactive
 * keys silently.
 */
export async function resolveIllnessSymptomIds(
  keys: readonly string[],
  db: Db = prisma,
): Promise<{ key: string; id: string }[]> {
  if (keys.length === 0) return [];
  const unique = Array.from(new Set(keys));
  const rows = await db.illnessSymptom.findMany({
    where: { key: { in: unique }, isActive: true },
    select: { id: true, key: true },
  });
  return rows.map((r) => ({ key: r.key, id: r.id }));
}

/**
 * Replace the symptom-link set for a day-log. Each selection's optional
 * 1–3 severity is persisted on the link (NULL = a plain presence link).
 * Runs on the caller's client so it can join the day-log upsert in one
 * transaction (no torn state between the delete + create halves).
 */
export async function replaceIllnessSymptomLinks(
  dayLogId: string,
  selections: readonly IllnessSymptomSelection[],
  db: Db = prisma,
): Promise<void> {
  const resolved = await resolveIllnessSymptomIds(
    selections.map((s) => s.key),
    db,
  );
  const severityByKey = new Map(
    selections.map((s) => [
      s.key,
      typeof s.severity === "number" ? s.severity : null,
    ]),
  );
  await db.illnessSymptomLink.deleteMany({ where: { dayLogId } });
  if (resolved.length > 0) {
    await db.illnessSymptomLink.createMany({
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

  // The upsert, the symptom-link replacement, and the final include-read all
  // run in ONE interactive transaction: no torn state between the link delete
  // + create halves, and no second round-trip — the written row (with its
  // flattened symptom links) comes straight back as the DTO.
  const { row, existed } = await prisma.$transaction(async (tx) => {
    const existing = await tx.illnessDayLog.findUnique({
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

    const upserted = await tx.illnessDayLog.upsert({
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
      await replaceIllnessSymptomLinks(upserted.id, entry.symptoms, tx);
    }

    const full = await tx.illnessDayLog.findUniqueOrThrow({
      where: { id: upserted.id },
      include: dayLogSymptomInclude,
    });

    return { row: full, existed: existing !== null };
  });

  return { id: row.id, existed, dto: toIllnessDayLogDTO(row) };
}
