/**
 * Cycle-tracking backup serialisation — the one place the full-backup
 * writers (the on-demand `GET /api/export/full-backup` route AND the
 * pg-boss `data-backup` worker) read the cycle tables, so the two writers
 * never drift. Mirrors the `backupPayloadSchema` cycle shapes.
 *
 * Reads are scoped to `userId` + `deletedAt: null` and exclude predicted
 * (forecast) cycle rows — only observed history round-trips. `notesEncrypted`
 * is carried as the ciphertext envelope VERBATIM: the backup never decrypts
 * the day-log note, so a wrong-surface plaintext leak is impossible and the
 * owner's note round-trips encrypted at rest.
 */
import type { PrismaClient, Prisma } from "@/generated/prisma/client";
import type { BackupPayload } from "@/lib/validations/backup";

/** The cycle slice of a backup payload. */
export interface CycleBackupSection {
  cycleProfile: {
    goal: string;
    cycleTrackingEnabled: boolean | null;
    typicalCycleLength: number | null;
    typicalPeriodLength: number | null;
    lutealPhaseLength: number | null;
    secondarySymptom: string;
    predictionEnabled: boolean;
    rawChartMode: boolean;
    discreetNotifications: boolean;
    sensitiveCategoryEncryption: boolean;
  } | null;
  cycles: Array<{
    startDate: string;
    endDate: string | null;
    periodEndDate: string | null;
    lengthDays: number | null;
    ovulationDate: string | null;
    ovulationConfirmed: boolean;
    tz: string | null;
  }>;
  cycleDayLogs: Array<{
    date: string;
    flow: string | null;
    intermenstrualBleeding: boolean;
    basalBodyTempC: number | null;
    temperatureExcluded: boolean;
    ovulationTest: string | null;
    cervicalMucus: string | null;
    cervixPosition: string | null;
    cervixFirmness: string | null;
    cervixOpening: string | null;
    sexualActivity: boolean;
    protectedSex: boolean | null;
    pregnancyTest: string | null;
    progesteroneTest: string | null;
    contraceptive: string | null;
    sensitiveEncrypted: string | null;
    notesEncrypted: string | null;
    source: string;
    externalId: string | null;
    tz: string | null;
    symptomKeys: string[];
  }>;
}

/**
 * Build the cycle section of a user's full backup. Accepts any client with
 * the cycle delegates (the route's global client OR the worker's local
 * client) so both writers share one read.
 */
export async function buildCycleBackupSection(
  prisma: Pick<PrismaClient, "cycleProfile" | "menstrualCycle" | "cycleDayLog">,
  userId: string,
): Promise<CycleBackupSection> {
  const [profile, cycles, dayLogs] = await Promise.all([
    prisma.cycleProfile.findUnique({ where: { userId } }),
    prisma.menstrualCycle.findMany({
      where: { userId, deletedAt: null, isPredicted: false },
      orderBy: { startDate: "asc" },
    }),
    prisma.cycleDayLog.findMany({
      where: { userId, deletedAt: null },
      orderBy: { date: "asc" },
      include: {
        symptomLinks: { include: { symptom: { select: { key: true } } } },
      },
    }),
  ]);

  return {
    cycleProfile: profile
      ? {
          goal: profile.goal,
          cycleTrackingEnabled: profile.cycleTrackingEnabled,
          typicalCycleLength: profile.typicalCycleLength,
          typicalPeriodLength: profile.typicalPeriodLength,
          lutealPhaseLength: profile.lutealPhaseLength,
          secondarySymptom: profile.secondarySymptom,
          predictionEnabled: profile.predictionEnabled,
          rawChartMode: profile.rawChartMode,
          discreetNotifications: profile.discreetNotifications,
          sensitiveCategoryEncryption: profile.sensitiveCategoryEncryption,
        }
      : null,
    cycles: cycles.map((c) => ({
      startDate: c.startDate,
      endDate: c.endDate,
      periodEndDate: c.periodEndDate,
      lengthDays: c.lengthDays,
      ovulationDate: c.ovulationDate,
      ovulationConfirmed: c.ovulationConfirmed,
      tz: c.tz,
    })),
    cycleDayLogs: dayLogs.map((d) => ({
      date: d.date,
      flow: d.flow,
      intermenstrualBleeding: d.intermenstrualBleeding,
      basalBodyTempC: d.basalBodyTempC,
      temperatureExcluded: d.temperatureExcluded,
      ovulationTest: d.ovulationTest,
      cervicalMucus: d.cervicalMucus,
      cervixPosition: d.cervixPosition,
      cervixFirmness: d.cervixFirmness,
      cervixOpening: d.cervixOpening,
      sexualActivity: d.sexualActivity,
      protectedSex: d.protectedSex,
      pregnancyTest: d.pregnancyTest,
      progesteroneTest: d.progesteroneTest,
      contraceptive: d.contraceptive,
      // Both ciphertext envelopes carried verbatim — never decrypted here.
      sensitiveEncrypted: d.sensitiveEncrypted,
      notesEncrypted: d.notesEncrypted,
      source: d.source,
      externalId: d.externalId,
      tz: d.tz,
      symptomKeys: d.symptomLinks.map((l) => l.symptom.key),
    })),
  };
}

