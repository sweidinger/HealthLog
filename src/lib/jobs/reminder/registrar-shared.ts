/**
 * Shared plumbing for the domain-grouped queue registrars.
 *
 * v1.18.1 — `startReminderWorker()` was a 2143-LOC monolith that declared
 * every pg-boss queue name, listed them in one `allQueues` array, scheduled
 * every cron, and bound every `boss.work` handler inline. It is now decomposed
 * into domain registrars (integration-sync, status, rollup, reminders,
 * maintenance) under `src/lib/jobs/reminder/`. Each registrar owns the four
 * facts the v1.4.37 dead-queue guards pin — the queue-name constant, its
 * `allQueues` membership, its `[QUEUE, CRON]` schedule tuple, and its
 * `boss.work(QUEUE, …, handler)` binding — so a queue can never be declared
 * without being provisioned, scheduled, and drained. The boot file composes
 * the registrars; the guards follow the wiring into each registrar module.
 *
 * Every registrar returns the queue names it created so the boot file can
 * assert a single aggregate `allQueues` (defence in depth: the per-registrar
 * arrays AND the boot-level union both have to agree).
 */
import { PgBoss } from "pg-boss";

/**
 * Cron schedule tuple: `[queueName, cronExpression, sendOptions?]`. The
 * optional third element carries per-queue send options (e.g. the LLM-bound
 * insight retry policy) merged into the `boss.schedule` call.
 */
export type ScheduleEntry = [string, string, Record<string, unknown>?];

/**
 * Shared retry policy for the LLM-bound insight queues. A transient failure
 * (provider hiccup, pool exhaustion) used to fail the nightly tick silently
 * until the NEXT night; three backed-off retries match the backfill queues'
 * established shape (see e.g. whoop-backfill.ts).
 */
export const insightRetryOptions = {
  retryLimit: 3,
  retryDelay: 60,
  retryBackoff: true,
} as const;

/**
 * Create every queue in `queues`, then schedule every cron in `schedules`.
 * Centralised so each registrar provisions before it schedules in the exact
 * order the monolith did, and the `Europe/Berlin` tz default stays in one
 * place.
 */
export async function createAndSchedule(
  boss: PgBoss,
  queues: readonly string[],
  schedules: readonly ScheduleEntry[],
): Promise<void> {
  for (const q of queues) {
    await boss.createQueue(q);
  }
  for (const [name, cron, sendOptions] of schedules) {
    await boss.schedule(
      name,
      cron,
      {},
      {
        tz: "Europe/Berlin",
        ...(sendOptions ?? {}),
      },
    );
  }
}
