/**
 * v1.10.0 — computed scores (WX-E). Queue-registration guards for the
 * Stress + Strain nightly score jobs and the dense intra-day retention
 * drain.
 *
 * Same source-text-grep approach as the WX-C recovery-score guard: assert
 * each queue is imported, registered in `allQueues`, scheduled (the two
 * cron-driven score jobs), and wired to a `boss.work` handler — without
 * booting pg-boss + Prisma. An unregistered queue silently never drains
 * (the recurring past bug this guards against).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const REMINDER_WORKER_PATH = join(__dirname, "..", "reminder-worker.ts");
const source = readFileSync(REMINDER_WORKER_PATH, "utf8");

function allQueuesBlock(): string {
  const m = source.match(/const allQueues\s*=\s*\[([\s\S]*?)\];/);
  expect(m).not.toBeNull();
  return m![1];
}

describe("reminder-worker — stress-score wiring", () => {
  it("imports the queue symbols from the stress-score module", () => {
    expect(source).toMatch(/from\s*["']@\/lib\/jobs\/stress-score["']/);
    expect(source).toMatch(/\bSTRESS_SCORE_QUEUE\b/);
    expect(source).toMatch(/\bSTRESS_SCORE_CRON\b/);
    expect(source).toMatch(/\brunStressScore\b/);
  });

  it("registers the stress-score queue in allQueues", () => {
    expect(allQueuesBlock()).toMatch(/\bSTRESS_SCORE_QUEUE\b/);
  });

  it("schedules the stress-score cron", () => {
    expect(source).toMatch(/\[STRESS_SCORE_QUEUE,\s*STRESS_SCORE_CRON\]/);
  });

  it("registers a boss.work handler that runs the stress-score pass", () => {
    expect(source).toMatch(
      /boss\.work[\s\S]{0,200}STRESS_SCORE_QUEUE[\s\S]{0,400}runStressScore/,
    );
  });
});

describe("reminder-worker — strain-score wiring", () => {
  it("imports the queue symbols from the strain-score module", () => {
    expect(source).toMatch(/from\s*["']@\/lib\/jobs\/strain-score["']/);
    expect(source).toMatch(/\bSTRAIN_SCORE_QUEUE\b/);
    expect(source).toMatch(/\bSTRAIN_SCORE_CRON\b/);
    expect(source).toMatch(/\brunStrainScore\b/);
  });

  it("registers the strain-score queue in allQueues", () => {
    expect(allQueuesBlock()).toMatch(/\bSTRAIN_SCORE_QUEUE\b/);
  });

  it("schedules the strain-score cron", () => {
    expect(source).toMatch(/\[STRAIN_SCORE_QUEUE,\s*STRAIN_SCORE_CRON\]/);
  });

  it("registers a boss.work handler that runs the strain-score pass", () => {
    expect(source).toMatch(
      /boss\.work[\s\S]{0,200}STRAIN_SCORE_QUEUE[\s\S]{0,400}runStrainScore/,
    );
  });
});

describe("reminder-worker — dense intra-day retention wiring", () => {
  it("imports the queue symbols from the dense-intraday-retention module", () => {
    expect(source).toMatch(
      /from\s*["']@\/lib\/jobs\/dense-intraday-retention["']/,
    );
    expect(source).toMatch(/\bDENSE_INTRADAY_RETENTION_QUEUE\b/);
    expect(source).toMatch(/\brunDenseIntradayRetentionForUser\b/);
    expect(source).toMatch(/\benqueueBootTimeDenseIntradayRetention\b/);
  });

  it("registers the dense-intraday-retention queue in allQueues", () => {
    expect(allQueuesBlock()).toMatch(/\bDENSE_INTRADAY_RETENTION_QUEUE\b/);
  });

  it("registers a boss.work handler against the dense-intraday-retention queue", () => {
    expect(source).toMatch(
      /boss\.work[\s\S]{0,250}DENSE_INTRADAY_RETENTION_QUEUE[\s\S]{0,500}runDenseIntradayRetentionForUser/,
    );
  });

  it("fires the boot-discovery enqueue helper", () => {
    expect(source).toMatch(/await enqueueBootTimeDenseIntradayRetention\(\)/);
  });

  it("folds the nightly dense-retention walk onto the drain-cumulative tick", () => {
    // The steady-state nightly walk runs the global (no-userId) pass on the
    // same tick as the cumulative + mean drains.
    expect(source).toMatch(/runDenseIntradayRetention\(\s*getWorkerPrisma\(\)/);
  });
});
