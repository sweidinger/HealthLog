/**
 * v1.18.0 — per-user module enable/disable preferences.
 *
 *  GET   /api/auth/me/modules  — resolved `{ <moduleKey>: boolean }` map
 *                                for every toggleable module (cycle/coach
 *                                reflect their real delegated state).
 *  PATCH /api/auth/me/modules  — body `{ <moduleKey>?: boolean }`. Merges
 *                                the supplied keys into the persisted
 *                                `modulePreferencesJson` DISABLED allowlist
 *                                (field-by-field, no mass assignment) and
 *                                returns the freshly-resolved module map.
 *
 * The body schema (`modulePrefsPatchSchema`) is `strict()` over the
 * canonical toggleable key set, so a core-domain key (`weight`,
 * `bloodPressure`, `pulse`, `medications`) or any unknown key is a 422 —
 * the core measurement engine + meds can never be disabled here.
 *
 * `userId` is always narrowed from `requireAuth()`; the body never
 * carries it. The semantics are a DISABLED allowlist: a key set to
 * `false` disables that module; `true` (or absence) leaves it enabled.
 * cycle/coach keys are accepted for forward-compat but the gate ignores
 * the blob for them (they delegate to their existing source of truth).
 */
import { apiHandler, requireAuth, HttpError } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { resolveModuleMap, normalisePrefs } from "@/lib/modules/gate";
import { modulePrefsPatchSchema } from "@/lib/validations/modules";

export const dynamic = "force-dynamic";

const PATCH_RATE_LIMIT = 60;
const PATCH_WINDOW_MS = 60_000;

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "auth.me.modules.get" } });

  const modules = await resolveModuleMap(user.id);
  return apiSuccess({ modules });
});

export const PATCH = apiHandler(async (req: Request) => {
  const { user } = await requireAuth();

  const rl = await checkRateLimit(
    `modules:patch:${user.id}`,
    PATCH_RATE_LIMIT,
    PATCH_WINDOW_MS,
  );
  if (!rl.allowed) {
    const response = apiError("Too many requests", 429);
    for (const [k, v] of Object.entries(rateLimitHeaders(rl))) {
      response.headers.set(k, v);
    }
    return response;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(422, "modules.body.invalid_json");
  }

  const parsed = modulePrefsPatchSchema.safeParse(body ?? {});
  if (!parsed.success) {
    annotate({
      action: { name: "auth.me.modules.patch.invalid_shape" },
      meta: { issues: parsed.error.issues.length },
    });
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "modules.invalid",
    });
  }

  // Merge the supplied keys into the persisted DISABLED allowlist,
  // field-by-field. `normalisePrefs` strips any junk from the stored
  // row so a previously-corrupted blob can't poison the merge, and the
  // strict schema guarantees `parsed.data` carries only toggleable keys
  // (core domains were rejected at the 422 above).
  const existing = await prisma.user.findUnique({
    where: { id: user.id },
    select: { modulePreferencesJson: true },
  });
  const merged: Record<string, boolean> = normalisePrefs(
    existing?.modulePreferencesJson,
  );
  const changed: string[] = [];
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value === undefined) continue;
    merged[key] = value;
    changed.push(key);
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { modulePreferencesJson: merged },
  });

  const modules = await resolveModuleMap(user.id);

  await auditLog("user.modules.update", {
    userId: user.id,
    ipAddress: getClientIp(req),
    details: { changed },
  });

  annotate({
    action: { name: "auth.me.modules.patch" },
    meta: { changed },
  });

  return apiSuccess({ modules });
});
