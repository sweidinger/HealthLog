import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { requireModuleEnabled, resolveModuleMap } from "@/lib/modules/gate";
import { annotate } from "@/lib/logging/context";
import { apiSuccess } from "@/lib/api-response";
import { cachedSwr, caches, type ServerCache } from "@/lib/cache/server-cache";
import {
  buildAchievementsResult,
  type AchievementsResult,
} from "@/lib/gamification/achievements-result";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { resolveServerLocale } from "@/lib/i18n/server-locale";
import type { NextRequest } from "next/server";

interface IosAchievement {
  id: string;
  key: string;
  title: string;
  description: string;
  iconName: string;
  unlocked: boolean;
  unlockedAt: string | null;
  progress: number;
  // v1.18.0 B5 — parity fields the web payload already carries; the iOS
  // client needs them to group badges by category, render the points
  // tally, show absolute progress (current / target) and the opaque
  // hidden-card placeholder in lock-step with the web surface.
  category: string;
  points: number;
  target: number;
  current: number;
  isHidden: boolean;
}

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  // v1.18.0 — when the account has the achievements module turned off the
  // whole gamification surface disappears: no badge evaluation, no unlock
  // persistence, no payload. Returns the 403 `module.disabled` envelope
  // verbatim so the client (web + iOS) hides the page / dashboard tile /
  // unlock toast in lock-step with this refusal.
  const gate = await requireModuleEnabled(user.id, "achievements");
  if (!gate.enabled) {
    annotate({
      action: { name: "gamification.achievements" },
      meta: { moduleDisabled: true },
    });
    return gate.response;
  }

  const formatParam = request.nextUrl.searchParams.get("format");
  const isIosFormat = formatParam === "ios";
  annotate({
    action: { name: "gamification.achievements" },
    meta: { format: isIosFormat ? "ios" : "default" },
  });

  // v1.4.34 IW-G — cache the web-shape result keyed on userId. The
  // iOS-format branch runs the locale-aware transform after the cache
  // read so the cache stays format-agnostic and the achievement-progress
  // dashboard duplicate (seen twice per dashboard mount in the v1.4.33
  // HAR) coalesces into one builder call. v1.18.0 B5 — unlock persistence
  // now happens in the handler after the cache read (idempotent), not as
  // a side effect inside the cached factory.
  // v1.18.0 B5 — resolve the per-user module map once and pass it into the
  // builder so badge categories whose owning module is disabled (sleep
  // badges when sleep is off, mood badges when mood is off) are skipped
  // from evaluation AND unlock-persistence. Resolved outside the cache so
  // a toggle change is reflected on the next read.
  const moduleMap = await resolveModuleMap(user.id);

  // v1.18.11 (W5 perf) — read via `cachedSwr`. The bucket carries a
  // 10-minute stale window; the app-wide `AchievementUnlockNotifier` polls
  // every 2 minutes, so a hard-TTL read always missed and re-paid the cold
  // build. SWR serves the prior payload instantly and warms one background
  // recompute. Persistence of `pendingUnlocks` stays OUTSIDE this read (see
  // below), so a stale-served body never skips an unlock write.
  const result = await cachedSwr(
    caches.achievements as ServerCache<AchievementsResult>,
    user.id,
    () => buildAchievementsResult(user, moduleMap),
    annotate,
  );

  // v1.18.0 B5 — persist newly unlocked achievements OUTSIDE the cached
  // factory. `createMany({ skipDuplicates: true })` is idempotent on the
  // `(userId, achievementId)` unique, so re-running it on a cache hit is
  // a no-op rather than a duplicate, and the write is never skipped just
  // because the read was served from cache.
  if (result.pendingUnlocks.length > 0) {
    await prisma.userAchievement.createMany({
      data: result.pendingUnlocks.map((u) => ({
        userId: user.id,
        achievementId: u.achievementId,
        unlockedAt: new Date(u.unlockedAt),
      })),
      skipDuplicates: true,
    });
    annotate({
      action: { name: "gamification.achievements" },
      meta: { newUnlocks: result.pendingUnlocks.length },
    });
  }

  // Strip the internal `pendingUnlocks` carrier; it never goes on the wire.
  const payload = {
    summary: result.summary,
    achievements: result.achievements,
    metrics: result.metrics,
  };

  if (isIosFormat) {
    const locale = await resolveServerLocale({
      request,
      userLocale: user.locale,
    });
    const t = getServerTranslator(locale);
    const ios: IosAchievement[] = payload.achievements.map((a) => ({
      id: a.id,
      key: a.id,
      title: t.t(a.titleKey),
      description: t.t(a.descriptionKey),
      iconName: a.icon,
      unlocked: a.unlocked,
      unlockedAt: a.completedAt,
      progress: Math.max(0, Math.min(1, a.progressPercent / 100)),
      category: a.category,
      points: a.points,
      target: a.target,
      current: a.current,
      isHidden: a.isHidden,
    }));
    return apiSuccess(ios);
  }

  return apiSuccess(payload);
});
