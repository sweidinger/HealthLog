import { beforeEach, describe, expect, it, vi } from "vitest";

const { start, PgBoss } = vi.hoisted(() => {
  const start = vi.fn(async () => undefined);
  const stop = vi.fn(async () => undefined);
  const on = vi.fn();
  const PgBoss = vi.fn(function MockPgBoss(this: Record<string, unknown>) {
    this.start = start;
    this.stop = stop;
    this.on = on;
  });
  return { start, PgBoss };
});

vi.mock("pg-boss", () => ({ PgBoss }));
import { getGlobalBoss, startGlobalBossProducer } from "../boss-instance";

describe("web-process pg-boss producer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("retries startup and caps the send-only connection pool", async () => {
    start
      .mockRejectedValueOnce(new Error("schema not ready"))
      .mockResolvedValueOnce(undefined);

    const boss = await startGlobalBossProducer("postgres://healthlog@test/db", {
      maxAttempts: 2,
      retryDelayMs: 0,
    });

    expect(PgBoss).toHaveBeenCalledTimes(2);
    expect(PgBoss).toHaveBeenCalledWith({
      connectionString: "postgres://healthlog@test/db",
      max: 2,
      migrate: false,
      schedule: false,
      supervise: false,
    });
    expect(start).toHaveBeenCalledTimes(2);
    expect(boss).toBe(getGlobalBoss());
  });
});
