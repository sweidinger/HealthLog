import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { readLogBuffer, LOG_BUFFER_MAX } from "@/lib/logging/in-memory-buffer";
import { redactSecrets } from "@/lib/logging/redact";
import type { WideEvent } from "@/lib/logging/types";
import { NextRequest } from "next/server";
import { z } from "zod/v4";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  traceId: z.string().trim().min(1).max(200).optional(),
  level: z.enum(["debug", "info", "warn", "error"]).optional(),
  action: z.string().trim().min(1).max(200).optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

/**
 * Admin endpoint: tail of the per-process in-memory wide-event ring buffer.
 *
 * The buffer is populated by `transports.emitEvent()` so the result mirrors
 * what would be shipped to Loki (sampler-gated). Per-process and volatile —
 * see `src/lib/logging/in-memory-buffer.ts` for the limitations.
 *
 * Privacy: every event is run through `redactSecrets()` before egress so a
 * stray Bearer / hlk_ / sk- token in an `error.message` never reaches the
 * admin UI. Storage stays raw to keep diagnostics intact when shipped to
 * Loki, but the egress path here is the user-facing one.
 */
export const GET = apiHandler(async (request: NextRequest) => {
  await requireAdmin();
  annotate({ action: { name: "admin.app-logs.list" } });

  const { searchParams } = new URL(request.url);
  const parsed = querySchema.parse({
    traceId: searchParams.get("traceId") ?? undefined,
    level: searchParams.get("level") ?? undefined,
    action: searchParams.get("action") ?? undefined,
    since: searchParams.get("since") ?? undefined,
    until: searchParams.get("until") ?? undefined,
    limit: searchParams.get("limit") ?? undefined,
  });

  const events = readLogBuffer({
    traceId: parsed.traceId,
    level: parsed.level,
    action: parsed.action,
    since: parsed.since ? new Date(parsed.since) : undefined,
    until: parsed.until ? new Date(parsed.until) : undefined,
    limit: parsed.limit,
  });

  const redacted = events.map(redactEventForEgress);

  return apiSuccess({
    events: redacted,
    meta: {
      total: redacted.length,
      bufferMax: LOG_BUFFER_MAX,
    },
  });
});

/**
 * Apply `redactSecrets()` to every string-shaped field that could carry a
 * leaked credential. Keeps the structure intact so the UI can still render
 * the JSON tree.
 */
function redactEventForEgress(event: WideEvent): WideEvent {
  // structuredClone keeps us from mutating the live buffer entry.
  const out = structuredClone(event);
  if (out.error?.message) {
    out.error.message = redactSecrets(out.error.message);
  }
  if (out.error?.stack) {
    out.error.stack = redactSecrets(out.error.stack);
  }
  if (out.warnings?.length) {
    out.warnings = out.warnings.map((w) => redactSecrets(w));
  }
  if (out.http?.user_agent) {
    // UA strings are public, but a misbehaving client could shove a token
    // into one. Cheap to redact, free to keep correct.
    out.http.user_agent = redactSecrets(out.http.user_agent);
  }
  if (out.external_calls?.length) {
    out.external_calls = out.external_calls.map((c) => ({
      ...c,
      error: c.error ? redactSecrets(c.error) : c.error,
    }));
  }
  return out;
}
