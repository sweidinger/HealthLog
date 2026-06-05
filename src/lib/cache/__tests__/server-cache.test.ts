/**
 * Unit tests for the `ServerCache<T>` primitive — LRU ordering, TTL
 * expiry, capacity-cap eviction, prefix delete, single-flight
 * coalescing, builder-rejection cleanup, and the `cached()` wrapper's
 * observability annotation.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __resetAllCachesForTests,
  cached,
  cachedSwr,
  caches,
  hashCacheKey,
  ServerCache,
} from "../server-cache";

afterEach(() => {
  __resetAllCachesForTests();
  vi.useRealTimers();
});

describe("ServerCache.get / set", () => {
  it("returns the stored value within TTL", () => {
    const cache = new ServerCache<string>({ maxEntries: 4, ttlMs: 60_000 });
    cache.set("k", "v");
    expect(cache.get("k")).toBe("v");
  });

  it("returns null when the key is absent", () => {
    const cache = new ServerCache<string>({ maxEntries: 4, ttlMs: 60_000 });
    expect(cache.get("missing")).toBeNull();
  });

  it("expires entries past the TTL", () => {
    vi.useFakeTimers();
    const cache = new ServerCache<string>({ maxEntries: 4, ttlMs: 1000 });
    cache.set("k", "v");
    vi.advanceTimersByTime(999);
    expect(cache.get("k")).toBe("v");
    vi.advanceTimersByTime(2);
    expect(cache.get("k")).toBeNull();
  });
});

describe("ServerCache per-key TTL override", () => {
  it("set() honours a longer-than-default TTL for a single key", () => {
    vi.useFakeTimers();
    const cache = new ServerCache<string>({ maxEntries: 4, ttlMs: 60_000 });
    cache.set("default", "v");
    cache.set("long", "v", 180_000);
    // Past the bucket default but inside the override.
    vi.advanceTimersByTime(60_001);
    expect(cache.get("default")).toBeNull();
    expect(cache.get("long")).toBe("v");
    // Past the override too.
    vi.advanceTimersByTime(120_000);
    expect(cache.get("long")).toBeNull();
  });

  it("wrap()/cached() thread the TTL override and stay evictable by prefix", async () => {
    vi.useFakeTimers();
    const cache = new ServerCache<string>({ maxEntries: 4, ttlMs: 60_000 });
    await cached(cache, "u1|dashboard-snapshot", async () => "snap", undefined, 180_000);
    // Default bucket TTL elapsed; the override keeps the entry warm so
    // the 120 s client refetch interval lands on a hit, not a miss.
    vi.advanceTimersByTime(120_000);
    expect(cache.get("u1|dashboard-snapshot")).toBe("snap");
    // Invalidation still evicts regardless of the longer TTL.
    expect(cache.deleteByPrefix("u1|")).toBe(1);
    expect(cache.get("u1|dashboard-snapshot")).toBeNull();
  });
});

describe("ServerCache LRU eviction", () => {
  it("evicts the oldest entry on capacity overflow", () => {
    const cache = new ServerCache<number>({ maxEntries: 3, ttlMs: 60_000 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    cache.set("d", 4); // evicts "a"
    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
    expect(cache.get("d")).toBe(4);
    expect(cache.stats().evictions).toBe(1);
  });

  it("touches on read so least-recently-used is evicted", () => {
    const cache = new ServerCache<number>({ maxEntries: 3, ttlMs: 60_000 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    // Touch "a" — now "b" is the oldest.
    expect(cache.get("a")).toBe(1);
    cache.set("d", 4); // evicts "b"
    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBeNull();
    expect(cache.get("c")).toBe(3);
    expect(cache.get("d")).toBe(4);
  });

  it("re-setting an existing key does not count toward eviction", () => {
    const cache = new ServerCache<number>({ maxEntries: 2, ttlMs: 60_000 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("a", 99); // overwrite, no eviction
    expect(cache.stats().evictions).toBe(0);
    expect(cache.get("a")).toBe(99);
    expect(cache.get("b")).toBe(2);
  });
});

describe("ServerCache.deleteByPrefix", () => {
  it("removes every key with a matching prefix", () => {
    const cache = new ServerCache<number>({ maxEntries: 16, ttlMs: 60_000 });
    cache.set("user-1|analytics", 1);
    cache.set("user-1|workouts", 2);
    cache.set("user-2|analytics", 3);
    const removed = cache.deleteByPrefix("user-1|");
    expect(removed).toBe(2);
    expect(cache.get("user-1|analytics")).toBeNull();
    expect(cache.get("user-1|workouts")).toBeNull();
    expect(cache.get("user-2|analytics")).toBe(3);
  });

  it("returns 0 when no keys match", () => {
    const cache = new ServerCache<number>({ maxEntries: 16, ttlMs: 60_000 });
    cache.set("user-1|analytics", 1);
    expect(cache.deleteByPrefix("user-99|")).toBe(0);
  });
});

describe("ServerCache.wrap single-flight", () => {
  it("calls the builder once for two concurrent reads of the same key", async () => {
    const cache = new ServerCache<string>({ maxEntries: 4, ttlMs: 60_000 });
    let callCount = 0;
    let resolveBuilder: ((value: string) => void) | null = null;
    const builder = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          callCount += 1;
          resolveBuilder = resolve;
        }),
    );

    const first = cache.wrap("k", builder);
    const second = cache.wrap("k", builder);

    // Both reads have landed before the builder resolves.
    expect(callCount).toBe(1);
    resolveBuilder!("built");

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.value).toBe("built");
    expect(firstResult.outcome).toBe("miss");
    expect(secondResult.value).toBe("built");
    expect(secondResult.outcome).toBe("stampede");
    expect(builder).toHaveBeenCalledTimes(1);
    expect(cache.stats().stampedes).toBe(1);
  });

  it("returns the cached value as a hit on the third read", async () => {
    const cache = new ServerCache<string>({ maxEntries: 4, ttlMs: 60_000 });
    const builder = vi.fn(async () => "built");
    await cache.wrap("k", builder);
    const third = await cache.wrap("k", builder);
    expect(third.value).toBe("built");
    expect(third.outcome).toBe("hit");
    expect(builder).toHaveBeenCalledTimes(1);
    expect(cache.stats().hits).toBe(1);
  });

  it("clears the pending slot on builder rejection so the next call retries", async () => {
    const cache = new ServerCache<string>({ maxEntries: 4, ttlMs: 60_000 });
    let attempt = 0;
    const builder = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("transient");
      return "ok";
    });

    await expect(cache.wrap("k", builder)).rejects.toThrow("transient");
    const next = await cache.wrap("k", builder);
    expect(next.value).toBe("ok");
    expect(next.outcome).toBe("miss");
    expect(builder).toHaveBeenCalledTimes(2);
  });
});

describe("cached() observability wrapper", () => {
  it("annotates hit / miss outcome and a hashed key", async () => {
    const cache = new ServerCache<string>({
      name: "test",
      maxEntries: 4,
      ttlMs: 60_000,
    });
    const annotate = vi.fn();
    const builder = vi.fn(async () => "v");

    await cached(cache, "user-1|default", builder, annotate);
    expect(annotate).toHaveBeenCalledWith({
      meta: {
        "cache.test.outcome": "miss",
        "cache.test.key_hash": hashCacheKey("user-1|default"),
      },
    });

    annotate.mockClear();
    await cached(cache, "user-1|default", builder, annotate);
    expect(annotate).toHaveBeenCalledWith({
      meta: expect.objectContaining({
        "cache.test.outcome": "hit",
      }),
    });
  });

  it("no-ops the annotation when no annotator is passed", async () => {
    const cache = new ServerCache<string>({ maxEntries: 4, ttlMs: 60_000 });
    const value = await cached(cache, "k", async () => "v");
    expect(value).toBe("v");
  });
});

describe("ServerCache stale-while-revalidate (wrapSwr / cachedSwr)", () => {
  it("serves a fresh hit without rebuilding", async () => {
    const cache = new ServerCache<string>({
      maxEntries: 4,
      ttlMs: 60_000,
      staleTtlMs: 600_000,
    });
    const builder = vi.fn(async () => "v");
    const first = await cache.wrapSwr("k", builder);
    expect(first.outcome).toBe("miss");
    const second = await cache.wrapSwr("k", builder);
    expect(second.outcome).toBe("hit");
    expect(builder).toHaveBeenCalledTimes(1);
  });

  it("serves the stale value immediately and revalidates in the background", async () => {
    vi.useFakeTimers();
    const cache = new ServerCache<string>({
      maxEntries: 4,
      ttlMs: 1000,
      staleTtlMs: 600_000,
    });
    let calls = 0;
    const builder = vi.fn(async () => `v${++calls}`);

    // Cold compute → v1.
    const cold = await cache.wrapSwr("k", builder);
    expect(cold.value).toBe("v1");
    expect(cold.outcome).toBe("miss");

    // Past the fresh TTL but inside the stale window.
    vi.advanceTimersByTime(1500);
    const stale = await cache.wrapSwr("k", builder);
    // The active caller gets the prior value immediately — it did NOT
    // pay the cold compute.
    expect(stale.value).toBe("v1");
    expect(stale.outcome).toBe("stale");

    // The background recompute settles to a fresh value.
    await vi.runAllTimersAsync();
    expect(builder).toHaveBeenCalledTimes(2);
    const warm = await cache.wrapSwr("k", builder);
    expect(warm.value).toBe("v2");
    expect(warm.outcome).toBe("hit");
  });

  it("coalesces a burst of stale reads into a single background rebuild", async () => {
    vi.useFakeTimers();
    const cache = new ServerCache<string>({
      maxEntries: 4,
      ttlMs: 1000,
      staleTtlMs: 600_000,
    });
    // The cold build resolves immediately; the rebuild is gated on a
    // manual promise so all three stale reads fire before it settles —
    // proving they coalesce onto one in-flight rebuild.
    let releaseRebuild: (() => void) | null = null;
    let calls = 0;
    const builder = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return "v1";
      await new Promise<void>((r) => {
        releaseRebuild = r;
      });
      return "v2";
    });
    await cache.wrapSwr("k", builder);
    vi.advanceTimersByTime(1500);

    const a = await cache.wrapSwr("k", builder);
    const b = await cache.wrapSwr("k", builder);
    const c = await cache.wrapSwr("k", builder);
    expect([a.outcome, b.outcome, c.outcome]).toEqual([
      "stale",
      "stale",
      "stale",
    ]);
    // The single in-flight rebuild is still pending across the burst.
    expect(builder).toHaveBeenCalledTimes(2);
    releaseRebuild!();
    await vi.runAllTimersAsync();
    // Still exactly one cold build + one background rebuild.
    expect(builder).toHaveBeenCalledTimes(2);
  });

  it("treats an entry past the stale window as a hard miss", async () => {
    vi.useFakeTimers();
    const cache = new ServerCache<string>({
      maxEntries: 4,
      ttlMs: 1000,
      staleTtlMs: 2000,
    });
    let calls = 0;
    const builder = vi.fn(async () => `v${++calls}`);
    await cache.wrapSwr("k", builder);
    // Past ttl + staleTtl → the stale window is closed.
    vi.advanceTimersByTime(3500);
    const miss = await cache.wrapSwr("k", builder);
    expect(miss.outcome).toBe("miss");
    expect(miss.value).toBe("v2");
  });

  it("markStaleByPrefix keeps serving the prior value under SWR (no cold re-pay)", async () => {
    const cache = new ServerCache<string>({
      maxEntries: 4,
      ttlMs: 60_000,
      staleTtlMs: 600_000,
    });
    let calls = 0;
    const builder = vi.fn(async () => `v${++calls}`);
    await cache.wrapSwr("u1|k", builder);

    // Simulate a mood write marking the bucket stale rather than evicting.
    expect(cache.markStaleByPrefix("u1|")).toBe(1);

    // The next read still serves the prior value immediately (stale),
    // not a hard miss — so the active logger doesn't re-pay the compute.
    const afterMark = await cache.wrapSwr("u1|k", builder);
    expect(afterMark.outcome).toBe("stale");
    expect(afterMark.value).toBe("v1");
  });

  it("a rejected background rebuild keeps the stale value and retries next read", async () => {
    vi.useFakeTimers();
    const cache = new ServerCache<string>({
      maxEntries: 4,
      ttlMs: 1000,
      staleTtlMs: 600_000,
    });
    let calls = 0;
    const builder = vi.fn(async () => {
      calls += 1;
      if (calls === 2) throw new Error("transient");
      return `v${calls}`;
    });
    await cache.wrapSwr("k", builder);
    vi.advanceTimersByTime(1500);

    // Stale read triggers a background rebuild that rejects.
    const stale = await cache.wrapSwr("k", builder);
    expect(stale.value).toBe("v1");
    await vi.runAllTimersAsync();

    // The prior value still serves; the next read retries the build.
    const retry = await cache.wrapSwr("k", builder);
    expect(retry.outcome).toBe("stale");
    expect(retry.value).toBe("v1");
    await vi.runAllTimersAsync();
    const warm = await cache.wrapSwr("k", builder);
    expect(warm.value).toBe("v3");
  });

  it("cachedSwr annotates the outcome (hit / stale / miss)", async () => {
    vi.useFakeTimers();
    const cache = new ServerCache<string>({
      name: "moodInsights",
      maxEntries: 4,
      ttlMs: 1000,
      staleTtlMs: 600_000,
    });
    const annotate = vi.fn();
    const builder = vi.fn(async () => "v");

    await cachedSwr(cache, "u1", builder, annotate);
    expect(annotate).toHaveBeenLastCalledWith({
      meta: expect.objectContaining({ "cache.moodInsights.outcome": "miss" }),
    });

    vi.advanceTimersByTime(1500);
    annotate.mockClear();
    await cachedSwr(cache, "u1", builder, annotate);
    expect(annotate).toHaveBeenLastCalledWith({
      meta: expect.objectContaining({ "cache.moodInsights.outcome": "stale" }),
    });
  });
});

describe("global cache registry", () => {
  it("exposes the eight blueprint caches as module-scope singletons", () => {
    expect(caches.analytics).toBeDefined();
    expect(caches.medications).toBeDefined();
    expect(caches.achievements).toBeDefined();
    expect(caches.dashboardWidgets).toBeDefined();
    expect(caches.bugreportStatus).toBeDefined();
    expect(caches.workouts).toBeDefined();
    expect(caches.medicationsIntake).toBeDefined();
    expect(caches.moodAnalytics).toBeDefined();
  });

  it("__resetAllCachesForTests clears every registry instance", async () => {
    await cached(caches.analytics, "user-1|default", async () => ({ ok: 1 }));
    expect(caches.analytics.stats().size).toBe(1);
    __resetAllCachesForTests();
    expect(caches.analytics.stats().size).toBe(0);
    expect(caches.analytics.stats().hits).toBe(0);
    expect(caches.analytics.stats().misses).toBe(0);
  });
});

describe("hashCacheKey", () => {
  it("is deterministic and unsigned 32-bit", () => {
    const h1 = hashCacheKey("user-1|default");
    const h2 = hashCacheKey("user-1|default");
    expect(h1).toBe(h2);
    expect(h1).toBeGreaterThanOrEqual(0);
    expect(h1).toBeLessThanOrEqual(0xffffffff);
  });

  it("distinguishes near-identical keys", () => {
    expect(hashCacheKey("user-1|default")).not.toBe(
      hashCacheKey("user-2|default"),
    );
  });
});
