/**
 * v1.17.1 — pg-boss queue registration for the one-shot sleep-timeline backfill.
 *
 * The reminder-worker imports heavy infrastructure, so we read the source as
 * text and assert the queue constant is declared, registered in `allQueues`,
 * wired to a `boss.work` handler, and enqueued at boot — the fast guard that
 * catches the v1.4.37 dead-queue class (a queue declared but never registered,
 * which silently never drains).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const REMINDER_WORKER_PATH = join(__dirname, "..", "reminder-worker.ts");
const source = readFileSync(REMINDER_WORKER_PATH, "utf8");

describe("reminder-worker — sleep-timeline backfill queue", () => {
  it("registers the queue in allQueues (v1.4.37 dead-queue guard)", () => {
    const block = /const allQueues = \[([\s\S]*?)\];/.exec(source);
    expect(block).not.toBeNull();
    expect(block![1]!).toContain("SLEEP_TIMELINE_BACKFILL_QUEUE");
  });

  it("wires a boss.work handler to the per-user runner", () => {
    expect(source).toMatch(
      /boss\.work[\s\S]{0,260}SLEEP_TIMELINE_BACKFILL_QUEUE[\s\S]{0,260}runSleepTimelineBackfillForUser/,
    );
  });

  it("wires the boot discovery", () => {
    expect(source).toMatch(/enqueueBootTimeSleepTimelineBackfill\(\)/);
  });

  it("imports the backfill exports", () => {
    expect(source).toMatch(/from\s*["']@\/lib\/jobs\/sleep-timeline-backfill["']/);
  });
});
