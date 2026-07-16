/**
 * Issue #486 — the Apple `export.zip` importer must survive two samples that
 * share the `measurements` natural key `(userId, type, measuredAt, source,
 * sleepStage)` (migration 0055, NULLS NOT DISTINCT) while carrying DIFFERENT
 * externalIds. This is a real DB-constraint contract — the collision only
 * surfaces against Postgres, not the in-memory unit fake — so it is pinned
 * here against the testcontainer.
 *
 * Pre-fix: the externalId upsert misses on the second sample, its create leg
 * collides on the natural key, Prisma throws P2002, and the whole import
 * aborts after minutes of work. Post-fix: the natural-key rescue adopts the
 * occupied row in place and the run completes.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { beforeEach, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { streamParseExportXml } from "@/lib/measurements/import-apple-health-export";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

async function createUser(username: string) {
  return getPrismaClient().user.create({
    data: { username, email: `${username}@example.test`, role: "USER" },
  });
}

function writeXml(records: string): string {
  const tmp = mkdtempSync(join(tmpdir(), "healthlog-import-nk-"));
  const xmlPath = join(tmp, "export.xml");
  writeFileSync(
    xmlPath,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE HealthData [<!ELEMENT HealthData (Record)*>]>
<HealthData locale="en_US">
${records}
</HealthData>`,
  );
  return xmlPath;
}

// Both records share `endDate` (→ same `measuredAt`, the natural key) but
// differ in `startDate`/`value` (→ different `hashSampleKey` externalId).
const COLLIDING_RECORDS = `  <Record type="HKQuantityTypeIdentifierBodyMass"
          unit="kg"
          startDate="2026-05-14 08:10:00 +0200"
          endDate="2026-05-14 08:14:00 +0200"
          value="78.4"
          sourceName="Source App A"/>
  <Record type="HKQuantityTypeIdentifierBodyMass"
          unit="kg"
          startDate="2026-05-14 08:12:00 +0200"
          endDate="2026-05-14 08:14:00 +0200"
          value="78.6"
          sourceName="Source App B"/>`;

describe("Apple Health import — natural-key collision (issue #486)", () => {
  it("completes against real Postgres and lands exactly one adopted row", async () => {
    const prisma = getPrismaClient();
    const user = await createUser("import-nk-collide");

    const result = await streamParseExportXml({
      xmlPath: writeXml(COLLIDING_RECORDS),
      userId: user.id,
      userTimezone: "Europe/Berlin",
      prisma,
    });

    expect(result.perType.WEIGHT?.read).toBe(2);
    expect(result.perType.WEIGHT?.inserted).toBe(1);
    expect(result.perType.WEIGHT?.updated).toBe(1);
    expect(result.unknown["WEIGHT::natural_key_unresolved"]).toBeUndefined();

    const rows = await prisma.measurement.findMany({
      where: { userId: user.id, type: "WEIGHT", source: "APPLE_HEALTH" },
    });
    expect(rows).toHaveLength(1);
    // Last write wins — the second sample's value was adopted onto the row.
    expect(rows[0]?.value).toBe(78.6);
  });

  it("re-import with a re-keyed externalId adopts the prior row, no duplicate", async () => {
    const prisma = getPrismaClient();
    const user = await createUser("import-nk-reimport");

    const first = await streamParseExportXml({
      xmlPath: writeXml(
        `  <Record type="HKQuantityTypeIdentifierBodyMass"
          unit="kg"
          startDate="2026-05-14 08:10:00 +0200"
          endDate="2026-05-14 08:14:00 +0200"
          value="78.4"/>`,
      ),
      userId: user.id,
      userTimezone: "Europe/Berlin",
      prisma,
    });
    expect(first.perType.WEIGHT?.inserted).toBe(1);

    // Re-export: same instant (endDate) but a different start window →
    // re-keyed externalId. The externalId upsert misses; the natural key is
    // still held by the first row.
    const second = await streamParseExportXml({
      xmlPath: writeXml(
        `  <Record type="HKQuantityTypeIdentifierBodyMass"
          unit="kg"
          startDate="2026-05-14 08:11:30 +0200"
          endDate="2026-05-14 08:14:00 +0200"
          value="79.0"/>`,
      ),
      userId: user.id,
      userTimezone: "Europe/Berlin",
      prisma,
    });

    expect(second.perType.WEIGHT?.inserted).toBe(0);
    expect(second.perType.WEIGHT?.updated).toBe(1);

    const rows = await prisma.measurement.findMany({
      where: { userId: user.id, type: "WEIGHT", source: "APPLE_HEALTH" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe(79.0);
  });

  it("resurrects a soft-deleted row that holds the natural key", async () => {
    const prisma = getPrismaClient();
    const user = await createUser("import-nk-tombstone");

    // Seed a TOMBSTONED WEIGHT row that already occupies the natural key with
    // some legacy externalId. A tombstone still holds the 0055 key, so a blind
    // create would P2002 forever ("erased re-keyed sleep" wedge class).
    const measuredAt = new Date("2026-05-14T06:14:00.000Z");
    await prisma.measurement.create({
      data: {
        userId: user.id,
        type: "WEIGHT",
        value: 70.0,
        unit: "kg",
        source: "APPLE_HEALTH",
        measuredAt,
        externalId: "sample:legacy-tombstoned-id",
        deletedAt: new Date(),
      },
    });

    const result = await streamParseExportXml({
      xmlPath: writeXml(
        `  <Record type="HKQuantityTypeIdentifierBodyMass"
          unit="kg"
          startDate="2026-05-14 08:10:00 +0200"
          endDate="2026-05-14 08:14:00 +0200"
          value="80.0"/>`,
      ),
      userId: user.id,
      userTimezone: "Europe/Berlin",
      prisma,
    });

    expect(result.perType.WEIGHT?.updated).toBe(1);

    const rows = await prisma.measurement.findMany({
      where: { userId: user.id, type: "WEIGHT", source: "APPLE_HEALTH" },
    });
    expect(rows).toHaveLength(1);
    // Adopted: value updated, tombstone lifted (resurrected).
    expect(rows[0]?.value).toBe(80.0);
    expect(rows[0]?.deletedAt).toBeNull();
  });
});
