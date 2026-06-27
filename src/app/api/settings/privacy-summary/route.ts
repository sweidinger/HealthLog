/**
 * GET /api/settings/privacy-summary
 *
 * Server-authoritative facts for the user-facing "Data & Privacy" dashboard:
 * the configured retention windows and a truthful encryption-at-rest summary
 * driven from the canonical `ENCRYPTED_COLUMNS` registry. No secrets, no key
 * material, no per-row data — just the numbers the dashboard renders read-only.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { ENCRYPTED_COLUMNS } from "@/lib/crypto/encrypted-columns";

export const dynamic = "force-dynamic";

/**
 * Retention windows. These mirror the defaults + env names the cleanup jobs
 * read (`coach-message-cleanup.ts`, `audit-log-cleanup.ts`, the reminder
 * cleanup handlers); read here directly so the dashboard never imports a
 * pg-boss job module. Off-host backup retention is operator infrastructure
 * (not an app setting), so it is disclosed as prose, not a number.
 */
function resolveRetention() {
  const intEnv = (name: string, fallback: number, min: number): number => {
    const raw = process.env[name];
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
  };
  return {
    coachMessagesDays: intEnv("COACH_MESSAGE_RETENTION_DAYS", 365, 30),
    auditLogDays: intEnv("AUDIT_LOG_RETENTION_DAYS", 365, 7),
    // The push-attempt + mood-dispatch ledgers are a fixed 90-day window.
    deliveryLogDays: 90,
  };
}

export const GET = apiHandler(async () => {
  await requireAuth();
  annotate({ action: { name: "settings.privacy.summary" } });

  const encryptedModels = new Set(ENCRYPTED_COLUMNS.map((c) => c.model));

  return apiSuccess({
    retention: resolveRetention(),
    encryption: {
      algorithm: "AES-256-GCM",
      columnCount: ENCRYPTED_COLUMNS.length,
      modelCount: encryptedModels.size,
    },
  });
});
