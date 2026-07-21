/**
 * Fork ADHS Stage B.2 — medication effect-window check-in reminder queue guard.
 *
 * Same source-text-grep approach as the cycle / mood / measurement
 * registration guards: assert the check-in reminder queue is declared, listed
 * in `allQueues` (the v1.4.37 dead-queue lesson — an unregistered queue is
 * never provisioned and the schedule silently no-ops), scheduled on its cron,
 * and wired to a `boss.work` handler that delegates to
 * `runMedicationCheckinReminderTick`. No pg-boss / Prisma boot.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const source =
  readFileSync(
    join(__dirname, "..", "reminder", "register-reminders.ts"),
    "utf8",
  ) +
  readFileSync(
    join(__dirname, "..", "reminder", "mood-cycle-checks.ts"),
    "utf8",
  );

describe("reminder-worker — medication-checkin-reminder wiring", () => {
  it("imports the check-in reminder tick runner", () => {
    expect(source).toMatch(
      /from\s*["']@\/lib\/jobs\/medication-checkin-reminder["']/,
    );
    expect(source).toMatch(/\brunMedicationCheckinReminderTick\b/);
  });

  it("declares the queue + cron constants", () => {
    expect(source).toMatch(
      /MEDICATION_CHECKIN_REMINDER_QUEUE\s*=\s*["']medication-checkin-reminder-check["']/,
    );
    expect(source).toMatch(
      /MEDICATION_CHECKIN_REMINDER_CRON\s*=\s*["']\*\/15 \* \* \* \*["']/,
    );
  });

  it("registers the queue in the allQueues loop", () => {
    const allQueuesMatch = source.match(
      /const allQueues\s*=\s*\[([\s\S]*?)\];/,
    );
    expect(allQueuesMatch).not.toBeNull();
    expect(allQueuesMatch![1]).toMatch(/\bMEDICATION_CHECKIN_REMINDER_QUEUE\b/);
  });

  it("schedules the check-in reminder cron", () => {
    expect(source).toMatch(
      /\[MEDICATION_CHECKIN_REMINDER_QUEUE,\s*MEDICATION_CHECKIN_REMINDER_CRON\]/,
    );
  });

  it("registers a boss.work handler that runs the tick", () => {
    expect(source).toMatch(
      /boss\.work[\s\S]{0,200}MEDICATION_CHECKIN_REMINDER_QUEUE[\s\S]{0,200}handleMedicationCheckinReminderCheck/,
    );
    expect(source).toMatch(
      /handleMedicationCheckinReminderCheck[\s\S]{0,600}runMedicationCheckinReminderTick/,
    );
  });
});
