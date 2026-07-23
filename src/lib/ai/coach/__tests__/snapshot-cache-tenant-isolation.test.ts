/**
 * Cross-tenant isolation of the decrypted-snapshot LRU.
 *
 * The cache holds a fully-assembled health snapshot — one account's
 * measurements, mood, medication intake — for 60 seconds, keyed by
 * `${userId}|${window}|${sourceList}`. `userId` IS in the key today, so there
 * is no live defect. The gap this file closes is that nothing PINNED it: the
 * existing suite covers same-user memoisation and scope-change recomputation,
 * so a refactor dropping the `userId` segment would serve one user's snapshot
 * to another with a fully green run.
 *
 * The project has already shipped one cross-user cache-leak fix (v1.25.1), so
 * this is a repeat class, not a hypothetical one.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetCoachSnapshotCacheForTests,
  readSnapshotCache,
  snapshotCacheKey,
  writeSnapshotCache,
} from "../snapshot-cache";
import type { CoachSnapshotResult } from "../snapshot";
import type { CoachScope } from "../types";

function fakeResult(marker: string): CoachSnapshotResult {
  return { snapshotJson: marker } as unknown as CoachSnapshotResult;
}

beforeEach(() => {
  __resetCoachSnapshotCacheForTests();
});

describe("snapshot cache — tenant isolation", () => {
  it("never returns user A's snapshot to user B at identical scope", () => {
    const scope: CoachScope = { window: "last30days" };

    const keyA = snapshotCacheKey("user-a", scope);
    const keyB = snapshotCacheKey("user-b", scope);

    // The keys must differ in the first place — this is the invariant.
    expect(keyA).not.toBe(keyB);

    writeSnapshotCache(keyA, fakeResult("A-PRIVATE"));

    // B, at the very same scope, must miss.
    expect(readSnapshotCache(keyB)).toBeNull();

    // And once B has its own entry, the two never cross.
    writeSnapshotCache(keyB, fakeResult("B-PRIVATE"));
    expect(readSnapshotCache(keyA)?.snapshotJson).toBe("A-PRIVATE");
    expect(readSnapshotCache(keyB)?.snapshotJson).toBe("B-PRIVATE");
  });

  it("keeps the userId segment leading, so no scope string can forge another tenant", () => {
    // A source list is user-controllable in the request. It must not be able to
    // reconstruct a different user's key.
    const forged = snapshotCacheKey("user-a", {
      window: "last30days",
      sources: ["user-b"],
    } as unknown as CoachScope);
    const victim = snapshotCacheKey("user-b", { window: "last30days" });
    expect(forged).not.toBe(victim);
    expect(forged.startsWith("user-a|")).toBe(true);
  });

  it("isolates identical explicit source lists across users", () => {
    const scope: CoachScope = {
      window: "last7days",
      sources: ["MANUAL", "APPLE_HEALTH"],
    } as unknown as CoachScope;

    const keyA = snapshotCacheKey("user-a", scope);
    const keyB = snapshotCacheKey("user-b", scope);
    expect(keyA).not.toBe(keyB);

    writeSnapshotCache(keyA, fakeResult("A-PRIVATE"));
    expect(readSnapshotCache(keyB)).toBeNull();
  });
});
