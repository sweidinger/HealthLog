/**
 * GET /api/coach/about-me — the caller's "about me" self-description.
 * PUT /api/coach/about-me — write (or clear) the self-description.
 *
 * v1.15.20 — the user-authored context the Coach system prompt and the
 * daily briefing inject as a delimited, user-provided block (see
 * `src/lib/ai/coach/about-me.ts`). Free text, hard-capped at 4 000 chars,
 * encrypted at rest through the shared Bytes codec. An empty / whitespace
 * PUT clears the text (the row is kept with a NULL payload so `updatedAt`
 * documents the deletion instant).
 *
 * Plain text end to end: the client renders the value as a React text
 * child only — no markdown library exists in the tree and none may be
 * added (XSS posture, see the contributor notes).
 *
 * Ownership: the user id always comes from `requireAuth()`; the body
 * carries only the text. Audit rows never contain the text itself — only
 * its length — because it is free-form health prose.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import {
  decryptFromBytes,
  encryptToBytes,
} from "@/lib/ai/coach/bytes-codec";
import {
  ABOUT_ME_MAX_CHARS,
  aboutMePutSchema,
} from "@/lib/validations/about-me";

const PUT_RATE_LIMIT = 30;
const PUT_WINDOW_MS = 60_000;

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();

  const row = await prisma.userHealthProfile.findUnique({
    where: { userId: user.id },
    select: { aboutMeEncrypted: true, updatedAt: true },
  });

  let aboutMe: string | null = null;
  if (row?.aboutMeEncrypted) {
    try {
      aboutMe = decryptFromBytes(row.aboutMeEncrypted);
    } catch {
      // Fail closed per row — never surface ciphertext. The user sees an
      // empty editor and can re-write; the stale ciphertext is replaced
      // on the next save.
      aboutMe = null;
    }
  }

  annotate({
    action: { name: "coach.about_me.get" },
    meta: { present: aboutMe !== null },
  });

  return apiSuccess({
    aboutMe,
    updatedAt: row?.updatedAt?.toISOString() ?? null,
    maxChars: ABOUT_ME_MAX_CHARS,
  });
});

export const PUT = apiHandler(async (req: Request) => {
  const { user } = await requireAuth();

  const rl = await checkRateLimit(
    `coach-about-me:put:${user.id}`,
    PUT_RATE_LIMIT,
    PUT_WINDOW_MS,
  );
  if (!rl.allowed) {
    const response = apiError("Too many requests", 429);
    for (const [k, v] of Object.entries(rateLimitHeaders(rl))) {
      response.headers.set(k, v);
    }
    return response;
  }

  const { data: body, error: jsonError } = await safeJson(req, {
    maxBytes: 64 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = aboutMePutSchema.safeParse(body);
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422);
  }

  const text = parsed.data.aboutMe.trim();
  const cleared = text.length === 0;
  const payload = cleared ? null : encryptToBytes(text);

  const row = await prisma.userHealthProfile.upsert({
    where: { userId: user.id },
    create: {
      userId: user.id,
      aboutMeEncrypted: payload,
    },
    update: {
      aboutMeEncrypted: payload,
    },
    select: { updatedAt: true },
  });

  // The audit row carries the length only — the text is free-form health
  // prose and must not land in the (plaintext) audit details.
  await auditLog(
    cleared ? "coach.about_me.cleared" : "coach.about_me.updated",
    {
      userId: user.id,
      ipAddress: getClientIp(req),
      details: { length: text.length },
    },
  );

  annotate({
    action: {
      name: cleared ? "coach.about_me.cleared" : "coach.about_me.updated",
    },
    meta: { length: text.length },
  });

  return apiSuccess({
    aboutMe: cleared ? null : text,
    updatedAt: row.updatedAt.toISOString(),
    maxChars: ABOUT_ME_MAX_CHARS,
  });
});

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
