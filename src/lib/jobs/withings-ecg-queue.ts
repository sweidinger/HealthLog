import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { z } from "zod/v4";

const unixSecondsSchema = z.coerce.number().int().nonnegative().safe();

export const WITHINGS_ECG_SYNC_QUEUE = "withings-ecg-sync";

export interface WithingsEcgSyncPayload {
  userId: string;
  eventId: string;
  triggeredAt: string;
  startdate?: number;
  enddate?: number;
}

export interface WithingsEcgEventIdentity {
  userId: string;
  withingsUserId: string;
  appli: number | null;
  startdate: string | null;
  enddate: string | null;
}

export async function enqueueWithingsEcgSync(
  identity: WithingsEcgEventIdentity,
): Promise<"enqueued" | "known"> {
  const boss = getGlobalBoss();
  if (!boss) {
    throw new Error("pg-boss producer is unavailable");
  }

  const eventId = [
    identity.withingsUserId,
    identity.appli ?? "unknown",
    identity.startdate ?? "unknown",
    identity.enddate ?? "unknown",
  ].join(":");
  const parsedStartdate =
    identity.startdate === null
      ? null
      : unixSecondsSchema.safeParse(identity.startdate);
  const parsedEnddate =
    identity.enddate === null
      ? null
      : unixSecondsSchema.safeParse(identity.enddate);
  const jobId = await boss.send(
    WITHINGS_ECG_SYNC_QUEUE,
    {
      userId: identity.userId,
      eventId,
      triggeredAt: new Date().toISOString(),
      ...(parsedStartdate?.success
        ? { startdate: parsedStartdate.data }
        : {}),
      ...(parsedEnddate?.success ? { enddate: parsedEnddate.data } : {}),
    } satisfies WithingsEcgSyncPayload,
    {
      singletonKey: `withings-ecg:${identity.userId}:${eventId}`,
      retryLimit: 3,
      retryDelay: 60,
      retryBackoff: true,
    },
  );

  return jobId ? "enqueued" : "known";
}
