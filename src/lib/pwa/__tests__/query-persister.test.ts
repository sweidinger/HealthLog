import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";

import {
  clearPersistedQueryCache,
  isPersistableKey,
  restorePersistedQueryCache,
  startPersistingQueryCache,
} from "@/lib/pwa/query-persister";

describe("isPersistableKey — what survives to disk", () => {
  it("persists health-data query families", () => {
    expect(isPersistableKey(["dashboard", "snapshot"])).toBe(true);
    expect(isPersistableKey(["measurements", "list"])).toBe(true);
    expect(isPersistableKey(["medications"])).toBe(true);
  });

  it("never persists auth / session / admin / token families", () => {
    expect(isPersistableKey(["auth", "me"])).toBe(false);
    expect(isPersistableKey(["session"])).toBe(false);
    expect(isPersistableKey(["admin", "users"])).toBe(false);
    expect(isPersistableKey(["tokens"])).toBe(false);
    expect(isPersistableKey(["apiTokens"])).toBe(false);
  });
});

describe("persister degrades gracefully without IndexedDB", () => {
  const original = (globalThis as { indexedDB?: unknown }).indexedDB;

  beforeEach(() => {
    // jsdom/node here has no indexedDB; assert the guards no-op cleanly.
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
  });

  afterEach(() => {
    if (original !== undefined) {
      (globalThis as { indexedDB?: unknown }).indexedDB = original;
    }
  });

  it("restore resolves without throwing", async () => {
    const qc = new QueryClient();
    await expect(
      restorePersistedQueryCache(qc, "v1.18.6"),
    ).resolves.toBeUndefined();
  });

  it("start returns a callable no-op unsubscribe", () => {
    const qc = new QueryClient();
    const stop = startPersistingQueryCache(qc, "v1.18.6");
    expect(typeof stop).toBe("function");
    expect(() => stop()).not.toThrow();
  });

  it("clear resolves without throwing", async () => {
    await expect(clearPersistedQueryCache()).resolves.toBeUndefined();
  });
});

describe("persister round-trips through a fake IndexedDB", () => {
  const original = (globalThis as { indexedDB?: unknown }).indexedDB;

  afterEach(() => {
    if (original !== undefined) {
      (globalThis as { indexedDB?: unknown }).indexedDB = original;
    } else {
      delete (globalThis as { indexedDB?: unknown }).indexedDB;
    }
    vi.restoreAllMocks();
  });

  it("hydrates a saved success result and skips a foreign build version", async () => {
    // Minimal in-memory IDB shim covering the open/put/get/delete the
    // persister uses. Avoids pulling a new dev dependency.
    const store = new Map<string, unknown>();
    const makeReq = (run: () => void) => {
      const req: Record<string, unknown> = {};
      queueMicrotask(() => {
        run();
        (req.onsuccess as (() => void) | undefined)?.();
      });
      return req;
    };
    const fakeDb = {
      close() {},
      transaction() {
        return {
          objectStore() {
            return {
              put(value: unknown, key: string) {
                store.set(key, value);
                return makeReq(() => {});
              },
              get(key: string) {
                const req = makeReq(() => {});
                (req as { result?: unknown }).result = store.get(key);
                return req;
              },
              delete(key: string) {
                store.delete(key);
                return makeReq(() => {});
              },
            };
          },
          set oncomplete(fn: () => void) {
            queueMicrotask(fn);
          },
          set onerror(_fn: () => void) {},
        };
      },
    };
    (globalThis as { indexedDB?: unknown }).indexedDB = {
      open() {
        const req: Record<string, unknown> = { result: fakeDb };
        queueMicrotask(() => (req.onsuccess as () => void)?.());
        return req;
      },
    };

    const source = new QueryClient();
    source.setQueryData(["dashboard", "snapshot"], { weightKg: 81 });
    const stop = startPersistingQueryCache(source, "v1.18.6");
    // Force a flush by advancing past the 1s debounce.
    vi.useFakeTimers();
    source.setQueryData(["measurements", "list"], [{ id: "a" }]);
    vi.advanceTimersByTime(1100);
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 0));
    stop();

    const matchingBuild = new QueryClient();
    await restorePersistedQueryCache(matchingBuild, "v1.18.6");
    expect(matchingBuild.getQueryData(["dashboard", "snapshot"])).toEqual({
      weightKg: 81,
    });

    // Restored data must paint instantly BUT be marked stale so the first
    // observer background-refetches — otherwise the client's 5-minute
    // staleTime treats a minutes-old snapshot as fresh and a list opened
    // right after a mutation serves the stale pre-mutation copy.
    const restored = matchingBuild
      .getQueryCache()
      .find({ queryKey: ["dashboard", "snapshot"] });
    expect(restored?.isStale()).toBe(true);

    const foreignBuild = new QueryClient();
    await restorePersistedQueryCache(foreignBuild, "v9.9.9");
    expect(foreignBuild.getQueryData(["dashboard", "snapshot"])).toBeUndefined();
  });

  it("never clobbers a query the live cache already holds", async () => {
    // The read-after-write invariant: restore runs in an effect, possibly
    // AFTER the page already fetched a fresh (post-mutation) list. A
    // persisted STALE copy under the same key must not overwrite it — a
    // present query is always fresher than disk.
    const store = new Map<string, unknown>();
    const makeReq = (run: () => void) => {
      const req: Record<string, unknown> = {};
      queueMicrotask(() => {
        run();
        (req.onsuccess as (() => void) | undefined)?.();
      });
      return req;
    };
    const fakeDb = {
      close() {},
      transaction() {
        return {
          objectStore() {
            return {
              put(value: unknown, key: string) {
                store.set(key, value);
                return makeReq(() => {});
              },
              get(key: string) {
                const req = makeReq(() => {});
                (req as { result?: unknown }).result = store.get(key);
                return req;
              },
              delete(key: string) {
                store.delete(key);
                return makeReq(() => {});
              },
            };
          },
          set oncomplete(fn: () => void) {
            queueMicrotask(fn);
          },
          set onerror(_fn: () => void) {},
        };
      },
    };
    (globalThis as { indexedDB?: unknown }).indexedDB = {
      open() {
        const req: Record<string, unknown> = { result: fakeDb };
        queueMicrotask(() => (req.onsuccess as () => void)?.());
        return req;
      },
    };

    // Persist a STALE (empty) measurements list.
    const source = new QueryClient();
    source.setQueryData(["measurements", "list"], []);
    const stop = startPersistingQueryCache(source, "v1.18.6");
    vi.useFakeTimers();
    source.setQueryData(["measurements", "list"], []);
    vi.advanceTimersByTime(1100);
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 0));
    stop();

    // The live client already fetched the FRESH (post-mutation) row.
    const live = new QueryClient();
    live.setQueryData(["measurements", "list"], [{ id: "fresh-row" }]);

    await restorePersistedQueryCache(live, "v1.18.6");

    // The fresh row survived — the empty persisted snapshot did not win.
    expect(live.getQueryData(["measurements", "list"])).toEqual([
      { id: "fresh-row" },
    ]);
  });
});
