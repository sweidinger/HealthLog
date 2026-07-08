/**
 * F-DB-1 — the worker Prisma client must inherit the same pool ceiling +
 * session timeouts as the web client (`src/lib/db.ts`).
 *
 * Before this fix the worker adapter was built with a bare
 * `{ connectionString }`, so a pathological nightly drain on a heavy tenant
 * could run unbounded, pin a connection indefinitely, and wedge the shared
 * worker pool. This test pins the contract: `getWorkerPrisma()` constructs its
 * `PrismaPg` adapter with `max` from `getPoolMax()` and the `options` startup
 * string from `buildSessionOptions()`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  PrismaClient: class {
    constructor(...args: unknown[]) {
      clientCtor(...args);
    }
  },
}));

describe("getWorkerPrisma", () => {
  beforeEach(() => {
    vi.resetModules();
    adapterCtor.mockClear();
    clientCtor.mockClear();
    process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/db";
    delete process.env.DATABASE_POOL_MAX;
    delete process.env.DATABASE_STATEMENT_TIMEOUT_MS;
  });

  afterEach(() => {
    delete process.env.DATABASE_POOL_MAX;
    delete process.env.DATABASE_STATEMENT_TIMEOUT_MS;
  });

  it("builds the adapter with a pool cap and session timeouts", async () => {
    const { getWorkerPrisma } = await import("../shared");
    // Importing ../shared pulls in src/lib/db.ts, which constructs the web
    // client's adapter at module load. Clear so we count only the worker's.
    adapterCtor.mockClear();
    clientCtor.mockClear();
    getWorkerPrisma();

    expect(adapterCtor).toHaveBeenCalledTimes(1);
    const config = adapterCtor.mock.calls[0][0] as {
      connectionString: string;
      max: number;
      options?: string;
    };
    expect(config.connectionString).toBe(
      "postgres://user:pass@localhost:5432/db",
    );
    // Default pool ceiling — must not fall back to the pg library default of 10.
    expect(config.max).toBe(20);
    // Both session timeouts applied at connection establishment.
    expect(config.options).toContain("-c statement_timeout=60000");
    expect(config.options).toContain(
      "-c idle_in_transaction_session_timeout=60000",
    );
  });

  it("honours the shared env knobs", async () => {
    process.env.DATABASE_POOL_MAX = "12";
    process.env.DATABASE_STATEMENT_TIMEOUT_MS = "30000";
    const { getWorkerPrisma } = await import("../shared");
    adapterCtor.mockClear();
    getWorkerPrisma();

    const config = adapterCtor.mock.calls[0][0] as {
      max: number;
      options?: string;
    };
    expect(config.max).toBe(12);
    expect(config.options).toContain("-c statement_timeout=30000");
  });

  it("omits the options string when the timeout is disabled", async () => {
    process.env.DATABASE_STATEMENT_TIMEOUT_MS = "0";
    const { getWorkerPrisma } = await import("../shared");
    adapterCtor.mockClear();
    getWorkerPrisma();

    const config = adapterCtor.mock.calls[0][0] as { options?: string };
    expect(config.options).toBeUndefined();
  });

  it("reuses a single client across calls", async () => {
    const { getWorkerPrisma } = await import("../shared");
    clientCtor.mockClear();
    const a = getWorkerPrisma();
    const b = getWorkerPrisma();
    expect(a).toBe(b);
    expect(clientCtor).toHaveBeenCalledTimes(1);
  });
});
