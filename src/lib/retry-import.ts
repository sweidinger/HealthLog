/**
 * Retrying wrapper for lazy chunk imports.
 *
 * A rejected `import()` inside `React.lazy` / `next/dynamic` caches its
 * rejection on the component instance, so one transient chunk 404 (a
 * stale shell right after a deploy, a flaky connection) bricks the lazy
 * boundary for the rest of the session — remounting never re-attempts
 * the import. Wrapping the importer here absorbs the transient class:
 * the import retries once after a short delay before the rejection is
 * allowed to surface to the boundary's error handling.
 */

export const IMPORT_RETRY_DELAY_MS = 1_000;

/**
 * Run `importer`, retrying `retries` more times (default once) after
 * `delayMs` when it rejects. The final rejection propagates unchanged
 * so the caller's error boundary sees the original chunk error.
 */
export async function importWithRetry<T>(
  importer: () => Promise<T>,
  retries = 1,
  delayMs = IMPORT_RETRY_DELAY_MS,
): Promise<T> {
  try {
    return await importer();
  } catch (err) {
    if (retries <= 0) throw err;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return importWithRetry(importer, retries - 1, delayMs);
  }
}
