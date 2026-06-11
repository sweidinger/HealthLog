/**
 * Returns whether bug report submission is configured (GitHub token + repo).
 *
 * The bug report page uses this to gate its UI so users don't hit a silent
 * 500 when the admin hasn't set up the GitHub integration. Only two booleans
 * escape: a single `configured` flag and `isAdmin` so the page can render
 * the admin-specific copy + admin link. Token/repo granularity is kept
 * server-side (log annotation only) so we don't hand regular users a probe.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
import { cached, caches, type ServerCache } from "@/lib/cache/server-cache";

interface BugreportStatusCacheValue {
  configured: boolean;
  enabled: boolean;
  hasToken: boolean;
  hasRepo: boolean;
}

async function buildBugreportStatusValue(): Promise<BugreportStatusCacheValue> {
  const appSettings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
    select: {
      githubIssueTokenEncrypted: true,
      githubIssueRepo: true,
      bugReportEnabled: true,
    },
  });

  const hasToken = Boolean(
    appSettings?.githubIssueTokenEncrypted || process.env.GITHUB_ISSUE_TOKEN,
  );
  const hasRepo = Boolean(
    appSettings?.githubIssueRepo || process.env.GITHUB_ISSUE_REPO,
  );
  const configured = hasToken && hasRepo;
  // Default ON when the column has never been written.
  const enabled = appSettings?.bugReportEnabled !== false;

  return { configured, enabled, hasToken, hasRepo };
}

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();

  // No per-request rate limit: the payload rides the singleton server
  // cache below, so a cache hit costs zero Postgres round-trips — while
  // the former rate-limit bucket was an unconditional Postgres UPSERT
  // per request, i.e. the limiter WAS the per-request DB load it claimed
  // to prevent. The route stays authenticated; the only uncached work is
  // one `appSettings` read per 60 s process-wide.

  // Cache the global app-settings shape on a singleton key (per blueprint §3).
  // `isAdmin` lives outside the cache because it varies per request. The
  // `invalidateAppSettings()` helper called from
  // `PATCH /api/admin/app-settings` evicts this entry when bug-report
  // configuration changes.
  const status = await cached(
    caches.bugreportStatus as ServerCache<BugreportStatusCacheValue>,
    "singleton",
    () => buildBugreportStatusValue(),
    annotate,
  );

  annotate({
    action: { name: "bugreport.status" },
    meta: {
      configured: status.configured,
      enabled: status.enabled,
      has_token: status.hasToken,
      has_repo: status.hasRepo,
    },
  });

  return apiSuccess({
    configured: status.configured,
    enabled: status.enabled,
    isAdmin: user.role === "ADMIN",
  });
});
