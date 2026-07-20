/**
 * v1.28.33 (issue #486) — send-policy pins for the Apple Health import
 * queue.
 *
 * The queue defaults (retryLimit 2, expireInSeconds 900) redelivered a
 * long-running import after its staged `/tmp` upload was already
 * consumed: the re-run failed on the deleted file and overwrote the
 * first run's terminal state with a raw ENOENT. The kick-off sends must
 * therefore disable retries and widen the expiration past the largest
 * observed exports — and BOTH kick-off routes (user + admin) must
 * actually pass the shared policy, or the default silently returns.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {},
  toJson: (value: unknown) => value,
}));

import { APPLE_HEALTH_IMPORT_SEND_OPTIONS } from "../apple-health-import-worker";

const ROUTE_FILES = [
  "src/app/api/import/apple-health-export/route.ts",
  "src/app/api/admin/import-apple-health-export/route.ts",
];

describe("apple health import — pg-boss send policy", () => {
  it("disables retries and widens the expiration window", () => {
    // retryLimit 0: the staged upload is unlinked by the first run, so
    // a retry can only mask the original outcome behind an ENOENT.
    expect(APPLE_HEALTH_IMPORT_SEND_OPTIONS.retryLimit).toBe(0);
    // Expiration must exceed the 15-minute queue default by a wide
    // margin — GB-scale exports parse for well over an hour.
    expect(
      APPLE_HEALTH_IMPORT_SEND_OPTIONS.expireInSeconds,
    ).toBeGreaterThanOrEqual(60 * 60);
  });

  it("both kick-off routes send with the shared policy", () => {
    for (const file of ROUTE_FILES) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      expect(source).toMatch(
        /boss\.send\(\s*APPLE_HEALTH_IMPORT_QUEUE,\s*payload,\s*APPLE_HEALTH_IMPORT_SEND_OPTIONS,?\s*\)/,
      );
    }
  });
});
