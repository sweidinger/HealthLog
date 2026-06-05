import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn(async () => ({ user: { id: "u1" } })),
}));

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
}));

vi.mock("@/lib/whoop/connect-ticket", () => ({
  mintWhoopConnectTicket: vi.fn(async () => "opaque-raw-ticket"),
}));

vi.mock("@/lib/whoop/credentials", () => ({
  getUserWhoopCredentials: vi.fn(async () => ({
    clientId: "cid",
    clientSecret: "s",
  })),
}));

vi.mock("@/lib/api-response", () => ({
  apiSuccess: (data: unknown) => ({ data, error: null, status: 200 }),
  apiError: (error: string, status: number) => ({ data: null, error, status }),
}));

import { POST } from "../route";
import { checkRateLimit } from "@/lib/rate-limit";
import { getUserWhoopCredentials } from "@/lib/whoop/credentials";
import { mintWhoopConnectTicket } from "@/lib/whoop/connect-ticket";

const rl = checkRateLimit as ReturnType<typeof vi.fn>;
const creds = getUserWhoopCredentials as unknown as ReturnType<typeof vi.fn>;
const mint = mintWhoopConnectTicket as unknown as ReturnType<typeof vi.fn>;

const call = () =>
  (POST as unknown as () => Promise<{ data: unknown; status: number }>)();

describe("POST /api/whoop/connect/ticket", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rl.mockResolvedValue({ allowed: true });
    creds.mockResolvedValue({ clientId: "cid", clientSecret: "s" });
  });

  it("mints and returns a ticket once", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect((res.data as { ticket: string }).ticket).toBe("opaque-raw-ticket");
    expect(mint).toHaveBeenCalledWith("u1");
  });

  it("429s when rate-limited", async () => {
    rl.mockResolvedValue({ allowed: false });
    const res = await call();
    expect(res.status).toBe(429);
    expect(mint).not.toHaveBeenCalled();
  });

  it("400s when WHOOP credentials are not configured", async () => {
    creds.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(400);
    expect(mint).not.toHaveBeenCalled();
  });
});
