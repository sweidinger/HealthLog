/**
 * v1.12.0 — pg-boss queue registration for the Fitbit / Google Health sync layer.
 *
 * The reminder-worker imports heavy infrastructure (pg-boss, Prisma adapter,
 * notification dispatchers, …) so we don't boot the whole worker here. Instead we
 * read the source as text and assert the queue constants + cron schedules +
 * handler wiring + allQueues + boot-enqueue are present — the fast guard that
 * catches the v1.4.37 dead-queue class (a queue declared but never registered in
 * `allQueues`, which silently never drains).
 *
 * Fitbit is poll-only at launch (no webhook — Pub/Sub deferred), so a single
 * hourly `fitbit-sync` queue drives the per-user `syncUserFitbit` driver across
 * every connection, alongside the backfill + the daily OAuth-state sweep.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const REMINDER_WORKER_PATH = join(__dirname, "..", "reminder-worker.ts");
const source = readFileSync(REMINDER_WORKER_PATH, "utf8");

const FITBIT_QUEUE_CONSTS = [
  "FITBIT_SYNC_QUEUE",
  "FITBIT_BACKFILL_QUEUE",
  "FITBIT_OAUTH_STATE_CLEANUP_QUEUE",
] as const;

describe("reminder-worker — Fitbit sync queues", () => {
  it("declares the Fitbit sync + oauth-state-cleanup queue constants", () => {
    expect(source).toMatch(/FITBIT_SYNC_QUEUE\s*=\s*["']fitbit-sync["']/);
    expect(source).toMatch(
      /FITBIT_OAUTH_STATE_CLEANUP_QUEUE\s*=\s*["']fitbit-oauth-state-cleanup["']/,
    );
  });

  it("registers EVERY Fitbit queue in allQueues (v1.4.37 dead-queue guard)", () => {
    const block = /const allQueues = \[([\s\S]*?)\];/.exec(source);
    expect(block).not.toBeNull();
    const body = block![1]!;
    for (const q of FITBIT_QUEUE_CONSTS) {
      expect(body).toContain(q);
    }
  });

  it("schedules the hourly poll cron + the daily oauth-state sweep", () => {
    expect(source).toMatch(/\[FITBIT_SYNC_QUEUE,\s*FITBIT_SYNC_CRON\]/);
    expect(source).toMatch(
      /\[FITBIT_OAUTH_STATE_CLEANUP_QUEUE,\s*FITBIT_OAUTH_STATE_CLEANUP_CRON\]/,
    );
  });

  it("registers a boss.work handler for every Fitbit queue", () => {
    expect(source).toMatch(
      /boss\.work[\s\S]{0,160}FITBIT_SYNC_QUEUE[\s\S]{0,160}handleFitbitSync/,
    );
    expect(source).toMatch(
      /boss\.work[\s\S]{0,200}FITBIT_BACKFILL_QUEUE[\s\S]{0,200}runFitbitBackfillForUser/,
    );
    expect(source).toMatch(
      /boss\.work[\s\S]{0,160}FITBIT_OAUTH_STATE_CLEANUP_QUEUE[\s\S]{0,160}handleFitbitOAuthStateCleanup/,
    );
  });

  it("wires the self-converging Fitbit backfill boot discovery", () => {
    expect(source).toMatch(/enqueueBootTimeFitbitBackfill\(\)/);
  });

  it("imports the Fitbit sync driver + backfill exports", () => {
    expect(source).toMatch(/from\s*["']@\/lib\/fitbit\/sync["']/);
    expect(source).toMatch(/from\s*["']@\/lib\/jobs\/fitbit-backfill["']/);
  });
});
