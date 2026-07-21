import { beforeEach, describe, expect, it, vi } from "vitest";

const adapterCtor = vi.fn();
const clientCtor = vi.fn();

vi.mock("@prisma/adapter-pg", () => ({
  PrismaPg: class {
    constructor(...args: unknown[]) {
      adapterCtor(...args);
    }
  },
}));

vi.mock("@/generated/prisma/client", () => ({
  Prisma: {},
  PrismaClient: class {
    constructor(...args: unknown[]) {
      clientCtor(...args);
    }
  },
}));

describe("worker Prisma connection ownership", () => {
  beforeEach(() => {
    vi.resetModules();
    adapterCtor.mockClear();
    clientCtor.mockClear();
    process.env.DATABASE_URL =
      "postgres://user:pass@localhost:5432/db?connection_limit=20&pool_timeout=20";
  });

  it("reuses the process Prisma client instead of opening a second pool", async () => {
    const [{ prisma }, { getWorkerPrisma }] = await Promise.all([
      import("@/lib/db"),
      import("../shared"),
    ]);

    expect(getWorkerPrisma()).toBe(prisma);
    expect(getWorkerPrisma()).toBe(prisma);
    expect(adapterCtor).toHaveBeenCalledTimes(1);
    expect(clientCtor).toHaveBeenCalledTimes(1);
  });
});
