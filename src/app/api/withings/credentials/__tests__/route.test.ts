/**
 * `DELETE /api/withings/credentials` — disconnect honesty.
 *
 * The handler deletes the connection row (holding the encrypted OAuth access +
 * refresh tokens) before nulling the credential columns. That delete used to be
 * `.catch(() => {})`: on a real failure the handler carried on, nulled the
 * client id/secret, and returned `{ deleted: true }` while the token-bearing
 * row survived — the user is told they are disconnected and they are not.
 *
 * It now narrows to P2025 ("already gone", a genuine no-op) and rethrows
 * everything else. Withings had no test file at all, which is why this one
 * exists; the WHOOP and Fitbit twins carry the same shape.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    withingsConnection: { delete: vi.fn() },
    user: { update: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { DELETE } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

/** Shape of a Prisma "record to delete does not exist" rejection. */
function p2025() {
  return Object.assign(new Error("Record to delete does not exist."), {
    code: "P2025",
    name: "PrismaClientKnownRequestError",
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(prisma.user.update).mockResolvedValue({} as never);
});

describe("DELETE /api/withings/credentials", () => {
  it("disconnects and nulls the credential columns on the happy path", async () => {
    vi.mocked(prisma.withingsConnection.delete).mockResolvedValue({} as never);
    const res = await DELETE();
    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          withingsClientIdEncrypted: null,
          withingsClientSecretEncrypted: null,
        },
      }),
    );
  });

  it("treats an already-missing connection row (P2025) as a benign no-op", async () => {
    vi.mocked(prisma.withingsConnection.delete).mockRejectedValue(p2025());
    const res = await DELETE();
    expect(res.status).toBe(200);
    // Idempotent disconnect still clears the credentials.
    expect(prisma.user.update).toHaveBeenCalled();
  });

  it("does NOT report success when the token-bearing row fails to delete", async () => {
    vi.mocked(prisma.withingsConnection.delete).mockRejectedValue(
      new Error("connection terminated unexpectedly"),
    );
    const res = await DELETE();
    expect(res.status).toBe(500);
    // Critically: the credentials must NOT be nulled, because doing so while
    // the encrypted OAuth tokens survive is the worst of both states.
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
