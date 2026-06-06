/**
 * Cycle day-log write helper — the shared upsert behind the single POST,
 * the PATCH, and the bulk drain (ios-contract §2.A / §2.B).
 *
 * UPSERT key: `(userId, source, externalId)` when `externalId` is present
 * (the NULL-distinct cross-device dedup key, like MoodEntry), else the
 * canonical `(userId, date)` key. `note` → `notesEncrypted` (AES-256-GCM).
 *
 * Sensitive-category encryption: when the resolved profile flag is ON the
 * five intent-revealing fields (sexualActivity, protectedSex,
 * pregnancyTest, progesteroneTest, contraceptive) are encrypted into the
 * single `sensitiveEncrypted` JSON envelope and the plaintext columns are
 * NULLed — they then drop out of the rollup / correlation tier (the trade
 * for at-rest secrecy). When OFF the plaintext columns are written as
 * before and the envelope is NULL.
 *
 * Partial merge: a re-post that omits a field never nulls a previously
 * stored value — the UPDATE branch only overwrites the fields actually
 * present in the input.
 *
 * Collision-safe: on a `(userId, source, externalId)`-keyed create that
 * collides with an existing canonical `(userId, date)` row (Prisma P2002),
 * the existing row is adopted and UPDATEd in place — one canonical row per
 * date regardless of provenance.
 *
 * Returns the upserted row id + whether a row already existed (so the
 * caller can map `inserted`/`updated`/`duplicate`) plus whether any field
 * actually changed on a re-post (drives the bulk `updated` vs `duplicate`
 * distinction).
 */
import { prisma } from "@/lib/db";
import { encrypt, decrypt } from "@/lib/crypto";
import { getOrCreateCycleProfile } from "@/lib/cycle/profile";
import type { CycleDayLogInput } from "@/lib/validations/cycle";
import type { Prisma } from "@/generated/prisma/client";

export interface DayLogWriteResult {
  id: string;
  existed: boolean;
  /** A pre-existing row whose persisted fields differ from the re-post. */
  changed: boolean;
}

/** The five intent-revealing fields the encryption envelope carries. */
interface SensitiveFields {
  sexualActivity: boolean;
  protectedSex: boolean | null;
  pregnancyTest: string | null;
  progesteroneTest: string | null;
  contraceptive: string | null;
}

/** Resolve catalog symptom keys → ids, dropping unknown keys silently. */
export async function resolveSymptomIds(
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
 * Replace the symptom-link set for a day-log. Shared by the upsert helper
 * and the PATCH route so both resolve + write the join identically.
 */
export async function replaceSymptomLinks(
  userId: string,
  dayLogId: string,
  keys: readonly string[],
): Promise<void> {
  const ids = await resolveSymptomIds(userId, keys);
  await prisma.cycleSymptomLink.deleteMany({ where: { dayLogId } });
  if (ids.length > 0) {
    await prisma.cycleSymptomLink.createMany({
      data: ids.map((symptomId) => ({ dayLogId, symptomId })),
      skipDuplicates: true,
    });
  }
}

/** Decrypt the sensitive envelope fail-soft (null on missing / undecryptable). */
function decryptSensitive(envelope: string | null): Partial<SensitiveFields> {
  if (!envelope) return {};
  try {
    return JSON.parse(decrypt(envelope)) as Partial<SensitiveFields>;
  } catch {
    return {};
  }
}

/** Decrypt a note fail-soft (null on missing / undecryptable). */
function decryptNoteSoft(notesEncrypted: string | null): string | null {
  if (!notesEncrypted) return null;
  try {
    return decrypt(notesEncrypted);
  } catch {
    return null;
  }
}

type ExistingRow = {
  id: string;
  date: string;
  flow: string | null;
  intermenstrualBleeding: boolean;
  basalBodyTempC: number | null;
  ovulationTest: string | null;
  cervicalMucus: string | null;
  sexualActivity: boolean;
  protectedSex: boolean | null;
  pregnancyTest: string | null;
  progesteroneTest: string | null;
  contraceptive: string | null;
  sensitiveEncrypted: string | null;
  notesEncrypted: string | null;
  deletedAt: Date | null;
};

const EXISTING_SELECT = {
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
  sensitiveEncrypted: true,
  notesEncrypted: true,
  deletedAt: true,
} as const;

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

  // Resolve the sensitive-category encryption flag once per write.
  const profile = await getOrCreateCycleProfile(userId);
  const encryptSensitive = profile.sensitiveCategoryEncryption;

  const where: Prisma.CycleDayLogWhereUniqueInput = entry.externalId
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
  const existing = (await prisma.cycleDayLog.findUnique({
    where,
    select: EXISTING_SELECT,
  })) as ExistingRow | null;

  const result = await writeDayLog({
    userId,
    entry,
    tz,
    cycleId,
    source,
    where,
    existing,
    encryptSensitive,
  });

  return result;
}

