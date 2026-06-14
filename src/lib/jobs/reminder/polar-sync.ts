/**
 * v1.17.0 (F4) — Polar poll-cohort sync handler.
 *
 * Poll-only: Polar AccessLink has a webhook, but HealthLog runs the simpler
 * poll model (matching Nightscout). One hourly cron tick carries no `userId`
 * and the handler iterates every user with a stored Polar token, re-syncing
 * each via `syncUserPolar`. One user's revoked grant / outage is warned and the
 * pass continues. The shared control flow lives in `./poll-cohort`.
 *
 * The queue name, cron schedule, and boss.work registration live in
 * reminder-worker.ts.
 */
import { syncUserPolar } from "@/lib/polar/sync";
import { makePollCohortHandler, type PollCohortPayload } from "./poll-cohort";

export type PolarSyncPayload = PollCohortPayload;

export const handlePolarSync = makePollCohortHandler({
  taskName: "job.polar_sync",
  findCohort: async (prisma) => {
    const users = await prisma.user.findMany({
      where: { polarAccessTokenEncrypted: { not: null } },
      select: { id: true },
    });
    return users.map((u) => u.id);
  },
  syncUser: syncUserPolar,
});
