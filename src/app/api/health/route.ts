import { prisma } from "@/lib/db";
import { getWorkerStatus } from "@/lib/jobs/worker-status";
import { getSession } from "@/lib/auth/session";
import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  annotate({ action: { name: "health.check" } });

  let dbOk = true;

  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    dbOk = false;
  }

  const worker = getWorkerStatus();
  const status = dbOk && worker.running ? "ok" : "degraded";
  const statusCode = status === "ok" ? 200 : 503;

  const cacheHeaders = {
    "Cache-Control": "no-store, no-cache, must-revalidate",
  };

  // Only expose detailed info to authenticated admins
  const session = await getSession().catch(() => null);
  if (session?.user?.role === "ADMIN") {
    return NextResponse.json(
      {
        status,
        timestamp: new Date().toISOString(),
        database: dbOk ? "connected" : "disconnected",
        worker: worker.running ? "running" : "stopped",
        ...(worker.lastHeartbeat
          ? { workerLastHeartbeat: worker.lastHeartbeat }
          : {}),
      },
      { status: statusCode, headers: cacheHeaders },
    );
  }

  return NextResponse.json(
    { status },
    { status: statusCode, headers: cacheHeaders },
  );
});
