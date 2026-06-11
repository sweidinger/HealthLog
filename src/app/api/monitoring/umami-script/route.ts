import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { getPublicMonitoringSettings } from "@/lib/monitoring-settings";
import { safeFetch } from "@/lib/safe-fetch";

export const dynamic = "force-dynamic";

const NOOP_SCRIPT = "/* umami disabled */";

export const GET = apiHandler(async () => {
  annotate({ action: { name: "monitoring.umami-script" } });

  const settings = await getPublicMonitoringSettings();
  if (
    !settings.umamiEnabled ||
    !settings.umamiScriptUrl ||
    !settings.umamiWebsiteId
  ) {
    return new NextResponse(NOOP_SCRIPT, {
      status: 200,
      headers: {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "public, max-age=60",
      },
    });
  }

  // Fail-soft: an unreachable / slow / rebinding-refused upstream must
  // degrade to the noop script, not 500 the proxy route — `safeFetch`
  // THROWS on its 15 s timeout and on the connect-time public-host
  // refusal, and an uncaught throw here surfaced as a 500 on every
  // mount whenever the operator's Umami host was down or unresolvable.
  let response: Response;
  try {
    response = await safeFetch(
      settings.umamiScriptUrl,
      {
        next: { revalidate: 3600 },
      },
      // Operator-configured host — pin the connect-time IP so a low-TTL
      // DNS record cannot rebind the fetch at an internal range between
      // the input-time `isPublicUrl` accept and the socket connect.
      { requirePublicHost: true },
    );
  } catch (err) {
    // Fail-soft stays a 200, but the failure must stay observable:
    // a proper action name keeps the degraded state visible on the
    // wide-event dashboards instead of hiding behind a bare meta flag.
    annotate({
      action: { name: "monitoring.umami_script.fetch_failed" },
      meta: {
        reason:
          err instanceof Error
            ? err.message.slice(0, 200)
            : String(err).slice(0, 200),
      },
    });
    return new NextResponse(NOOP_SCRIPT, {
      status: 200,
      headers: {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "public, max-age=60",
      },
    });
  }
  if (!response.ok) {
    return new NextResponse(NOOP_SCRIPT, {
      status: 200,
      headers: {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "public, max-age=60",
      },
    });
  }

  const script = await response.text();
  return new NextResponse(script, {
    status: 200,
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=1800",
    },
  });
});
