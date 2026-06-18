/**
 * Minimal IndexedDB-backed TanStack Query persistence (v1.18.6).
 *
 * No external persister dependency: a tiny IDB key/value store plus a manual
 * dehydrate-on-cache-change / hydrate-on-boot bridge. The goal is offline
 * READ value — an installed PWA opened offline hydrates the last cached
 * dashboard/series instantly instead of painting empty skeletons forever.
 *
 * Safety:
 *  - Only successful (`status: "success"`) query results are persisted.
 *  - A small denylist keeps obviously sensitive query families out of disk
 *    (auth/session/admin/tokens), defence-in-depth alongside the SW boundary.
 *  - `clearPersistedQueryCache()` is called on logout so a shared device never
 *    leaks one account's cached health data to the next.
 *  - Respects the centralised queryKey factory: it reads existing query keys,
 *    it never invents new ones.
 */

import {
  dehydrate,
  hydrate,
  type DehydratedState,
  type QueryClient,
} from "@tanstack/react-query";

const DB_NAME = "healthlog-query-cache";
const STORE = "kv";
const KEY = "react-query";
const VERSION_KEY = "react-query-version";
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // discard anything older than a day

/** Query-key families never written to disk (defence in depth). */
const PERSIST_DENYLIST = [
  "auth",
  "session",
  "sessions",
  "admin",
  "tokens",
  "apiTokens",
];

export function isPersistableKey(queryKey: readonly unknown[]): boolean {
  const head = queryKey[0];
  if (typeof head !== "string") return true;
  return !PERSIST_DENYLIST.includes(head);
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(value: unknown): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function idbGet<T>(): Promise<T | undefined> {
  const db = await openDb();
  const result = await new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(KEY);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return result;
}

interface PersistedPayload {
  buildVersion: string;
  savedAt: number;
  state: DehydratedState;
}

/**
 * Restore persisted query data into the client (called once before the first
 * paint of the authenticated shell). A build-version or age mismatch discards
 * the snapshot rather than hydrating a stale/foreign-schema cache.
 */
export async function restorePersistedQueryCache(
  queryClient: QueryClient,
  buildVersion: string,
): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  try {
    const payload = await idbGet<PersistedPayload>();
    if (!payload) return;
    if (payload.buildVersion !== buildVersion) {
      await clearPersistedQueryCache();
      return;
    }
    if (Date.now() - payload.savedAt > MAX_AGE_MS) {
      await clearPersistedQueryCache();
      return;
    }
    hydrate(queryClient, payload.state);
  } catch {
    // Persistence is best-effort; never block boot on a cache restore.
  }
}

/**
 * Subscribe to cache changes and debounce-persist successful, persistable
 * queries to IndexedDB. Returns an unsubscribe function.
 */
export function startPersistingQueryCache(
  queryClient: QueryClient,
  buildVersion: string,
): () => void {
  if (typeof indexedDB === "undefined") return () => {};

  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    const state = dehydrate(queryClient, {
      shouldDehydrateQuery: (query) =>
        query.state.status === "success" && isPersistableKey(query.queryKey),
    });
    const payload: PersistedPayload = {
      buildVersion,
      savedAt: Date.now(),
      state,
    };
    void idbSet(payload).catch(() => {
      /* best effort */
    });
  };

  const unsubscribe = queryClient.getQueryCache().subscribe(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 1000);
  });

  return () => {
    if (timer) clearTimeout(timer);
    unsubscribe();
  };
}

/** Wipe the persisted cache. Call on logout (shared-device data hygiene). */
export async function clearPersistedQueryCache(): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(KEY);
      tx.objectStore(STORE).delete(VERSION_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* best effort */
  }
}
