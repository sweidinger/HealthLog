/**
 * v1.12.1 — partial live-row unique index on MedicationIntakeEvent
 * (migration 0121) + MoodEntry external-id dedup key (migration 0122).
 *
 * These pin the delete-then-resync / re-import contracts on real
 * Postgres, against the migrations replayed by `global-setup.ts`.
 *
 *   1. MedicationIntakeEvent — the real re-take path through
 *      `applyCanonicalSlotWrite`: take a slot, soft-delete it (user
 *      "forgot this"), then re-take the SAME canonical slot. Pre-0121
 *      the create P2002'd against the tombstone and the catch re-found
 *      only live rows (none) and re-threw — the re-take 500'd. With the
 *      partial live-row unique it re-creates cleanly.
 *
 *   2. MoodEntry — a moodLog re-import with the SAME stable `id` but a
 *      re-zoned `moodLoggedAt` updates one row (idempotent on
 *      `(userId, source, externalId)`), while two imports WITHOUT an id
 *      still land two rows on the legacy wall-clock key.
 *
 * Note: Measurement is intentionally NOT made partial-unique (its
 * compound-key writes use `prisma.upsert` → native ON CONFLICT, which
 * Postgres cannot arbiter against a partial unique). See migration 0121's
 * header for the full rationale.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { applyCanonicalSlotWrite } from "@/lib/medications/scheduling/slot-upsert";

import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

describe("MedicationIntakeEvent — re-take after delete (v1.12.1 / 0121)", () => {
  it("re-takes a previously-deleted slot without 500-ing", async () => {
    const prisma = getPrismaClient();
    const user = await prisma.user.create({
      data: {
        username: "partial-intake",
        email: "partial-intake@example.test",
        role: "USER",
      },
    });
    const med = await prisma.medication.create({
      data: { userId: user.id, name: "Ramipril", dose: "5mg" },
    });

    const slot = new Date("2026-06-03T06:00:00.000Z");

    // First take — fresh slot.
    const firstTake = await applyCanonicalSlotWrite({
      client: prisma,
      userId: user.id,
      medicationId: med.id,
      canonicalSlot: slot,
      takenAt: new Date("2026-06-03T06:05:00.000Z"),
      skipped: false,
      isExplicitTaken: true,
      isExplicitSkip: false,
      idempotencyKey: null,
      createSource: "WEB",
    });
    expect(firstTake.outcome).toBe("inserted");
    expect(firstTake.row.takenAt).not.toBeNull();

    // User deletes the take (soft-delete the slot row).
    await prisma.medicationIntakeEvent.update({
      where: { id: firstTake.row.id },
      data: { deletedAt: new Date(), syncVersion: { increment: 1 } },
    });

    // Re-take the SAME canonical slot. Pre-0121 this threw the original
    // P2002 (tombstone occupied (user, med, scheduled_for, source)).
    const reTake = await applyCanonicalSlotWrite({
      client: prisma,
      userId: user.id,
      medicationId: med.id,
      canonicalSlot: slot,
      takenAt: new Date("2026-06-03T06:10:00.000Z"),
      skipped: false,
      isExplicitTaken: true,
      isExplicitSkip: false,
      idempotencyKey: null,
      createSource: "WEB",
    });
    expect(reTake.outcome).toBe("inserted");
    expect(reTake.row.id).not.toBe(firstTake.row.id);
    expect(reTake.row.takenAt).not.toBeNull();

    // Exactly one LIVE slot row; the tombstone remains.
    const live = await prisma.medicationIntakeEvent.findMany({
      where: {
        userId: user.id,
        medicationId: med.id,
        scheduledFor: slot,
        deletedAt: null,
      },
    });
    expect(live).toHaveLength(1);
    expect(live[0].id).toBe(reTake.row.id);

    // The live-row partial unique still forbids a SECOND live duplicate
    // on the same (user, med, slot, source).
    await expect(
      prisma.medicationIntakeEvent.create({
        data: {
          userId: user.id,
          medicationId: med.id,
          scheduledFor: slot,
          source: "WEB",
        },
      }),
    ).rejects.toThrow();
  });
});

describe("MoodEntry — external-id re-import idempotency (v1.12.1 / 0122)", () => {
  function webhookRequest(secret: string, body: unknown): NextRequest {
    return new NextRequest(
      "http://localhost/api/integrations/moodlog/webhook",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-secret": secret,
        },
        body: JSON.stringify(body),
      },
    );
  }

  it("re-import with the same stable id but re-zoned time updates one row", async () => {
    const prisma = getPrismaClient();
    const secret = "mood-secret-idempotent";
    const user = await prisma.user.create({
      data: {
        username: "mood-external-id",
        email: "mood-external-id@example.test",
        role: "USER",
        moodLogEnabled: true,
        // Legacy plaintext secret — readMoodLogSecret tolerates it.
        moodLogWebhookSecret: secret,
      },
    });

    const { POST } =
      await import("@/app/api/integrations/moodlog/webhook/route");

    // First import — entry carries a stable upstream id.
    const r1 = await POST(
      webhookRequest(secret, {
        event: "mood.created",
        timestamp: "2026-06-04T10:00:00.000Z",
        entry: {
          id: "daylio-row-42",
          date: "2026-06-04",
          time: "2026-06-04T10:00:00.000Z",
          mood: "GUT",
          score: 4,
        },
      }),
    );
    expect(r1.status).toBe(200);

    // Re-import — SAME id, but a re-rounded / re-zoned time (and the
    // upstream re-scored the mood). Pre-0122 this minted a 2nd row on
    // the differing (date, moodLoggedAt) key.
    const r2 = await POST(
      webhookRequest(secret, {
        event: "mood.updated",
        timestamp: "2026-06-04T10:30:00.000Z",
        entry: {
          id: "daylio-row-42",
          date: "2026-06-04",
          time: "2026-06-04T08:00:00.000Z",
          mood: "SUPER_GUT",
          score: 5,
        },
      }),
    );
    expect(r2.status).toBe(200);

    const rows = await prisma.moodEntry.findMany({
      where: { userId: user.id, source: "MOODLOG" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].externalId).toBe("daylio-row-42");
    // The update applied (mood + score + re-zoned time).
    expect(rows[0].mood).toBe("SUPER_GUT");
    expect(rows[0].score).toBe(5);
  });

  it("acknowledges an exact provider replay with one stable durable row", async () => {
    const prisma = getPrismaClient();
    const secret = "mood-secret-replay";
    const user = await prisma.user.create({
      data: {
        username: "mood-provider-replay",
        email: "mood-provider-replay@example.test",
        role: "USER",
        moodLogEnabled: true,
        moodLogWebhookSecret: secret,
      },
    });
    const { POST } =
      await import("@/app/api/integrations/moodlog/webhook/route");
    const payload = {
      event: "mood.created",
      timestamp: "2026-06-04T11:00:00.000Z",
      entry: {
        id: "provider-event-replay-1",
        date: "2026-06-04",
        time: "2026-06-04T11:00:00.000Z",
        mood: "GUT",
        score: 4,
      },
    };

    const first = await POST(webhookRequest(secret, payload));
    expect(first.status).toBe(200);
    const firstRow = await prisma.moodEntry.findUniqueOrThrow({
      where: {
        userId_source_externalId: {
          userId: user.id,
          source: "MOODLOG",
          externalId: "provider-event-replay-1",
        },
      },
    });

    const replay = await POST(webhookRequest(secret, payload));
    expect(replay.status).toBe(200);
    const rows = await prisma.moodEntry.findMany({
      where: { userId: user.id, source: "MOODLOG" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(firstRow.id);
  });

  it("adopts a legacy natural-key row when a replay gains a provider id", async () => {
    const prisma = getPrismaClient();
    const secret = "mood-secret-key-upgrade";
    const user = await prisma.user.create({
      data: {
        username: "mood-key-upgrade",
        email: "mood-key-upgrade@example.test",
        role: "USER",
        moodLogEnabled: true,
        moodLogWebhookSecret: secret,
      },
    });
    const { POST } =
      await import("@/app/api/integrations/moodlog/webhook/route");
    const entry = {
      date: "2026-06-04",
      time: "2026-06-04T12:00:00.000Z",
      mood: "GUT",
      score: 4,
    };

    const legacy = await POST(
      webhookRequest(secret, {
        event: "mood.created",
        timestamp: "2026-06-04T12:00:00.000Z",
        entry,
      }),
    );
    expect(legacy.status).toBe(200);
    const legacyRow = await prisma.moodEntry.findFirstOrThrow({
      where: { userId: user.id, source: "MOODLOG" },
    });
    expect(legacyRow.externalId).toBeNull();

    const upgraded = await POST(
      webhookRequest(secret, {
        event: "mood.updated",
        timestamp: "2026-06-04T12:05:00.000Z",
        entry: { ...entry, id: "provider-key-upgrade-1" },
      }),
    );
    expect(upgraded.status).toBe(200);

    const rows = await prisma.moodEntry.findMany({
      where: { userId: user.id, source: "MOODLOG" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(legacyRow.id);
    expect(rows[0].externalId).toBe("provider-key-upgrade-1");
  });

  it("does not adopt an unrelated row that occupies the natural key", async () => {
    const prisma = getPrismaClient();
    const secret = "mood-secret-unrelated-collision";
    const user = await prisma.user.create({
      data: {
        username: "mood-unrelated-collision",
        email: "mood-unrelated-collision@example.test",
        role: "USER",
        moodLogEnabled: true,
        moodLogWebhookSecret: secret,
      },
    });
    const moodLoggedAt = new Date("2026-06-04T13:00:00.000Z");
    const manual = await prisma.moodEntry.create({
      data: {
        userId: user.id,
        date: "2026-06-04",
        moodLoggedAt,
        mood: "OKAY",
        score: 3,
        source: "MANUAL",
      },
    });
    const { POST } =
      await import("@/app/api/integrations/moodlog/webhook/route");

    const response = await POST(
      webhookRequest(secret, {
        event: "mood.created",
        timestamp: "2026-06-04T13:00:00.000Z",
        entry: {
          id: "provider-unrelated-collision-1",
          date: "2026-06-04",
          time: moodLoggedAt.toISOString(),
          mood: "GUT",
          score: 4,
        },
      }),
    );
    expect(response.status).toBe(503);

    const row = await prisma.moodEntry.findUniqueOrThrow({
      where: { id: manual.id },
    });
    expect(row).toMatchObject({
      source: "MANUAL",
      externalId: null,
      mood: "OKAY",
      score: 3,
    });
    expect(await prisma.moodEntry.count({ where: { userId: user.id } })).toBe(1);
  });

  it("entries without an id still dedup on the legacy wall-clock key", async () => {
    const prisma = getPrismaClient();
    const secret = "mood-secret-legacy";
    const user = await prisma.user.create({
      data: {
        username: "mood-legacy-key",
        email: "mood-legacy-key@example.test",
        role: "USER",
        moodLogEnabled: true,
        moodLogWebhookSecret: secret,
      },
    });

    const { POST } =
      await import("@/app/api/integrations/moodlog/webhook/route");

    // Two entries, no id, DIFFERENT times → two rows (legacy behaviour
    // preserved). A re-emit at the SAME time updates in place.
    await POST(
      webhookRequest(secret, {
        event: "mood.created",
        timestamp: "2026-06-05T09:00:00.000Z",
        entry: {
          date: "2026-06-05",
          time: "2026-06-05T09:00:00.000Z",
          mood: "OKAY",
          score: 3,
        },
      }),
    );
    await POST(
      webhookRequest(secret, {
        event: "mood.created",
        timestamp: "2026-06-05T21:00:00.000Z",
        entry: {
          date: "2026-06-05",
          time: "2026-06-05T21:00:00.000Z",
          mood: "GUT",
          score: 4,
        },
      }),
    );
    // Re-emit the first at the exact same time → in-place update.
    await POST(
      webhookRequest(secret, {
        event: "mood.updated",
        timestamp: "2026-06-05T09:00:00.000Z",
        entry: {
          date: "2026-06-05",
          time: "2026-06-05T09:00:00.000Z",
          mood: "SUPER_GUT",
          score: 5,
        },
      }),
    );

    const rows = await prisma.moodEntry.findMany({
      where: { userId: user.id, source: "MOODLOG" },
      orderBy: { moodLoggedAt: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.externalId === null)).toBe(true);
    // The morning row was updated in place by the same-time re-emit.
    expect(rows[0].mood).toBe("SUPER_GUT");
    expect(rows[1].mood).toBe("GUT");
  });
});
