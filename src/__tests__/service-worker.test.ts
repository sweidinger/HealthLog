/**
 * v1.15.20 — service-worker cache behaviour, evaluated in a `vm` sandbox.
 *
 * `public/sw.js` is plain script (no module system), so the test boots it
 * inside a vm context with a fake CacheStorage and dispatches the captured
 * event listeners. Three behaviours are pinned:
 *
 *   1. the offline HTML fallback only serves a shell cached under the
 *      CURRENT `CACHE_VERSION` cache names (a stale pre-update shell would
 *      reference a chunk graph that no longer exists);
 *   2. `activate` enables navigation preload and `networkFirst` consumes
 *      `event.preloadResponse` when the browser supplies it;
 *   3. `trimCache` reads the key list once and deletes the excess prefix
 *      in a single pass (the previous loop re-fetched all keys per delete).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

const SW_SOURCE = readFileSync(
  resolve(__dirname, "../../public/sw.js"),
  "utf8",
);

const ORIGIN = "https://app.example";
// `importScripts` throws in the sandbox, so the literal fallback version
// is active and the cache names are deterministic.
const CURRENT_PAGE_CACHE = "healthlog-pages-v1.4.43";
const CURRENT_STATIC_CACHE = "healthlog-static-v1.4.43";

class FakeCache {
  map = new Map<string, Response>();
  keysCalls = 0;

  private keyOf(request: RequestInfo | URL): string {
    if (typeof request === "string") return new URL(request, ORIGIN).href;
    if (request instanceof URL) return request.href;
    return request.url;
  }

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    return this.map.get(this.keyOf(request));
  }

  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    this.map.set(this.keyOf(request), response);
  }

  async addAll(urls: string[]): Promise<void> {
    for (const url of urls) {
      this.map.set(this.keyOf(url), new Response(`precached:${url}`));
    }
  }

  async keys(): Promise<Request[]> {
    this.keysCalls += 1;
    return [...this.map.keys()].map((url) => new Request(url));
  }

  async delete(request: RequestInfo | URL): Promise<boolean> {
    return this.map.delete(this.keyOf(request));
  }
}

class FakeCacheStorage {
  stores = new Map<string, FakeCache>();

  async open(name: string): Promise<FakeCache> {
    let store = this.stores.get(name);
    if (!store) {
      store = new FakeCache();
      this.stores.set(name, store);
    }
    return store;
  }

  async keys(): Promise<string[]> {
    return [...this.stores.keys()];
  }

  async delete(name: string): Promise<boolean> {
    return this.stores.delete(name);
  }

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    for (const store of this.stores.values()) {
      const hit = await store.match(request);
      if (hit) return hit;
    }
    return undefined;
  }
}

interface SwHarness {
  listeners: Map<string, (event: unknown) => void>;
  cacheStorage: FakeCacheStorage;
  navPreload: { enabled: boolean; enable: () => Promise<void> };
  context: Record<string, unknown>;
}

function bootServiceWorker(): SwHarness {
  const listeners = new Map<string, (event: unknown) => void>();
  const cacheStorage = new FakeCacheStorage();
  const navPreload = {
    enabled: false,
    enable: async () => {
      navPreload.enabled = true;
    },
  };
  const selfObj = {
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      listeners.set(type, fn);
    },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
    registration: { navigationPreload: navPreload },
    location: { origin: ORIGIN },
  };
  const context: Record<string, unknown> = {
    self: selfObj,
    caches: cacheStorage,
    importScripts: () => {
      throw new Error("no generated version file in the sandbox");
    },
    // Default: network down. Individual tests override `context.fetch`.
    fetch: async () => {
      throw new TypeError("network down");
    },
    Response,
    Request,
    URL,
    Promise,
    console,
  };
  vm.createContext(context);
  vm.runInContext(SW_SOURCE, context);
  return { listeners, cacheStorage, navPreload, context };
}

async function dispatchActivate(harness: SwHarness): Promise<void> {
  let settled: Promise<unknown> = Promise.resolve();
  harness.listeners.get("activate")!({
    waitUntil: (p: Promise<unknown>) => {
      settled = p;
    },
  });
  await settled;
}

function dispatchNavigationFetch(
  harness: SwHarness,
  path: string,
  preloadResponse?: Promise<Response | undefined>,
): Promise<Response> {
  let captured: Promise<Response> | null = null;
  harness.listeners.get("fetch")!({
    request: new Request(`${ORIGIN}${path}`, {
      headers: { accept: "text/html" },
    }),
    respondWith: (p: Promise<Response>) => {
      captured = p;
    },
    preloadResponse,
  });
  if (!captured) throw new Error("fetch handler did not respond");
  return captured;
}

describe("sw.js — activate", () => {
  it("drops stale-version caches and enables navigation preload", async () => {
    const harness = bootServiceWorker();
    const stale = await harness.cacheStorage.open("healthlog-pages-v0.0.1");
    await stale.put(`${ORIGIN}/`, new Response("stale shell"));
    await harness.cacheStorage.open(CURRENT_PAGE_CACHE);

    await dispatchActivate(harness);

    expect(harness.cacheStorage.stores.has("healthlog-pages-v0.0.1")).toBe(
      false,
    );
    expect(harness.cacheStorage.stores.has(CURRENT_PAGE_CACHE)).toBe(true);
    expect(harness.navPreload.enabled).toBe(true);
  });
});

describe("sw.js — networkFirst offline fallback", () => {
  it("never serves a shell cached under a previous CACHE_VERSION", async () => {
    const harness = bootServiceWorker();
    // A stale pre-update cache that survived into the activation gap.
    const stale = await harness.cacheStorage.open("healthlog-pages-v0.0.1");
    await stale.put(`${ORIGIN}/`, new Response("stale shell"));

    const res = await dispatchNavigationFetch(harness, "/");

    // The stale shell is ignored; the language-neutral offline page wins.
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("Offline");
  });

  it("serves the current-version page cache when offline", async () => {
    const harness = bootServiceWorker();
    const pages = await harness.cacheStorage.open(CURRENT_PAGE_CACHE);
    await pages.put(`${ORIGIN}/`, new Response("current shell"));

    const res = await dispatchNavigationFetch(harness, "/");
    expect(await res.text()).toBe("current shell");
  });

  it("falls back to the current-version precached shell when the page cache misses", async () => {
    const harness = bootServiceWorker();
    const statics = await harness.cacheStorage.open(CURRENT_STATIC_CACHE);
    await statics.addAll(["/"]);

    const res = await dispatchNavigationFetch(harness, "/");
    expect(await res.text()).toBe("precached:/");
  });

  it("consumes the navigation-preload response instead of re-fetching", async () => {
    const harness = bootServiceWorker();
    let fetchCalls = 0;
    harness.context.fetch = async () => {
      fetchCalls += 1;
      return new Response("network shell");
    };

    const res = await dispatchNavigationFetch(
      harness,
      "/",
      Promise.resolve(new Response("preloaded shell")),
    );

    expect(await res.clone().text()).toBe("preloaded shell");
    expect(fetchCalls).toBe(0);
    // The preloaded response was cached under the current page cache.
    const pages = await harness.cacheStorage.open(CURRENT_PAGE_CACHE);
    expect(await pages.match(`${ORIGIN}/`)).toBeDefined();
  });
});

describe("sw.js — networkFirst privacy gate", () => {
  it("does not cache a navigation response that carries Cache-Control: no-store", async () => {
    const harness = bootServiceWorker();
    harness.context.fetch = async () =>
      new Response("private shell", {
        headers: { "Cache-Control": "no-store" },
      });

    const res = await dispatchNavigationFetch(harness, "/");
    expect(await res.clone().text()).toBe("private shell");

    const pages = await harness.cacheStorage.open(CURRENT_PAGE_CACHE);
    expect(await pages.match(`${ORIGIN}/`)).toBeUndefined();
  });

  it("does not cache the /c/ clinician-share view even without no-store", async () => {
    const harness = bootServiceWorker();
    harness.context.fetch = async () => new Response("share shell");

    const res = await dispatchNavigationFetch(harness, "/c/hls_abc123");
    expect(await res.clone().text()).toBe("share shell");

    const pages = await harness.cacheStorage.open(CURRENT_PAGE_CACHE);
    expect(await pages.match(`${ORIGIN}/c/hls_abc123`)).toBeUndefined();
  });

  it("still caches an ordinary navigation response", async () => {
    const harness = bootServiceWorker();
    harness.context.fetch = async () => new Response("app shell");

    const res = await dispatchNavigationFetch(harness, "/measurements");
    expect(await res.clone().text()).toBe("app shell");

    const pages = await harness.cacheStorage.open(CURRENT_PAGE_CACHE);
    expect(await pages.match(`${ORIGIN}/measurements`)).toBeDefined();
  });
});

describe("sw.js — trimCache", () => {
  it("reads the key list once and deletes only the oldest excess entries", async () => {
    const harness = bootServiceWorker();
    const store = await harness.cacheStorage.open(CURRENT_PAGE_CACHE);
    for (let i = 0; i < 8; i++) {
      await store.put(`${ORIGIN}/page-${i}`, new Response(`p${i}`));
    }
    store.keysCalls = 0;

    const trimCache = (
      harness.context as { trimCache?: (name: string, max: number) => Promise<void> }
    ).trimCache;
    expect(typeof trimCache).toBe("function");
    await trimCache!(CURRENT_PAGE_CACHE, 5);

    // Single key read (the previous implementation re-read per deletion).
    expect(store.keysCalls).toBe(1);
    // Oldest three gone, newest five kept.
    expect(store.map.has(`${ORIGIN}/page-0`)).toBe(false);
    expect(store.map.has(`${ORIGIN}/page-2`)).toBe(false);
    expect(store.map.has(`${ORIGIN}/page-3`)).toBe(true);
    expect(store.map.has(`${ORIGIN}/page-7`)).toBe(true);
  });
});
