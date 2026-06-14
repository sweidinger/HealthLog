/**
 * GET /api/sleep/rhythm
 *
 * v1.17.0 — server-authoritative sleep-rhythm read. Returns the two timing
 * signals the Sleep page + the iOS client render off the SAME canonical night
 * reconstruction the Sleep Score uses:
 *
 *   - `sleepDebt`   — cumulative deficit over the rolling window, with a calm
 *                     `partial` state under the night threshold.
 *   - `chronotype`  — MCTQ MSF / MSFsc band + social jetlag, with a `learning`
 *                     state until enough free-day nights exist.
 *
 * The math lives in `sleep-debt.ts` / `chronotype.ts`; this route is the auth +
 * read boundary over `buildSleepRhythm`, which owns the DB read, the canonical
 * reconstruction, the age-based `needMinutes`, and the weekday/weekend day-type
 * default. No schema, no new type — a view over the existing per-stage
 * `SLEEP_DURATION` rows.
 *
 * Auth: cookie session OR Bearer token (`requireAuth`). Soft-delete-filtered.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { buildSleepRhythm } from "@/lib/insights/derived/sleep-rhythm";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();

  const rhythm = await buildSleepRhythm(user.id);

  annotate({
    action: { name: "sleep.rhythm" },
    meta: {
      debt_state: rhythm.sleepDebt.state,
      debt_minutes: rhythm.sleepDebt.debtMinutes,
      chronotype_state: rhythm.chronotype.state,
      chronotype_band: rhythm.chronotype.band,
    },
  });

  return apiSuccess(rhythm);
});
