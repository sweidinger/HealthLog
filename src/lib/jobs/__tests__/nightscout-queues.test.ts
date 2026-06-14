/**
 * v1.17.0 — pg-boss queue registration for the Nightscout CGM sync layer.
 *
 * Source-as-text guard (the reminder-worker pulls heavy infra we don't boot
 * here): assert the queue constant + cron + handler wiring + allQueues
 * membership are present — the fast guard against the v1.4.37 dead-queue class
 * (a queue declared but never registered in `allQueues`, which silently never
 * drains).
 *
 * Nightscout is poll-only (no webhook, no OAuth, no backfill queue): a single
 * hourly `nightscout-sync` tick walks every configured instance via
 * `syncUserNightscout`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const source =
  readFileSync(join(__dirname, "..", "reminder-worker.ts"), "utf8") +
  readFileSync(join(__dirname, "..", "reminder", "nightscout-sync.ts"), "utf8");

describe("reminder-worker — Nightscout sync queue", () => {
  it("declares the nightscout-sync queue constant", () => {
    expect(source).toMatch(
      /NIGHTSCOUT_SYNC_QUEUE\s*=\s*["']nightscout-sync["']/,
    );
  });

  it("registers the queue in allQueues (v1.4.37 dead-queue guard)", () => {
    const block = /const allQueues = \[([\s\S]*?)\];/.exec(source);
    expect(block).not.toBeNull();
    expect(block![1]!).toContain("NIGHTSCOUT_SYNC_QUEUE");
  });

  it("schedules the hourly poll cron", () => {
    expect(source).toMatch(
      /\[NIGHTSCOUT_SYNC_QUEUE,\s*NIGHTSCOUT_SYNC_CRON\]/,
    );
  });

  it("registers a boss.work handler for the queue", () => {
    expect(source).toMatch(
      /boss\.work[\s\S]{0,160}NIGHTSCOUT_SYNC_QUEUE[\s\S]{0,160}handleNightscoutSync/,
    );
  });
});
