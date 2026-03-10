import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { apiHandler } from "@/lib/api-handler";

/**
 * CSP violation report endpoint.
 * Receives browser-reported Content-Security-Policy violations
 * and logs them as structured wide events for monitoring via Loki.
 */
export const POST = apiHandler(async (request: NextRequest) => {
  const ip = getClientIp(request);

  // Rate limit to prevent abuse (50 reports per minute per IP)
  const rl = await checkRateLimit(`csp-report:${ip}`, 50, 60_000);
  if (!rl.allowed) {
    return new NextResponse(null, { status: 429 });
  }

  let payload: Record<string, unknown> = {};
  try {
    const raw = await request.text();
    if (raw.length > 10_000) {
      return new NextResponse(null, { status: 413 });
    }
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return new NextResponse(null, { status: 400 });
  }

  // Browsers send either { "csp-report": { ... } } or { ... } depending on report-uri vs report-to
  const report =
    (payload["csp-report"] as Record<string, unknown> | undefined) ?? payload;

  annotate({
    action: { name: "csp.violation" },
    meta: {
      blocked_uri: String(report["blocked-uri"] ?? report["blockedURL"] ?? ""),
      violated_directive: String(
        report["violated-directive"] ?? report["effectiveDirective"] ?? "",
      ),
      document_uri: String(
        report["document-uri"] ?? report["documentURL"] ?? "",
      ),
      source_file: String(report["source-file"] ?? report["sourceFile"] ?? ""),
      line_number: report["line-number"] ?? report["lineNumber"] ?? null,
      disposition: String(report["disposition"] ?? ""),
    },
  });

  return new NextResponse(null, { status: 204 });
});
