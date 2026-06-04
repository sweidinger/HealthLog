import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: (...args: unknown[]) => findUnique(...args) } },
}));

// decrypt() is the fail-closed AES-256-GCM reader; the resolver only needs it
// to round-trip the stored ciphertext, so a `dec(<x>)` shim is sufficient here.
vi.mock("@/lib/crypto", () => ({
  decrypt: (cipher: string) => `dec(${cipher})`,
}));

import { getUserWhoopCredentials } from "../credentials";

describe("getUserWhoopCredentials", () => {
  beforeEach(() => {
    findUnique.mockReset();
  });

  it("decrypts and returns the per-user BYO client id/secret", async () => {
    findUnique.mockResolvedValue({
      whoopClientIdEncrypted: "enc-id",
      whoopClientSecretEncrypted: "enc-secret",
    });
    const creds = await getUserWhoopCredentials("user-1");
    expect(creds).toEqual({
      clientId: "dec(enc-id)",
      clientSecret: "dec(enc-secret)",
    });
    // Resolution is user-scoped and selects only the two encrypted columns.
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "user-1" },
      select: {
        whoopClientIdEncrypted: true,
        whoopClientSecretEncrypted: true,
      },
    });
  });

  it("returns null when the user has no WHOOP credentials configured", async () => {
    findUnique.mockResolvedValue({
      whoopClientIdEncrypted: null,
      whoopClientSecretEncrypted: null,
    });
    expect(await getUserWhoopCredentials("user-1")).toBeNull();
  });

  it("returns null when only one half of the pair is present", async () => {
    findUnique.mockResolvedValue({
      whoopClientIdEncrypted: "enc-id",
      whoopClientSecretEncrypted: null,
    });
    expect(await getUserWhoopCredentials("user-1")).toBeNull();
  });

  it("returns null when the user row is missing", async () => {
    findUnique.mockResolvedValue(null);
    expect(await getUserWhoopCredentials("ghost")).toBeNull();
  });
});
