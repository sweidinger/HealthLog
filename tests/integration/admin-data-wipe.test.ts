/**
 * Integration regression guard for `DELETE /api/admin/data`.
 *
 * The admin "wipe all data" path nulls personal columns on `User` and
 * deletes a curated list of personal-data tables in one transaction.
 * v1.4.6 left three notification-channel-style tables out of that
 * list, leaving encrypted Telegram bot tokens (NotificationChannel.config)
 * and Web Push endpoints behind. This test is the regression guard
 * that the wipe now extends to:
 *
 *   - notification_channels       (Telegram/ntfy/web-push channel config)
 *   - push_subscriptions          (raw browser push endpoints)
 *   - telegram_scheduled_deletions (queued message-delete tickets)
 *
 * Feedback rows are intentionally PRESERVED (T8 from v1.4.6 + admin
 * i18n copy now states this explicitly) — a wipe must not erase
 * user-submitted bug reports admins still need to triage.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

// next/headers cookie + ip headers stub for getSession() inside
// requireAdmin(). The admin route reads x-forwarded-for too; we stub
// both to keep the handler reachable.
const cookieJar = new Map<string, string>();
const headerJar = new Map<string, string>();

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({
    get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
  })),
  cookies: vi.fn(async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name);
      return value ? { name, value } : undefined;
    },
    set: (name: string, value: string) => {
      cookieJar.set(name, value);
    },
    delete: (name: string) => {
      cookieJar.delete(name);
    },
  })),
}));

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

describe("DELETE /api/admin/data wipe scope", () => {
  it("clears notification channels, push subscriptions, telegram deletions; preserves Feedback + AuditLog", async () => {
    const prisma = getPrismaClient();

    // ── arrange ──
    const admin = await prisma.user.create({
      data: {
        username: "wipe-admin",
        email: "wipe-admin@example.test",
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

    // Seed the channels & adjacent rows the wipe must clear.
    await prisma.notificationChannel.create({
      data: {
        userId: admin.id,
        type: "TELEGRAM",
        enabled: true,
        // Pretend-encrypted blob — content is irrelevant, presence is.
        config: "encrypted:test",
      },
    });
    await prisma.pushSubscription.create({
      data: {
        userId: admin.id,
        endpoint: "https://push.example/sub-" + admin.id,
        p256dh: "p256dh-enc",
        auth: "auth-enc",
      },
    });
    await prisma.telegramScheduledDeletion.create({
      data: {
        userId: admin.id,
        chatId: "1234",
        messageId: 42,
        deleteAfter: new Date(Date.now() + 60_000),
      },
    });

    // Seed a feedback row that MUST survive the wipe (per i18n copy).
    const feedbackRow = await prisma.feedback.create({
      data: {
        userId: admin.id,
        category: "BUG",
        subject: "survives wipe",
        description: "feedback rows are preserved",
      },
    });

    // ── act: invoke the route handler exactly as Next.js would ──
    const { DELETE } = await import("@/app/api/admin/data/route");
    const req = new Request("http://localhost/api/admin/data", {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "127.0.0.1",
      },
      body: JSON.stringify({ confirm: "DELETE ALL" }),
    });
    const res = await DELETE(req as unknown as Parameters<typeof DELETE>[0]);
    expect(res.status).toBe(200);

    // ── assert: notification-related tables are empty ──
    expect(
      await prisma.notificationChannel.count({ where: { userId: admin.id } }),
    ).toBe(0);
    expect(
      await prisma.pushSubscription.count({ where: { userId: admin.id } }),
    ).toBe(0);
    expect(
      await prisma.telegramScheduledDeletion.count({
        where: { userId: admin.id },
      }),
    ).toBe(0);

    // ── assert: feedback row survives, AuditLog rows survive ──
    const feedbackAfter = await prisma.feedback.findUnique({
      where: { id: feedbackRow.id },
    });
    expect(feedbackAfter).not.toBeNull();
    expect(feedbackAfter?.subject).toBe("survives wipe");

    // The wipe writes admin.data.clear.start AND admin.data.clear audit
    // entries. They must outlive the operation (audit log is immune).
    const auditCount = await prisma.auditLog.count({
      where: { userId: admin.id },
    });
    expect(auditCount).toBeGreaterThanOrEqual(2);
  });
});
