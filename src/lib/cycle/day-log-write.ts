/**
 * Cycle day-log write helper — the shared upsert behind the single POST,
 * the PATCH, and the bulk drain (ios-contract §2.A / §2.B).
 *
 * UPSERT key: `(userId, source, externalId)` when `externalId` is present
 * (the NULL-distinct cross-device dedup key, like MoodEntry), else the
 * canonical `(userId, date)` key. `note` → `notesEncrypted` (AES-256-GCM);
 * every other field is queryable plaintext. Symptom keys resolve against
 * the seeded catalog (unknown keys dropped silently) and write the
 * `CycleSymptomLink` join.
 *
 * Returns the upserted row id + whether a row already existed (so the
 * caller can map `inserted`/`updated`/`duplicate`) plus whether any field
 * actually changed on a re-post (drives the bulk `updated` vs `duplicate`
 * distinction).
 */
import { prisma } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import type { CycleDayLogInput } from "@/lib/validations/cycle";

export interface DayLogWriteResult {
  id: string;
  existed: boolean;
  /** A pre-existing row whose persisted fields differ from the re-post. */
  changed: boolean;
}

/** Resolve catalog symptom keys → ids, dropping unknown keys silently. */
async function resolveSymptomIds(
  userId: string,
  keys: readonly string[],
): Promise<string[]> {
  if (keys.length === 0) return [];
  const unique = Array.from(new Set(keys));
  // Catalog rows (userId null) plus this user's own custom symptoms.
  const rows = await prisma.cycleSymptom.findMany({
    where: {
      key: { in: unique },
      isActive: true,
      OR: [{ userId: null }, { userId }],
    },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/**
 * Upsert one cycle day-log. `tz` anchors the date string. When
 * `cycleId` is supplied the row is attributed to that cycle span.
 */
export async function upsertCycleDayLog(
  userId: string,
  entry: CycleDayLogInput,
  tz: string | null,
  cycleId: string | null = null,
): Promise<DayLogWriteResult> {
  const source = entry.source;
  const notesEncrypted = entry.note ? encrypt(entry.note) : null;

  const where = entry.externalId
    ? {
        userId_source_externalId: {
          userId,
          source,
          externalId: entry.externalId,
        },
      }
    : { userId_date: { userId, date: entry.date } };

  // Probe so the caller can distinguish inserted / updated / duplicate
  // and (for an externalId re-post) detect whether a field changed.
  const existing = await prisma.cycleDayLog.findUnique({
    where,
    select: {
      id: true,
      date: true,
      flow: true,
      intermenstrualBleeding: true,
      basalBodyTempC: true,
      ovulationTest: true,
      cervicalMucus: true,
      sexualActivity: true,
      protectedSex: true,
      pregnancyTest: true,
      progesteroneTest: true,
      contraceptive: true,
      notesEncrypted: true,
      deletedAt: true,
    },
  });

  // Field-by-field create data (no mass assignment).
  const baseData = {
    flow: entry.flow ?? null,
    intermenstrualBleeding: entry.intermenstrualBleeding ?? false,
    basalBodyTempC: entry.basalBodyTempC ?? null,
    ovulationTest: entry.ovulationTest ?? null,
    cervicalMucus: entry.cervicalMucus ?? null,
    sexualActivity: entry.sexualActivity ?? false,
    protectedSex: entry.protectedSex ?? null,
    pregnancyTest: entry.pregnancyTest ?? null,
    progesteroneTest: entry.progesteroneTest ?? null,
    contraceptive: entry.contraceptive ?? null,
    notesEncrypted,
  };

  // Last-writer-wins on the field set. An externalId re-post also refreshes
  // `date` (a re-zoned re-import lands the corrected wall-clock). A
  // soft-deleted row is resurrected on a fresh write (deletedAt cleared).
  const updateData = {
    ...baseData,
    ...(entry.externalId ? { date: entry.date } : {}),
    ...(cycleId !== null ? { cycleId } : {}),
    deletedAt: null,
    syncVersion: { increment: 1 },
  };

  const row = await prisma.cycleDayLog.upsert({
    where,
    create: {
      userId,
      date: entry.date,
      tz,
      source,
      externalId: entry.externalId ?? null,
      cycleId,
      ...baseData,
    },
    update: updateData,
    select: { id: true },
  });

  // Replace the symptom-link set when symptoms were supplied. Absent
  // `symptoms` leaves existing links untouched (a partial day-log edit
  // that doesn't mention symptoms must not wipe them).
  if (entry.symptoms !== undefined) {
    const ids = await resolveSymptomIds(
      userId,
      entry.symptoms.map((s) => s.key),
    );
    await prisma.cycleSymptomLink.deleteMany({ where: { dayLogId: row.id } });
    if (ids.length > 0) {
      await prisma.cycleSymptomLink.createMany({
        data: ids.map((symptomId) => ({ dayLogId: row.id, symptomId })),
        skipDuplicates: true,
      });
    }
  }

  // `changed` only matters for the bulk `updated` vs `duplicate` split on
  // an existing row: did any persisted field differ from the re-post?
  let changed = false;
  if (existing) {
    changed =
      existing.flow !== baseData.flow ||
      existing.intermenstrualBleeding !== baseData.intermenstrualBleeding ||
      existing.basalBodyTempC !== baseData.basalBodyTempC ||
      existing.ovulationTest !== baseData.ovulationTest ||
      existing.cervicalMucus !== baseData.cervicalMucus ||
      existing.sexualActivity !== baseData.sexualActivity ||
      existing.protectedSex !== baseData.protectedSex ||
      existing.pregnancyTest !== baseData.pregnancyTest ||
      existing.progesteroneTest !== baseData.progesteroneTest ||
      existing.contraceptive !== baseData.contraceptive ||
      existing.notesEncrypted !== baseData.notesEncrypted ||
      existing.deletedAt !== null ||
      (Boolean(entry.externalId) && existing.date !== entry.date);
  }

  return { id: row.id, existed: existing !== null, changed };
}
