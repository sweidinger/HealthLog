import { describe, expect, it, vi } from "vitest";
import { persistRotatedToken } from "../oauth-refresh";

describe("persistRotatedToken", () => {
  it("returns the freshly minted access token when the CAS write wins (1 row)", async () => {
    const conditionalUpdate = vi.fn(async () => 1);
    const readPeerAccessToken = vi.fn(async () => "peer");

    const token = await persistRotatedToken("mine", {
      conditionalUpdate,
      readPeerAccessToken,
    });

    expect(token).toBe("mine");
    expect(conditionalUpdate).toHaveBeenCalledTimes(1);
    // No re-read on a win.
    expect(readPeerAccessToken).not.toHaveBeenCalled();
  });

  it("reuses the peer's rotated token on a lost race (0 rows)", async () => {
    const conditionalUpdate = vi.fn(async () => 0);
    const readPeerAccessToken = vi.fn(async () => "peer");

    const token = await persistRotatedToken("mine", {
      conditionalUpdate,
      readPeerAccessToken,
    });

    expect(token).toBe("peer");
    expect(readPeerAccessToken).toHaveBeenCalledTimes(1);
  });

  it("returns null when the row vanished after a lost race", async () => {
    const token = await persistRotatedToken("mine", {
      conditionalUpdate: async () => 0,
      readPeerAccessToken: async () => null,
    });

    expect(token).toBeNull();
  });
});
