import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/bearer", () => ({
  resolveBearerToken: vi.fn(),
}));

import { resolveMcpAuthContext } from "../auth";
import { resolveBearerToken } from "@/lib/auth/bearer";

const FAKE_USER = { id: "user-1", role: "USER" } as never;

beforeEach(() => {
  vi.resetAllMocks();
});

describe("resolveMcpAuthContext", () => {
  it("binds the session to <userId>:<tokenId> (REQ-SEC-11) via the canonical Bearer path", async () => {
    vi.mocked(resolveBearerToken).mockResolvedValue({
      user: FAKE_USER,
      tokenId: "token-9",
      permissions: ["health:read"],
      expiresAt: new Date(),
    });

    const ctx = await resolveMcpAuthContext("  hlk_abc  ");

    // Trimmed token resolved through the shared validator (no requiredPermission for reads).
    // `any-valid-token` is the one deliberate fail-open posture in the tree:
    // `/mcp` authenticates here and authorises downstream (audience binding +
    // `tokenAllowsWrite`). Asserted explicitly so a silent switch to another
    // posture — in either direction — shows up as a failing test.
    expect(resolveBearerToken).toHaveBeenCalledWith("hlk_abc", {
      kind: "any-valid-token",
    });
    expect(ctx.userId).toBe("user-1");
    expect(ctx.tokenId).toBe("token-9");
    expect(ctx.binding).toBe("user-1:token-9");
    expect(ctx.canRead).toBe(true);
    expect(ctx.canWrite).toBe(false);
  });

  it("grants write capability only when the token carries health:write", async () => {
    vi.mocked(resolveBearerToken).mockResolvedValue({
      user: FAKE_USER,
      tokenId: "token-w",
      permissions: ["health:write"],
      expiresAt: new Date(),
    });
    const ctx = await resolveMcpAuthContext("hlk_xyz");
    expect(ctx.canWrite).toBe(true);
  });

  it("rejects an empty token without calling the validator", async () => {
    await expect(resolveMcpAuthContext("   ")).rejects.toThrow();
    expect(resolveBearerToken).not.toHaveBeenCalled();
  });

  it("propagates a rejection from the Bearer validator (invalid / revoked / expired)", async () => {
    vi.mocked(resolveBearerToken).mockRejectedValue(new Error("revoked"));
    await expect(resolveMcpAuthContext("hlk_bad")).rejects.toThrow();
  });
});
