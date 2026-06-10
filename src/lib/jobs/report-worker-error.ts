/**
 * Central error reporter for pg-boss worker handlers.
 *
 * Worker errors used to be visible only as a stderr line (`workerLog`)
 * — they never reached GlitchTip, so a nightly pass that failed for
 * weeks was invisible unless the operator happened to read container
 * logs. This helper gives every worker catch the same two sinks the
 * HTTP layer has:
 *
 *   1. stderr (the operator's container log), and
 *   2. GlitchTip, through the same `sendGlitchtipEvent` payload shape
 *      `api-handler.ts` uses, with the same redaction
 *      (`redactSecrets` on the message, `redactOptional` on the stack)
 *      so a Telegram bot token or Bearer credential embedded in an
 *      error message cannot leak into the incident UI.
 *
 * Fire-and-forget by contract: the reporter NEVER throws, so a sink
 * failure (GlitchTip down, settings read failing) cannot mask or
 * replace the original handler error.
 */
import { redactOptional, redactSecrets } from "@/lib/logging/redact";

/**
 * Report one worker error. `queue` is the pg-boss queue (or logical
 * pass) name; `meta` is a small pinned-shape key/value bag folded into
 * the message tail (GlitchTip's event payload has no free-form extras
 * field) — keep values to identifiers and counts, never payload data.
 */
export async function reportWorkerError(
  queue: string,
  error: unknown,
  meta: Record<string, string | number | boolean> = {},
): Promise<void> {
  const err =
    error instanceof Error
      ? error
      : new Error(typeof error === "string" ? error : "Unknown worker error");

  const metaEntries = Object.entries(meta);
  const metaSuffix =
    metaEntries.length > 0
      ? ` (${metaEntries.map(([k, v]) => `${k}=${v}`).join(" ")})`
      : "";
  const message = redactSecrets(`[${queue}] ${err.message}${metaSuffix}`);

  // Sink 1 — stderr, mirroring `workerLog("error", …)` so the operator
  // keeps the container-log trail even when GlitchTip is disabled.
  console.error(`[pg-boss] ${message}`, err);

  // Sink 2 — GlitchTip, fire-and-forget. Dynamic imports mirror the
  // api-handler forwarder (no startup cost, no import cycle).
  try {
    const [{ getGlitchtipSettings }, { sendGlitchtipEvent }] =
      await Promise.all([
        import("@/lib/monitoring-settings"),
        import("@/lib/monitoring/glitchtip"),
      ]);
    const settings = await getGlitchtipSettings();
    if (!settings.glitchtipEnabled || !settings.glitchtipDsn) return;

    await sendGlitchtipEvent({
      dsn: settings.glitchtipDsn,
      input: {
        environment: settings.glitchtipEnvironment || "production",
        message,
        level: "error",
        type: err.name || "Error",
        stack: redactOptional(err.stack),
        sourceTag: "healthlog-worker",
      },
    });
  } catch {
    // The reporter must never throw — a sink failure would otherwise
    // mask the original handler error.
  }
}
