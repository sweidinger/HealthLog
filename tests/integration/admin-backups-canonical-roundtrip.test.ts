import { Buffer } from "node:buffer";

import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { encrypt, encryptBytes } from "@/lib/crypto";
import { encryptToBytes, decryptFromBytes } from "@/lib/ai/coach/bytes-codec";
import { buildRecordsBackupSection } from "@/lib/export/records-backup";
import { backupPayloadSchema } from "@/lib/validations/backup";
import { POST } from "@/app/api/admin/backups/[id]/restore/route";
import { invalidateUserData } from "@/lib/cache/invalidate";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => cookieJar.set(name, value),
      delete: (name: string) => cookieJar.delete(name),
    })),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserData: vi.fn(),
}));

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  vi.mocked(invalidateUserData).mockClear();
});

async function seedAdminSession() {
  const prisma = getPrismaClient();
  const admin = await prisma.user.create({
    data: {
      username: "canonical-restore-admin",
      email: "canonical-restore-admin@example.test",
      role: "ADMIN",
    },
  });
  const session = await prisma.session.create({
    data: {
      userId: admin.id,
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  cookieJar.set("healthlog_session", session.id);
  return admin;
}

function makeRequest(id: string) {
  return new Request(`http://localhost/api/admin/backups/${id}/restore`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirm: "RESTORE" }),
  });
}