/* ── restore ───────────────────────────────────────────────────────── */

/** Counts the cycle restore wiped, for the audit trail. */
export interface CycleRestoreCleared {
  cycles: number;
  cycleDayLogs: number;
  cycleProfile: number;
}

// Closed enum allow-lists. The backup schema is `.passthrough()`, so a
// malformed enum value would otherwise crash deep in `create()`. Guard the
// few enum columns up-front (mirrors the measurement-type guard in the
// restore route). Unknown values are coerced to null rather than failing
// the whole restore — a single drifted field shouldn't strand the rest.
const FLOW_LEVELS = new Set(["NONE", "SPOTTING", "LIGHT", "MEDIUM", "HEAVY"]);
const OVULATION_TESTS = new Set([
  "NEGATIVE",
  "POSITIVE_LH_SURGE",
  "ESTROGEN_SURGE",
  "INDETERMINATE",
]);
const CERVICAL_MUCUS = new Set([
  "DRY",
  "STICKY",
  "CREAMY",
  "WATERY",
  "EGG_WHITE",
]);
const SECONDARY_SYMPTOMS = new Set(["MUCUS", "CERVIX"]);
const CERVIX_POSITIONS = new Set(["LOW", "HIGH"]);
const CERVIX_FIRMNESSES = new Set(["FIRM", "SOFT"]);
const CERVIX_OPENINGS = new Set(["CLOSED", "OPEN"]);
const HOME_TESTS = new Set(["NEGATIVE", "POSITIVE", "INDETERMINATE"]);
const CONTRACEPTIVES = new Set([
  "NONE",
  "UNSPECIFIED",
  "IMPLANT",
  "INJECTION",
  "IUD",
  "INTRAVAGINAL_RING",
  "ORAL",
  "PATCH",
  "EMERGENCY",
]);
const CYCLE_SOURCES = new Set(["MANUAL", "WITHINGS", "IMPORT", "APPLE_HEALTH"]);
const CYCLE_GOALS = new Set([
  "GENERAL_HEALTH",
  "AVOID_PREGNANCY",
  "TRYING_TO_CONCEIVE",
  "PERIMENOPAUSE",
  "OFF",
]);

function enumOrNull<T extends string>(
  value: string | null | undefined,
  allow: Set<string>,
): T | null {
  return value != null && allow.has(value) ? (value as T) : null;
}

/**
 * Restore the cycle tables for `ownerId` from a parsed backup payload,
 * inside an existing transaction. Delete-then-recreate, matching the
 * measurement/mood restore contract. Symptom links are re-resolved against
 * the seeded catalogue by key (unknown keys dropped). `notesEncrypted` is
 * written back as the ciphertext envelope verbatim — never re-encrypted.
 *
 * Returns the wiped counts for the audit trail. A pre-v1.15 payload (empty
 * cycle arrays + null profile) wipes nothing and recreates nothing.
 */
