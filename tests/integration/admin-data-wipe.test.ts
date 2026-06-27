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
 * AuditLog rows are intentionally PRESERVED — a wipe must not erase the
 * audit trail of the operation itself.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

// next/headers cookie + ip headers stub for getSession() inside
// requireAdmin(). The admin route reads x-forwarded-for too; we stub
// both to keep the handler reachable. Maps live in
// `mock-next-headers.ts` — see that file for the rationale (suite
// runs with vitest `isolate: false`, so per-file Maps would leak).
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
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

describe("DELETE /api/admin/data wipe scope", () => {
  it("clears notification channels, push subscriptions, telegram deletions; preserves AuditLog", async () => {
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

    // ── assert: AuditLog rows survive ──
    // The wipe writes admin.data.clear.start AND admin.data.clear audit
    // entries. They must outlive the operation (audit log is immune).
    const auditCount = await prisma.auditLog.count({
      where: { userId: admin.id },
    });
    expect(auditCount).toBeGreaterThanOrEqual(2);
  });
});
