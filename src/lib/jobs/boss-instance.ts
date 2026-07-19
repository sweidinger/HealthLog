/**
 * Process-local pg-boss access.
 *
 * Worker processes install their fully supervised consumer here. Web-only
 * processes install a lightweight producer so request-time writes can enqueue
 * jobs across the documented split deployment.
 */
import { PgBoss } from "pg-boss";

const BOSS_KEY = "__healthlog_pgboss__" as const;
const BOSS_START_KEY = "__healthlog_pgboss_start__" as const;
const PRODUCER_POOL_MAX = 2;
const PRODUCER_START_MAX_ATTEMPTS = 5;
const PRODUCER_START_RETRY_DELAY_MS = 1_000;

export interface ProducerStartOptions {
  maxAttempts?: number;
  retryDelayMs?: number;
}

function wait(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

export function setGlobalBoss(boss: PgBoss) {
  (globalThis as Record<string, unknown>)[BOSS_KEY] = boss;
}

export function getGlobalBoss(): PgBoss | null {
  return ((globalThis as Record<string, unknown>)[BOSS_KEY] as PgBoss) ?? null;
}

/**
 * Start the web process's send-only pg-boss connection exactly once.
 *
 * `PgBoss.start()` is still required to open/check the database connection.
 * Disabling migration, schedules, and supervision keeps this process from
 * performing worker duties; `send()` remains available through the manager.
 */
export async function startGlobalBossProducer(
  connectionString: string | null | undefined,
  options: ProducerStartOptions = {},
): Promise<PgBoss | null> {
  if (!connectionString) return null;

  const globalState = globalThis as Record<string, unknown>;
  const existing = getGlobalBoss();
  if (existing) return existing;

  const starting = globalState[BOSS_START_KEY] as
    Promise<PgBoss | null> | undefined;
  if (starting) return starting;

  const maxAttempts = Math.max(
    1,
    Math.trunc(options.maxAttempts ?? PRODUCER_START_MAX_ATTEMPTS),
  );
  const retryDelayMs = Math.max(
    0,
    options.retryDelayMs ?? PRODUCER_START_RETRY_DELAY_MS,
  );
  const startPromise = (async () => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const boss = new PgBoss({
        connectionString,
        max: PRODUCER_POOL_MAX,
        migrate: false,
        schedule: false,
        supervise: false,
      });
      boss.on("error", (error: unknown) => {
        console.error("[pg-boss-producer] error", error);
      });
      try {
        await boss.start();
        setGlobalBoss(boss);
        return boss;
      } catch (error) {
        lastError = error;
        await boss.stop({ graceful: false }).catch(() => {});
        if (attempt < maxAttempts) {
          await wait(retryDelayMs);
        }
      }
    }
    throw lastError;
  })();

  globalState[BOSS_START_KEY] = startPromise;
  try {
    return await startPromise;
  } catch (error) {
    delete globalState[BOSS_START_KEY];
    throw error;
  }
}