export async function restoreCycleData(
  tx: Prisma.TransactionClient,
  ownerId: string,
  payload: BackupPayload,
): Promise<CycleRestoreCleared> {
  // Wipe (child links cascade off the day-log delete).
  const dayLogs = await tx.cycleDayLog.deleteMany({
    where: { userId: ownerId },
  });
  const cycles = await tx.menstrualCycle.deleteMany({
    where: { userId: ownerId },
  });
  const profile = await tx.cycleProfile.deleteMany({
    where: { userId: ownerId },
  });

  // Recreate the profile (one row / user).
  if (payload.cycleProfile) {
    const p = payload.cycleProfile;
    await tx.cycleProfile.create({
      data: {
        userId: ownerId,
        goal: (enumOrNull(p.goal, CYCLE_GOALS) ?? "GENERAL_HEALTH") as never,
        cycleTrackingEnabled: p.cycleTrackingEnabled ?? null,
        typicalCycleLength: p.typicalCycleLength ?? null,
        typicalPeriodLength: p.typicalPeriodLength ?? null,
        lutealPhaseLength: p.lutealPhaseLength ?? null,
        secondarySymptom: (enumOrNull(p.secondarySymptom, SECONDARY_SYMPTOMS) ??
          "MUCUS") as never,
        predictionEnabled: p.predictionEnabled ?? true,
        rawChartMode: p.rawChartMode ?? false,
        discreetNotifications: p.discreetNotifications ?? false,
        sensitiveCategoryEncryption: p.sensitiveCategoryEncryption ?? true,
      },
    });
  }

  // Recreate observed cycle spans; map startDate → id so day-logs can
  // re-attach to their owning span.
  const cycleIdByStart = new Map<string, string>();
  for (const c of payload.cycles) {
    const created = await tx.menstrualCycle.create({
      data: {
        userId: ownerId,
        startDate: c.startDate,
        endDate: c.endDate ?? null,
        periodEndDate: c.periodEndDate ?? null,
        lengthDays: c.lengthDays ?? null,
        ovulationDate: c.ovulationDate ?? null,
        ovulationConfirmed: c.ovulationConfirmed ?? false,
        tz: c.tz ?? null,
        isPredicted: false,
      },
    });
    cycleIdByStart.set(c.startDate, created.id);
  }

  // Resolve the seeded symptom catalogue once for the link re-creation.
  const allKeys = Array.from(
    new Set(payload.cycleDayLogs.flatMap((d) => d.symptomKeys ?? [])),
  );
  const symptomIdByKey = new Map<string, string>();
  if (allKeys.length > 0) {
    const rows = await tx.cycleSymptom.findMany({
      where: {
        key: { in: allKeys },
        OR: [{ userId: null }, { userId: ownerId }],
      },
      select: { id: true, key: true },
    });
    for (const r of rows) symptomIdByKey.set(r.key, r.id);
  }

  // Recreate day-logs (with symptom links). The owning cycle is the latest
  // span whose start is on/before the day (the cycle-attribution rule).
  const sortedStarts = payload.cycles
    .map((c) => c.startDate)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const owningCycleId = (date: string): string | null => {
    let id: string | null = null;
    for (const start of sortedStarts) {
      if (start <= date) id = cycleIdByStart.get(start) ?? id;
      else break;
    }
    return id;
  };

  for (const d of payload.cycleDayLogs) {
    const symptomIds = (d.symptomKeys ?? [])
      .map((k) => symptomIdByKey.get(k))
      .filter((v): v is string => v !== undefined);
    await tx.cycleDayLog.create({
      data: {
        userId: ownerId,
        date: d.date,
        cycleId: owningCycleId(d.date),
        flow: enumOrNull(d.flow, FLOW_LEVELS) as never,
        intermenstrualBleeding: d.intermenstrualBleeding ?? false,
        basalBodyTempC: d.basalBodyTempC ?? null,
        temperatureExcluded: d.temperatureExcluded ?? false,
        ovulationTest: enumOrNull(d.ovulationTest, OVULATION_TESTS) as never,
        cervicalMucus: enumOrNull(d.cervicalMucus, CERVICAL_MUCUS) as never,
        cervixPosition: enumOrNull(
          d.cervixPosition,
          CERVIX_POSITIONS,
        ) as never,
        cervixFirmness: enumOrNull(
          d.cervixFirmness,
          CERVIX_FIRMNESSES,
        ) as never,
        cervixOpening: enumOrNull(d.cervixOpening, CERVIX_OPENINGS) as never,
        sexualActivity: d.sexualActivity ?? false,
        protectedSex: d.protectedSex ?? null,
        pregnancyTest: enumOrNull(d.pregnancyTest, HOME_TESTS) as never,
        progesteroneTest: enumOrNull(d.progesteroneTest, HOME_TESTS) as never,
        contraceptive: enumOrNull(d.contraceptive, CONTRACEPTIVES) as never,
        // Both ciphertext envelopes written back verbatim — never re-encrypted.
        sensitiveEncrypted: d.sensitiveEncrypted ?? null,
        notesEncrypted: d.notesEncrypted ?? null,
        source: (enumOrNull(d.source, CYCLE_SOURCES) ?? "MANUAL") as never,
        externalId: d.externalId ?? null,
        tz: d.tz ?? null,
        ...(symptomIds.length > 0
          ? {
              symptomLinks: {
                create: symptomIds.map((symptomId) => ({ symptomId })),
              },
            }
          : {}),
      },
    });
  }

  return {
    cycles: cycles.count,
    cycleDayLogs: dayLogs.count,
    cycleProfile: profile.count,
  };
}
