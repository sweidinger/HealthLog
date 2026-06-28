/**
 * Round-trip + paging contract for the backup measurement reader.
 *
 * Runs without a database: the keyset pager takes a `fetchPage` callback,
 * so an in-memory fixture stands in for Prisma. This pins the two things
 * the heap-bounding refactor must not break:
 *   1. the keyset scan visits every row exactly once, in id order,
 *      across page boundaries and the exact-multiple edge case;
 *   2. a measurement survives the full serialize → encrypt-blob shape →
 *      `parseBackupPayload` → restore-mapping round-trip unchanged,
 *      including a soft-deleted (tombstoned) row, which both writers keep.
 */
import { describe, it, expect } from "vitest";
import {
  collectPagedMeasurements,
  toWeeklyBackupMeasurement,
  sortWeeklyMeasurementsDesc,
  type WeeklyMeasurementRow,
} from "@/lib/jobs/backup/measurement-page";
import { parseBackupPayload } from "@/lib/validations/backup";

/** Build an id-ascending fixture; `id` is zero-padded so string order == insert order. */
function makeRows(n: number): WeeklyMeasurementRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${String(i).padStart(4, "0")}`,
    type: "WEIGHT",
    value: 70 + i,
    unit: "kg",
    source: "MANUAL",
    measuredAt: new Date(Date.UTC(2026, 0, 1 + i, 8, 0, 0)),
    notes: i % 2 === 0 ? `note ${i}` : null,
    // notesEncrypted left null so readNote returns the plaintext fallback
    // and the pure test needs no encryption key.
    notesEncrypted: null,
  }));
}

/** In-memory keyset fetcher over an id-sorted fixture. */
function fakeFetcher(rows: WeeklyMeasurementRow[]) {
  const sorted = [...rows].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  return (afterId: string | null, take: number) => {
    const start = afterId ? sorted.findIndex((r) => r.id === afterId) + 1 : 0;
    return Promise.resolve(sorted.slice(start, start + take));
  };
}

describe("collectPagedMeasurements", () => {
  it("visits every row exactly once, in id order, across pages", async () => {
    const rows = makeRows(25);
    const out = await collectPagedMeasurements({
      fetchPage: fakeFetcher(rows),
      project: (r) => r.id,
      pageSize: 10,
    });
    expect(out).toEqual(rows.map((r) => r.id));
    expect(new Set(out).size).toBe(out.length);
  });

  it("terminates on the exact-multiple boundary without dropping rows", async () => {
    const rows = makeRows(20);
    const out = await collectPagedMeasurements({
      fetchPage: fakeFetcher(rows),
      project: (r) => r.id,
      pageSize: 10,
    });
    expect(out).toHaveLength(20);
    expect(out[out.length - 1]).toBe("m0019");
  });

  it("handles an empty set", async () => {
    const out = await collectPagedMeasurements({
      fetchPage: fakeFetcher([]),
      project: (r) => r.id,
      pageSize: 10,
    });
    expect(out).toEqual([]);
  });
});

describe("weekly backup measurement round-trip", () => {
  it("serialize → parseBackupPayload → restore-map equals originals", async () => {
    const rows: WeeklyMeasurementRow[] = [
      {
        id: "m0001",
        type: "WEIGHT",
        value: 82.4,
        unit: "kg",
        source: "MANUAL",
        measuredAt: new Date("2026-02-10T07:30:00.000Z"),
        notes: "morning",
        notesEncrypted: null,
      },
      {
        id: "m0002",
        type: "PULSE",
        value: 58,
        unit: "bpm",
        source: "WITHINGS",
        measuredAt: new Date("2026-02-11T06:00:00.000Z"),
        notes: null,
        notesEncrypted: null,
      },
      {
        // A tombstoned row: the weekly writer applies no deletedAt filter,
        // so a soft-deleted measurement is still backed up. The narrow
        // weekly projection does not carry deletedAt (the restore does not
        // recreate it), but the row must still appear in the payload.
        id: "m0003",
        type: "BLOOD_GLUCOSE",
        value: 95,
        unit: "mg/dL",
        source: "IMPORT",
        measuredAt: new Date("2026-02-12T12:00:00.000Z"),
        notes: "fasting",
        notesEncrypted: null,
      },
    ];

    const measurements = sortWeeklyMeasurementsDesc(
      await collectPagedMeasurements({
        fetchPage: fakeFetcher(rows),
        project: toWeeklyBackupMeasurement,
        pageSize: 2,
      }),
    );

    // Same envelope the writer produces, then parse it back exactly as the
    // admin restore route does.
    const backupJson = JSON.stringify({
      schemaVersion: "1",
      exportedAt: new Date("2026-02-13T00:00:00.000Z").toISOString(),
      userId: "user-1",
      measurements,
      medications: [],
      intakeEvents: [],
      moodEntries: [],
    });
    const payload = parseBackupPayload(backupJson);

    expect(payload.measurements).toHaveLength(rows.length);

    // measuredAt-desc ordering preserved (newest first).
    expect(payload.measurements.map((m) => m.measuredAt)).toEqual([
      "2026-02-12T12:00:00.000Z",
      "2026-02-11T06:00:00.000Z",
      "2026-02-10T07:30:00.000Z",
    ]);

    // Every original row survives the round-trip by value (the tombstoned
    // m0003 included).
    for (const original of rows) {
      const restored = payload.measurements.find(
        (m) => m.measuredAt === original.measuredAt.toISOString(),
      );
      expect(restored, `row ${original.id} missing from payload`).toBeDefined();
      expect(restored!.type).toBe(original.type);
      expect(restored!.value).toBe(original.value);
      expect(restored!.unit).toBe(original.unit);
      expect(restored!.source).toBe(original.source);
      expect(restored!.notes ?? null).toBe(original.notes ?? null);
    }
  });
});

describe("offhost backup measurement round-trip", () => {
  it("full-row JSON dump → parse preserves all columns incl. soft-deleted", async () => {
    // The off-host DR dump keeps the full row shape (identity projection).
    // Mirror the writer's select output for a live row and a tombstoned row.
    const liveRow = {
      id: "m0001",
      userId: "user-1",
      type: "WEIGHT",
      value: 80.1,
      valueMin: null,
      valueMax: null,
      unit: "kg",
      source: "MANUAL",
      measuredAt: new Date("2026-03-01T07:00:00.000Z"),
      notes: null,
      notesEncrypted: null,
      externalId: null,
      externalSourceVersion: null,
      glucoseContext: null,
      sleepStage: null,
      rhythmClassification: null,
      deviceType: "scale",
      syncVersion: 1,
      deletedAt: null,
      createdAt: new Date("2026-03-01T07:00:01.000Z"),
      updatedAt: new Date("2026-03-01T07:00:01.000Z"),
    };
    const tombstonedRow = {
      ...liveRow,
      id: "m0002",
      value: 81.2,
      measuredAt: new Date("2026-03-02T07:00:00.000Z"),
      deletedAt: new Date("2026-03-03T09:00:00.000Z"),
    };

    const measurements = await collectPagedMeasurements({
      fetchPage: fakeFetcher([
        liveRow,
        tombstonedRow,
      ] as unknown as WeeklyMeasurementRow[]),
      project: (row) => row,
      pageSize: 1,
    });

    const payload = JSON.parse(
      JSON.stringify({
        exportedAt: new Date("2026-03-04T00:00:00.000Z").toISOString(),
        userId: "user-1",
        measurements,
        medications: [],
        intakeEvents: [],
        moodEntries: [],
        cycleProfile: null,
        cycles: [],
        cycleDayLogs: [],
      }),
    ) as { measurements: Array<Record<string, unknown>> };

    expect(payload.measurements).toHaveLength(2);

    // The soft-deleted row survives with its tombstone instant intact —
    // the DR snapshot must include it.
    const restoredTombstone = payload.measurements.find(
      (m) => m.id === "m0002",
    )!;
    expect(restoredTombstone.deletedAt).toBe("2026-03-03T09:00:00.000Z");

    // Every scalar column the writer selected is present on the dump.
    const expectedKeys = Object.keys(liveRow).sort();
    expect(Object.keys(payload.measurements[0]).sort()).toEqual(expectedKeys);
  });
});
