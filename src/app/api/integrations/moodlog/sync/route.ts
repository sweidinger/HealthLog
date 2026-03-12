import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess, apiError } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { syncMoodLogEntries } from "@/lib/moodlog/sync";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "moodlog.sync" } });

  // Check global toggle
  const appSettings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
    select: { moodLogGlobal: true },
  });
  if (appSettings && !appSettings.moodLogGlobal) {
    return apiError("moodLog integration is disabled", 403);
  }

  let fullSync = false;
  try {
    const body = await request.json();
    fullSync = body?.fullSync === true;
  } catch {
    // No body or invalid JSON — use defaults
  }

  const imported = await syncMoodLogEntries(user.id, {
    fullSync,
  });
  return apiSuccess({ imported });
});