describe("canonical disaster-recovery backup round-trip", () => {
  it("restores every serialized record class and document ciphertext verbatim", async () => {
    const prisma = getPrismaClient();
    const admin = await seedAdminSession();
    const ownerId = admin.id;

    const measurement = await prisma.measurement.create({
      data: {
        id: "measurement-dr",
        userId: ownerId,
        type: "WEIGHT",
        value: 72.4,
        unit: "kg",
        measuredAt: new Date("2026-07-01T07:00:00.000Z"),
        source: "MANUAL",
      },
    });

    const factorCategory = await prisma.moodTagCategory.create({
      data: {
        id: "category-dr",
        key: "dr_restore_factors",
        labelKey: "mood.tagCategory.drRestore",
      },
    });
    const factor = await prisma.moodTag.create({
      data: {
        id: "factor-dr",
        categoryId: factorCategory.id,
        key: "dr_sleep_quality",
        labelKey: "mood.tag.drSleepQuality",
        kind: "RATED",
        scaleMin: 1,
        scaleMax: 5,
      },
    });
    const mood = await prisma.moodEntry.create({
      data: {
        id: "mood-dr",
        userId: ownerId,
        date: "2026-07-01",
        mood: "GUT",
        score: 4,
        source: "MOODLOG",
        moodLoggedAt: new Date("2026-07-01T20:00:00.000Z"),
        tagLinks: {
          create: { moodTagId: factor.id, rating: 5 },
        },
      },
      include: {
        tagLinks: {
          select: { rating: true, moodTag: { select: { key: true } } },
        },
      },
    });

    const biomarker = await prisma.biomarker.create({
      data: {
        id: "biomarker-dr",
        userId: ownerId,
        name: "Ferritin",
        unit: "ng/mL",
        lowerBound: 30,
        upperBound: 300,
        panel: "Iron",
        contextEncrypted: encryptToBytes("Iron storage context"),
      },
    });
    const lab = await prisma.labResult.create({
      data: {
        id: "lab-dr",
        userId: ownerId,
        biomarkerId: biomarker.id,
        panel: "Iron",
        analyte: "Ferritin",
        value: 88,
        unit: "ng/mL",
        referenceLow: 30,
        referenceHigh: 300,
        takenAt: new Date("2026-06-30T09:00:00.000Z"),
        source: "MANUAL",
        noteEncrypted: encryptToBytes("Fasted"),
      },
    });

    const illness = await prisma.illnessEpisode.create({
      data: {
        id: "illness-dr",
        userId: ownerId,
        label: "Cold",
        type: "INFECTION",
        lifecycle: "ACUTE",
        onsetAt: new Date("2026-06-20T00:00:00.000Z"),
        resolvedAt: new Date("2026-06-24T00:00:00.000Z"),
        noteEncrypted: encryptToBytes("Recovered fully"),
      },
    });
    const symptom = await prisma.illnessSymptom.create({
      data: {
        id: "symptom-dr",
        key: "dr_cough",
        labelKey: "illness.symptom.drCough",
      },
    });
    const illnessDay = await prisma.illnessDayLog.create({
      data: {
        id: "illness-day-dr",
        userId: ownerId,
        episodeId: illness.id,
        date: "2026-06-21",
        functionalImpact: 2,
        feverC: 38.1,
        noteEncrypted: encryptToBytes("Rest day"),
        symptomLinks: {
          create: { symptomId: symptom.id, severity: 2 },
        },
      },
    });

    const allergy = await prisma.allergy.create({
      data: {
        id: "allergy-dr",
        userId: ownerId,
        substance: "Penicillin",
        category: "MEDICATION",
        type: "ALLERGY",
        severity: "SEVERE",
        status: "ACTIVE",
        onsetAt: new Date("2020-01-01T00:00:00.000Z"),
        reactionEncrypted: encryptToBytes("Hives"),
        notesEncrypted: encryptToBytes("Avoid beta-lactams"),
      },
    });
    const family = await prisma.familyHistoryEntry.create({
      data: {
        id: "family-dr",
        userId: ownerId,
        relationship: "MOTHER",
        condition: "Type 2 diabetes",
        ageAtOnset: 55,
        notesEncrypted: encryptToBytes("Diet controlled"),
      },
    });
    const workout = await prisma.workout.create({
      data: {
        id: "workout-dr",
        userId: ownerId,
        sportType: "RUNNING",
        startedAt: new Date("2026-06-29T06:00:00.000Z"),
        endedAt: new Date("2026-06-29T06:30:00.000Z"),
        durationSec: 1800,
        totalEnergyKcal: 250,
        totalDistanceM: 5000,
        avgHeartRate: 145,
        maxHeartRate: 170,
        source: "IMPORT",
        externalId: "run-external-dr",
      },
    });

    const encryptedBuffer = encryptBytes(Buffer.from("private PDF bytes"));
    const contentEncrypted = new Uint8Array(
      new ArrayBuffer(encryptedBuffer.byteLength),
    );
    contentEncrypted.set(encryptedBuffer);
    const summaryEncrypted = encryptToBytes("Encrypted summary");
    const document = await prisma.inboundDocument.create({
      data: {
        id: "document-dr",
        userId: ownerId,
        kind: "LAB_RESULT",
        title: "June labs",
        filename: "june-labs.pdf",
        mimeType: "application/pdf",
        byteSize: 17,
        contentEncrypted,
        contentSha256:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        contentCodec: "binary2",
        status: "EXTRACTED",
        providerType: "local",
        reportDate: new Date("2026-06-30T00:00:00.000Z"),
        documentDate: new Date("2026-06-30T00:00:00.000Z"),
        summaryEncrypted,
        summaryGeneratedAt: new Date("2026-07-01T08:00:00.000Z"),
        summaryState: "READY",
        createdAt: new Date("2026-07-01T07:30:00.000Z"),
        updatedAt: new Date("2026-07-01T08:00:00.000Z"),
      },
    });

    const records = await buildRecordsBackupSection(prisma, ownerId, {
      purpose: "disaster-recovery",
    });

    const payload = backupPayloadSchema.parse({
      schemaVersion: "1",
      exportedAt: "2026-07-02T00:00:00.000Z",
      userId: ownerId,
      measurements: [
        {
          type: measurement.type,
          value: measurement.value,
          unit: measurement.unit,
          measuredAt: measurement.measuredAt.toISOString(),
          source: measurement.source,
        },
      ],
      medications: [],
      intakeEvents: [],
      moodEntries: [
        {
          id: mood.id,
          date: mood.date,
          mood: mood.mood,
          score: mood.score,
          tags: mood.tags,
          source: mood.source,
          loggedAt: mood.moodLoggedAt.toISOString(),
          factors: mood.tagLinks.map((link) => ({
            key: link.moodTag.key,
            rating: link.rating,
          })),
        },
      ],
      labResults: records.labResults,
      biomarkers: records.biomarkers,
      illnessEpisodes: records.illnessEpisodes,
      allergies: records.allergies,
      familyHistory: records.familyHistory,
      workouts: records.workouts,
      documents: records.documents,
      manifest: records.manifest,
    });
    expect(payload.documents[0]).not.toHaveProperty("summary");
    expect(JSON.stringify(payload.documents[0])).not.toContain(
      "private PDF bytes",
    );

    await prisma.inboundDocument.deleteMany({ where: { userId: ownerId } });
    await prisma.workout.deleteMany({ where: { userId: ownerId } });
    await prisma.familyHistoryEntry.deleteMany({ where: { userId: ownerId } });
    await prisma.allergy.deleteMany({ where: { userId: ownerId } });
    await prisma.illnessEpisode.deleteMany({ where: { userId: ownerId } });
    await prisma.labResult.deleteMany({ where: { userId: ownerId } });
    await prisma.biomarker.deleteMany({ where: { userId: ownerId } });

    const backup = await prisma.dataBackup.create({
      data: {
        userId: ownerId,
        type: "CANONICAL_DR_ROUND_TRIP",
        data: encrypt(JSON.stringify(payload)),
      },
    });

    const restore = async () =>
      POST(makeRequest(backup.id) as unknown as Parameters<typeof POST>[0], {
        params: Promise.resolve({ id: backup.id }),
      });

    expect((await restore()).status).toBe(200);

    expect(await prisma.labResult.count({ where: { userId: ownerId } })).toBe(1);
    expect(await prisma.biomarker.count({ where: { userId: ownerId } })).toBe(1);
    expect(await prisma.illnessEpisode.count({ where: { userId: ownerId } })).toBe(1);
    expect(await prisma.illnessDayLog.count({ where: { userId: ownerId } })).toBe(1);
    expect(await prisma.allergy.count({ where: { userId: ownerId } })).toBe(1);
    expect(await prisma.familyHistoryEntry.count({ where: { userId: ownerId } })).toBe(1);
    expect(await prisma.workout.count({ where: { userId: ownerId } })).toBe(1);
    expect(await prisma.inboundDocument.count({ where: { userId: ownerId } })).toBe(1);
    expect(
      await prisma.measurement.findMany({
        where: { userId: ownerId },
        select: {
          type: true,
          value: true,
          unit: true,
          measuredAt: true,
          source: true,
        },
      }),
    ).toEqual([
      {
        type: measurement.type,
        value: measurement.value,
        unit: measurement.unit,
        measuredAt: measurement.measuredAt,
        source: measurement.source,
      },
    ]);

    const restoredLab = await prisma.labResult.findUniqueOrThrow({
      where: { id: lab.id },
    });
    expect(decryptFromBytes(restoredLab.noteEncrypted!)).toBe("Fasted");
    expect(restoredLab.biomarkerId).toBe(biomarker.id);
    expect(restoredLab).toEqual(
      expect.objectContaining({
        panel: lab.panel,
        analyte: lab.analyte,
        value: lab.value,
        unit: lab.unit,
        referenceLow: lab.referenceLow,
        referenceHigh: lab.referenceHigh,
        takenAt: lab.takenAt,
        source: lab.source,
      }),
    );
    const restoredBiomarker = await prisma.biomarker.findUniqueOrThrow({
      where: { id: biomarker.id },
    });
    expect(restoredBiomarker).toEqual(
      expect.objectContaining({
        name: biomarker.name,
        unit: biomarker.unit,
        lowerBound: biomarker.lowerBound,
        upperBound: biomarker.upperBound,
        panel: biomarker.panel,
        hidden: biomarker.hidden,
      }),
    );
    expect(decryptFromBytes(restoredBiomarker.contextEncrypted!)).toBe(
      "Iron storage context",
    );

    const restoredIllness = await prisma.illnessEpisode.findUniqueOrThrow({
      where: { id: illness.id },
    });
    expect(restoredIllness).toEqual(
      expect.objectContaining({
        label: illness.label,
        type: illness.type,
        lifecycle: illness.lifecycle,
        onsetAt: illness.onsetAt,
        resolvedAt: illness.resolvedAt,
      }),
    );
    expect(decryptFromBytes(restoredIllness.noteEncrypted!)).toBe(
      "Recovered fully",
    );
    const restoredIllnessDay = await prisma.illnessDayLog.findUniqueOrThrow({
      where: { id: illnessDay.id },
      include: { symptomLinks: true },
    });
    expect(decryptFromBytes(restoredIllnessDay.noteEncrypted!)).toBe("Rest day");
    expect(restoredIllnessDay.symptomLinks).toEqual([
      expect.objectContaining({ symptomId: symptom.id, severity: 2 }),
    ]);

    const restoredAllergy = await prisma.allergy.findUniqueOrThrow({
      where: { id: allergy.id },
    });
    expect(decryptFromBytes(restoredAllergy.reactionEncrypted!)).toBe("Hives");
    expect(restoredAllergy).toEqual(
      expect.objectContaining({
        substance: allergy.substance,
        category: allergy.category,
        type: allergy.type,
        severity: allergy.severity,
        status: allergy.status,
        onsetAt: allergy.onsetAt,
      }),
    );
    const restoredFamily = await prisma.familyHistoryEntry.findUniqueOrThrow({
      where: { id: family.id },
    });
    expect(decryptFromBytes(restoredFamily.notesEncrypted!)).toBe(
      "Diet controlled",
    );
    expect(restoredFamily).toEqual(
      expect.objectContaining({
        relationship: family.relationship,
        condition: family.condition,
        ageAtOnset: family.ageAtOnset,
      }),
    );
    expect(
      await prisma.workout.findUniqueOrThrow({ where: { id: workout.id } }),
    ).toEqual(
      expect.objectContaining({
        sportType: workout.sportType,
        startedAt: workout.startedAt,
        endedAt: workout.endedAt,
        durationSec: workout.durationSec,
        totalEnergyKcal: workout.totalEnergyKcal,
        totalDistanceM: workout.totalDistanceM,
        avgHeartRate: workout.avgHeartRate,
        maxHeartRate: workout.maxHeartRate,
        source: workout.source,
        externalId: workout.externalId,
      }),
    );

    const restoredDocument = await prisma.inboundDocument.findUniqueOrThrow({
      where: { id: document.id },
    });
    expect(Buffer.from(restoredDocument.contentEncrypted)).toEqual(
      Buffer.from(document.contentEncrypted),
    );
    expect(Buffer.from(restoredDocument.summaryEncrypted!)).toEqual(
      Buffer.from(document.summaryEncrypted!),
    );
    expect(restoredDocument).toEqual(
      expect.objectContaining({
        title: document.title,
        filename: document.filename,
        mimeType: document.mimeType,
        byteSize: document.byteSize,
        contentSha256: document.contentSha256,
        contentCodec: document.contentCodec,
        status: document.status,
        providerType: document.providerType,
        summaryState: document.summaryState,
        reportDate: document.reportDate,
        documentDate: document.documentDate,
        errorReason: document.errorReason,
        summaryGeneratedAt: document.summaryGeneratedAt,
        createdAt: document.createdAt,
        updatedAt: document.updatedAt,
      }),
    );

    const restoredMood = await prisma.moodEntry.findUniqueOrThrow({
      where: { id: mood.id },
      include: {
        tagLinks: {
          include: { moodTag: { select: { key: true } } },
        },
      },
    });
    expect(restoredMood).toEqual(
      expect.objectContaining({
        date: mood.date,
        mood: mood.mood,
        score: mood.score,
        source: mood.source,
        moodLoggedAt: mood.moodLoggedAt,
      }),
    );
    expect(restoredMood.tagLinks).toEqual([
      expect.objectContaining({
        rating: 5,
        moodTag: { key: "dr_sleep_quality" },
      }),
    ]);

    expect((await restore()).status).toBe(200);
    expect(
      await prisma.inboundDocument.findMany({
        where: { userId: ownerId },
        select: { id: true },
      }),
    ).toEqual([{ id: document.id }]);
    expect(
      await prisma.workout.findMany({
        where: { userId: ownerId },
        select: { id: true },
      }),
    ).toEqual([{ id: workout.id }]);
    expect(
      await prisma.labResult.findMany({
        where: { userId: ownerId },
        select: { id: true },
      }),
    ).toEqual([{ id: lab.id }]);
    expect(
      await prisma.illnessEpisode.findMany({
        where: { userId: ownerId },
        select: { id: true },
      }),
    ).toEqual([{ id: illness.id }]);
  });

  it("rejects metadata-only documents before mutation or invalidation", async () => {
    const prisma = getPrismaClient();
    const admin = await seedAdminSession();
    await prisma.measurement.create({
      data: {
        userId: admin.id,
        type: "WEIGHT",
        value: 91,
        unit: "kg",
        source: "MANUAL",
        measuredAt: new Date("2026-07-03T07:00:00.000Z"),
      },
    });
    const payload = backupPayloadSchema.parse({
      schemaVersion: "1",
      exportedAt: "2026-07-03T08:00:00.000Z",
      userId: admin.id,
      measurements: [],
      moodEntries: [],
      documents: [
        {
          id: "metadata-only-document",
          kind: "OTHER",
          title: null,
          filename: "metadata.pdf",
          mimeType: "application/pdf",
          byteSize: 12,
          status: "STORED",
          reportDate: null,
          documentDate: null,
          summary: null,
          createdAt: "2026-07-03T08:00:00.000Z",
        },
      ],
      manifest: {
        documents: { included: "metadata-only", note: "Portable export" },
        workouts: { included: "summary-only", note: "Summary only" },
      },
    });
    const backup = await prisma.dataBackup.create({
      data: {
        userId: admin.id,
        type: "PORTABLE_METADATA_ONLY",
        data: encrypt(JSON.stringify(payload)),
      },
    });

    const response = await POST(
      makeRequest(backup.id) as unknown as Parameters<typeof POST>[0],
      { params: Promise.resolve({ id: backup.id }) },
    );

    expect(response.status).toBe(422);
    expect(
      await prisma.measurement.count({ where: { userId: admin.id } }),
    ).toBe(1);
    expect(invalidateUserData).not.toHaveBeenCalled();
  });

  it("rolls back a failed full restore before invalidating caches", async () => {
    const prisma = getPrismaClient();
    const admin = await seedAdminSession();
    const measurement = await prisma.measurement.create({
      data: {
        userId: admin.id,
        type: "WEIGHT",
        value: 91,
        unit: "kg",
        source: "MANUAL",
        measuredAt: new Date("2026-07-04T07:00:00.000Z"),
      },
    });
    const payload = backupPayloadSchema.parse({
      schemaVersion: "1",
      exportedAt: "2026-07-04T08:00:00.000Z",
      userId: admin.id,
      measurements: [],
      moodEntries: [
        {
          id: "failed-restore-mood",
          date: "2026-07-04",
          mood: "OKAY",
          score: 3,
          tags: null,
          loggedAt: "2026-07-04T08:00:00.000Z",
          factors: [{ key: "missing-backup-factor", rating: 4 }],
        },
      ],
    });
    const backup = await prisma.dataBackup.create({
      data: {
        userId: admin.id,
        type: "FAILED_FULL_RESTORE",
        data: encrypt(JSON.stringify(payload)),
      },
    });

    const response = await POST(
      makeRequest(backup.id) as unknown as Parameters<typeof POST>[0],
      { params: Promise.resolve({ id: backup.id }) },
    );

    expect(response.status).toBe(500);
    expect(
      await prisma.measurement.findMany({
        where: { userId: admin.id },
        select: { id: true },
      }),
    ).toEqual([{ id: measurement.id }]);
    expect(
      await prisma.moodEntry.count({ where: { userId: admin.id } }),
    ).toBe(0);
    expect(invalidateUserData).not.toHaveBeenCalled();
  });
});