interface WriteArgs {
  userId: string;
  entry: CycleDayLogInput;
  tz: string | null;
  cycleId: string | null;
  source: CycleDayLogInput["source"];
  where: Prisma.CycleDayLogWhereUniqueInput;
  existing: ExistingRow | null;
  encryptSensitive: boolean;
}

async function writeDayLog(args: WriteArgs): Promise<DayLogWriteResult> {
  const { userId, entry, tz, cycleId, source, where, existing, encryptSensitive } =
    args;

  // Decrypt the existing note (fail-soft) for the change/duplicate split —
  // re-encrypting the same plaintext yields a different ciphertext (random
  // GCM IV), so a ciphertext compare would always read "changed".
  const existingNote = decryptNoteSoft(existing?.notesEncrypted ?? null);

  // The resolved plaintext sensitive values for THIS write, after partial
  // merge against what's already stored (decrypted from the envelope when
  // the stored row was encrypted).
  const storedSensitive: SensitiveFields = existing
    ? mergeStoredSensitive(existing)
    : {
        sexualActivity: false,
        protectedSex: null,
        pregnancyTest: null,
        progesteroneTest: null,
        contraceptive: null,
      };

  const resolvedSensitive: SensitiveFields = {
    sexualActivity:
      entry.sexualActivity !== undefined
        ? entry.sexualActivity
        : storedSensitive.sexualActivity,
    protectedSex:
      entry.protectedSex !== undefined
        ? (entry.protectedSex ?? null)
        : storedSensitive.protectedSex,
    pregnancyTest:
      entry.pregnancyTest !== undefined
        ? (entry.pregnancyTest ?? null)
        : storedSensitive.pregnancyTest,
    progesteroneTest:
      entry.progesteroneTest !== undefined
        ? (entry.progesteroneTest ?? null)
        : storedSensitive.progesteroneTest,
    contraceptive:
      entry.contraceptive !== undefined
        ? (entry.contraceptive ?? null)
        : storedSensitive.contraceptive,
  };

  // Note resolution with partial merge: an omitted `note` keeps the stored
  // value; an explicit null clears it.
  const incomingNote =
    entry.note !== undefined ? (entry.note ?? null) : decryptNoteSoft(existing?.notesEncrypted ?? null);
  const notesEncrypted = incomingNote ? encrypt(incomingNote) : null;

  // Non-sensitive fields, partial-merged against the stored row.
  const flow = entry.flow !== undefined ? (entry.flow ?? null) : (existing?.flow ?? null);
  const intermenstrualBleeding =
    entry.intermenstrualBleeding !== undefined
      ? entry.intermenstrualBleeding
      : (existing?.intermenstrualBleeding ?? false);
  const basalBodyTempC =
    entry.basalBodyTempC !== undefined
      ? (entry.basalBodyTempC ?? null)
      : (existing?.basalBodyTempC ?? null);
  const ovulationTest =
    entry.ovulationTest !== undefined
      ? (entry.ovulationTest ?? null)
      : (existing?.ovulationTest ?? null);
  const cervicalMucus =
    entry.cervicalMucus !== undefined
      ? (entry.cervicalMucus ?? null)
      : (existing?.cervicalMucus ?? null);

  // Split the sensitive fields between plaintext columns and the envelope
  // depending on the flag. When encrypting, the plaintext columns are NULL
  // (drop out of rollup/correlation) and the envelope carries the JSON.
  const sensitiveEncrypted = encryptSensitive
    ? encrypt(JSON.stringify(resolvedSensitive))
    : null;
  const sensitivePlaintext = encryptSensitive
    ? {
        sexualActivity: false,
        protectedSex: null,
        pregnancyTest: null,
        progesteroneTest: null,
        contraceptive: null,
      }
    : { ...resolvedSensitive };

  const baseData: Prisma.CycleDayLogUncheckedUpdateInput = {
    flow: flow as never,
    intermenstrualBleeding,
    basalBodyTempC,
    ovulationTest: ovulationTest as never,
    cervicalMucus: cervicalMucus as never,
    sexualActivity: sensitivePlaintext.sexualActivity,
    protectedSex: sensitivePlaintext.protectedSex,
    pregnancyTest: sensitivePlaintext.pregnancyTest as never,
    progesteroneTest: sensitivePlaintext.progesteroneTest as never,
    contraceptive: sensitivePlaintext.contraceptive as never,
    sensitiveEncrypted,
    notesEncrypted,
  };

  // Did anything actually change vs the stored row? Compare the resolved
  // PLAINTEXT values (note + sensitive), never ciphertext.
  let changed = !existing;
  if (existing) {
    changed =
      (existing.flow ?? null) !== flow ||
      existing.intermenstrualBleeding !== intermenstrualBleeding ||
      (existing.basalBodyTempC ?? null) !== basalBodyTempC ||
      (existing.ovulationTest ?? null) !== ovulationTest ||
      (existing.cervicalMucus ?? null) !== cervicalMucus ||
      storedSensitive.sexualActivity !== resolvedSensitive.sexualActivity ||
      storedSensitive.protectedSex !== resolvedSensitive.protectedSex ||
      storedSensitive.pregnancyTest !== resolvedSensitive.pregnancyTest ||
      storedSensitive.progesteroneTest !== resolvedSensitive.progesteroneTest ||
      storedSensitive.contraceptive !== resolvedSensitive.contraceptive ||
      existingNote !== incomingNote ||
      existing.deletedAt !== null ||
      (Boolean(entry.externalId) && existing.date !== entry.date);
  }

  const updateData: Prisma.CycleDayLogUncheckedUpdateInput = {
    ...baseData,
    ...(entry.externalId ? { date: entry.date } : {}),
    ...(cycleId !== null ? { cycleId } : {}),
    deletedAt: null,
    // Only bump syncVersion when a field actually changed — an unchanged
    // re-post must be a true no-op on the /api/sync/changes feed so other
    // devices don't re-pull an identical row.
    ...(changed ? { syncVersion: { increment: 1 } } : {}),
  };

  let rowId: string;
  let existed = existing !== null;
  try {
    const row = await prisma.cycleDayLog.upsert({
      where,
      create: {
        userId,
        date: entry.date,
        tz,
        source,
        externalId: entry.externalId ?? null,
        cycleId,
        flow: baseData.flow as never,
        intermenstrualBleeding: baseData.intermenstrualBleeding as never,
        basalBodyTempC: baseData.basalBodyTempC as never,
        ovulationTest: baseData.ovulationTest as never,
        cervicalMucus: baseData.cervicalMucus as never,
        sexualActivity: sensitivePlaintext.sexualActivity,
        protectedSex: sensitivePlaintext.protectedSex,
        pregnancyTest: sensitivePlaintext.pregnancyTest as never,
        progesteroneTest: sensitivePlaintext.progesteroneTest as never,
        contraceptive: sensitivePlaintext.contraceptive as never,
        sensitiveEncrypted,
        notesEncrypted,
      },
      update: updateData,
      select: { id: true },
    });
    rowId = row.id;
  } catch (err: unknown) {
    // Dual-unique collision: an externalId-keyed create whose date already
    // has a canonical (userId, date) row. Adopt the existing row and UPDATE
    // it in place — one canonical row per date regardless of provenance.
    if (isUniqueViolation(err) && entry.externalId) {
      const canonical = await prisma.cycleDayLog.findUnique({
        where: { userId_date: { userId, date: entry.date } },
        select: { id: true },
      });
      if (!canonical) throw err;
      const adopted = await prisma.cycleDayLog.update({
        where: { id: canonical.id },
        data: {
          ...updateData,
          source,
          externalId: entry.externalId,
          ...(changed ? {} : { syncVersion: { increment: 1 } }),
        },
        select: { id: true },
      });
      rowId = adopted.id;
      existed = true;
      changed = true;
    } else {
      throw err;
    }
  }

  // Replace the symptom-link set when symptoms were supplied. Absent
  // `symptoms` leaves existing links untouched.
  if (entry.symptoms !== undefined) {
    await replaceSymptomLinks(
      userId,
      rowId,
      entry.symptoms.map((s) => s.key),
    );
  }

  return { id: rowId, existed, changed };
}

/** Prisma P2002 (unique constraint) detector without importing the runtime. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "P2002"
  );
}

/** Resolve the stored plaintext sensitive fields (envelope OR columns). */
function mergeStoredSensitive(existing: ExistingRow): SensitiveFields {
  if (existing.sensitiveEncrypted) {
    const dec = decryptSensitive(existing.sensitiveEncrypted);
    return {
      sexualActivity: dec.sexualActivity ?? false,
      protectedSex: dec.protectedSex ?? null,
      pregnancyTest: dec.pregnancyTest ?? null,
      progesteroneTest: dec.progesteroneTest ?? null,
      contraceptive: dec.contraceptive ?? null,
    };
  }
  return {
    sexualActivity: existing.sexualActivity,
    protectedSex: existing.protectedSex,
    pregnancyTest: existing.pregnancyTest,
    progesteroneTest: existing.progesteroneTest,
    contraceptive: existing.contraceptive,
  };
}
