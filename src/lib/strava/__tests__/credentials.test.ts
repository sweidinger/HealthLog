import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const updateMany = vi.fn();
const getStravaCredentials = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: (...args: unknown[]) => findUnique(...args),
      updateMany: (...args: unknown[]) => updateMany(...args),
    },
  },
}));

vi.mock("@/lib/crypto", () => ({
  decrypt: (cipher: string) => `dec(${cipher})`,
  encrypt: (plain: string) => `enc(${plain})`,
}));

vi.mock("../client", () => ({
  getStravaCredentials: () => getStravaCredentials(),
}));

import { getStravaClientCredentials, storeStravaTokens } from "../credentials";

describe("getStravaClientCredentials — DB-first then env", () => {
  beforeEach(() => {
    findUnique.mockReset();
    getStravaCredentials.mockReset();
  });

  it("returns the per-user BYO pair when both columns are set", async () => {
    findUnique.mockResolvedValue({
      stravaClientIdEncrypted: "enc-id",
      stravaClientSecretEncrypted: "enc-secret",
    });
    const creds = await getStravaClientCredentials("user-1");
    expect(creds).toEqual({
      clientId: "dec(enc-id)",
      clientSecret: "dec(enc-secret)",
    });
    expect(getStravaCredentials).not.toHaveBeenCalled();
  });

  it("falls back to the shared env app when the user has no BYO pair", async () => {
    findUnique.mockResolvedValue({
      stravaClientIdEncrypted: null,
      stravaClientSecretEncrypted: null,
    });
    getStravaCredentials.mockReturnValue({
      clientId: "env-id",
      clientSecret: "env-secret",
    });
    const creds = await getStravaClientCredentials("user-1");
    expect(creds).toEqual({ clientId: "env-id", clientSecret: "env-secret" });
    expect(getStravaCredentials).toHaveBeenCalledOnce();
  });
});

describe("storeStravaTokens — rotating-refresh compare-and-swap", () => {
  beforeEach(() => {
    findUnique.mockReset();
    updateMany.mockReset();
  });

  it("persists and returns the fresh access token when the CAS wins", async () => {
    updateMany.mockResolvedValue({ count: 1 });
    const token = await storeStravaTokens(
      "user-1",
      "fresh-access",
      "fresh-refresh",
      "stored-refresh-ciphertext",
    );
    expect(token).toBe("fresh-access");
    // The guard keys on the exact stored ciphertext, not a re-encryption.
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "user-1",
        stravaRefreshTokenEncrypted: "stored-refresh-ciphertext",
      },
      data: {
        stravaAccessTokenEncrypted: "enc(fresh-access)",
        stravaRefreshTokenEncrypted: "enc(fresh-refresh)",
      },
    });
  });

  it("returns the peer's rotated access token when the CAS loses the race", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue({
      stravaAccessTokenEncrypted: "peer-access-cipher",
    });
    const token = await storeStravaTokens(
      "user-1",
      "fresh-access",
      "fresh-refresh",
      "stale-ciphertext",
    );
    expect(token).toBe("dec(peer-access-cipher)");
  });

  it("returns null when the connection vanished mid-race", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue({ stravaAccessTokenEncrypted: null });
    const token = await storeStravaTokens(
      "user-1",
      "fresh-access",
      "fresh-refresh",
      "stale-ciphertext",
    );
    expect(token).toBeNull();
  });
});
