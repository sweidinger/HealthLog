/**
 * v1.32.1 (issue #588) — periodic orphan-`ImportJob` reconcile.
 *
 * Before this change `reconcileOrphanImportJobs()` only ran once, at
 * worker boot. A worker that crashed mid-extraction (OOM, restart) and
 * came back up BEFORE the stuck row's heartbeat went stale (30 min) or
 * pg-boss stopped reporting the backing job as live left that row
 * stuck in `unpacking` / `parsing` / `upserting` forever — an import
 * that never leaves "Unpacking the archive… 0 rows imported" with no
 * failure ever surfaced, because nothing re-evaluated the row after
 * that one boot-time pass. These tests cover both the periodic-tick
 * wiring (queue provisioned, cron scheduled, handler bound) and the
 * reconcile logic itself (a genuinely-abandoned row flips to `failed`;
 * a row another worker is still actively running does not).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  updateMany: vi.fn(),
  getGlobalBoss: vi.fn(),
  getJobById: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    importJob: {
      findMany: mocks.findMany,
      updateMany: mocks.updateMany,
    },
  },
  toJson: (value: unknown) => value,
}));

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: mocks.getGlobalBoss,
}));

import {
  APPLE_HEALTH_IMPORT_PARSER_REVISION,
  APPLE_HEALTH_IMPORT_V2_QUEUE,
  IMPORT_JOB_RECONCILE_CRON,
  IMPORT_JOB_RECONCILE_QUEUE,
  handleImportJobReconcileTick,
  reconcileOrphanImportJobs,
} from "../apple-health-import-worker";

const maintenanceSource = readFileSync(
  join(process.cwd(), "src/lib/jobs/reminder/register-maintenance.ts"),
  "utf8",
);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getGlobalBoss.mockReturnValue({ getJobById: mocks.getJobById });
  mocks.updateMany.mockResolvedValue({ count: 0 });
});

describe("periodic reconcile — wiring", () => {
  it("provisions the queue, schedules a 15-minute cron, and binds the handler", () => {
    expect(IMPORT_JOB_RECONCILE_QUEUE).toBe("apple-health-import-reconcile");
    expect(IMPORT_JOB_RECONCILE_CRON).toBe("*/15 * * * *");

    const allQueues = maintenanceSource.match(
      /const allQueues\s*=\s*\[([\s\S]*?)\];/,
    );
    expect(allQueues).not.toBeNull();
    expect(allQueues![1]).toMatch(/\bIMPORT_JOB_RECONCILE_QUEUE\b/);

    const schedules = maintenanceSource.match(
      /const schedules[\s\S]*?=\s*\[([\s\S]*?)\];/,
    );
    expect(schedules).not.toBeNull();
    expect(schedules![1]).toMatch(
      /\[IMPORT_JOB_RECONCILE_QUEUE,\s*IMPORT_JOB_RECONCILE_CRON\]/,
    );

    expect(maintenanceSource).toMatch(
      /boss\.work\(\s*IMPORT_JOB_RECONCILE_QUEUE[\s\S]{0,120}handleImportJobReconcileTick/,
    );
  });
});

describe("reconcileOrphanImportJobs", () => {
  it("flips a row to failed once its heartbeat has gone stale", async () => {
    mocks.findMany.mockResolvedValue([
      {
        id: "import-stale",
        pgBossJobId: "boss-1",
        updatedAt: new Date(Date.now() - 31 * 60 * 1000),
      },
    ]);
    mocks.getJobById.mockResolvedValue({ state: "active" });

    await reconcileOrphanImportJobs();

    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["import-stale"] } },
      data: {
        status: "failed",
        failureReason: "interrupted_by_restart",
        completedAt: expect.any(Date),
      },
    });
  });

  it("leaves a row alone while its heartbeat is fresh and pg-boss reports the job active", async () => {
    mocks.findMany.mockResolvedValue([
      {
        id: "import-live",
        pgBossJobId: "boss-2",
        updatedAt: new Date(Date.now() - 2 * 60 * 1000),
      },
    ]);
    mocks.getJobById.mockResolvedValue({ state: "active" });

    await reconcileOrphanImportJobs();

    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.getJobById).toHaveBeenCalledWith(
      APPLE_HEALTH_IMPORT_V2_QUEUE,
      "boss-2",
    );
  });

  it("flips a row whose backing pg-boss job is gone even with a fresh heartbeat", async () => {
    mocks.findMany.mockResolvedValue([
      {
        id: "import-gone",
        pgBossJobId: "boss-3",
        updatedAt: new Date(Date.now() - 60 * 1000),
      },
    ]);
    mocks.getJobById.mockResolvedValue(null);

    await reconcileOrphanImportJobs();

    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["import-gone"] } },
      data: {
        status: "failed",
        failureReason: "interrupted_by_restart",
        completedAt: expect.any(Date),
      },
    });
  });

  it("only ever scopes the candidate query to the current parser revision", async () => {
    mocks.findMany.mockResolvedValue([]);

    await reconcileOrphanImportJobs();

    expect(mocks.findMany).toHaveBeenCalledWith({
      where: {
        parserRevision: APPLE_HEALTH_IMPORT_PARSER_REVISION,
        status: { in: ["unpacking", "parsing", "upserting"] },
      },
      select: { id: true, pgBossJobId: true, updatedAt: true },
    });
  });
});

describe("handleImportJobReconcileTick", () => {
  it("delegates to reconcileOrphanImportJobs and resolves on success", async () => {
    mocks.findMany.mockResolvedValue([]);

    await expect(
      handleImportJobReconcileTick([] as never),
    ).resolves.toBeUndefined();
    expect(mocks.findMany).toHaveBeenCalledTimes(1);
  });

  it("swallows a reconcile failure instead of throwing", async () => {
    mocks.findMany.mockRejectedValue(new Error("db unavailable"));

    // A background sweep this cheap must never spam pg-boss's
    // retry/backoff machinery — it just re-runs on the next 15-minute
    // tick. The handler must resolve even when the underlying reconcile
    // pass throws.
    await expect(
      handleImportJobReconcileTick([] as never),
    ).resolves.toBeUndefined();
  });
});
