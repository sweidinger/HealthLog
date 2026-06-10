/**
 * v1.15.20 — user-authored "about me" self-description for the AI surfaces.
 * v1.16.0 — extended into a structured self-context: alongside the free
 * text the user can answer three short questions (chronic conditions,
 * allergies/intolerances, what the Coach should watch). Age and gender
 * are NOT stored here — they live on the User profile and are merged
 * into the composed prompt text at assembly time, so the questionnaire
 * never duplicates profile data.
 *
 * Storage: every field is encrypted at rest
 * (`UserHealthProfile.*Encrypted`, the shared Bytes codec) and injected
 * into two prompts as a clearly delimited, user-provided context block:
 *
 *   - the Coach system prompt (`getCoachSystemPrompt`, third argument), and
 *   - the daily-briefing user prompt (`/api/insights/generate` +
 *     `comprehensive-generate.ts`).
 *
 * The block carries an explicit instruction frame: the text is the user's
 * OWN words, the single source for personal context, and nothing beyond it
 * may be invented. Reads are fail-closed per row — an undecryptable payload
 * (key rotated out of the map) yields `null` rather than ciphertext.
 *
 * `pendingQuestions` — up to 3 clarifying questions the server derives
 * after a save (see `self-context-questions.ts`); the Coach composer
 * renders them as tappable suggestion chips. Encrypted JSON string[].
 *
 * Server-only — reads `@/lib/db`.
 */
import { prisma } from "@/lib/db";
import {
  decryptFromBytes,
  encryptToBytes,
} from "@/lib/ai/coach/bytes-codec";

export { ABOUT_ME_MAX_CHARS } from "@/lib/validations/about-me";

export interface SelfContext {
  aboutMe: string | null;
  conditions: string | null;
  allergies: string | null;
  coachFocus: string | null;
}

function decryptOrNull(payload: Uint8Array | null): string | null {
  if (!payload) return null;
  try {
    const text = decryptFromBytes(payload).trim();
    return text.length > 0 ? text : null;
  } catch {
    // Fail closed per field — never surface ciphertext, never throw
    // into a prompt-assembly path.
    return null;
  }
}

/**
 * Load + decrypt the caller's structured self-context. Every field is
 * independently fail-closed; a row that never existed yields all-null.
 */
export async function getSelfContextForUser(
  userId: string,
): Promise<SelfContext> {
  try {
    const row = await prisma.userHealthProfile.findUnique({
      where: { userId },
      select: {
        aboutMeEncrypted: true,
        conditionsEncrypted: true,
        allergiesEncrypted: true,
        coachFocusEncrypted: true,
      },
    });
    return {
      aboutMe: decryptOrNull(row?.aboutMeEncrypted ?? null),
      conditions: decryptOrNull(row?.conditionsEncrypted ?? null),
      allergies: decryptOrNull(row?.allergiesEncrypted ?? null),
      coachFocus: decryptOrNull(row?.coachFocusEncrypted ?? null),
    };
  } catch {
    return { aboutMe: null, conditions: null, allergies: null, coachFocus: null };
  }
}

/**
 * Back-compat shim for callers that only need the free text (kept so
 * the questions generator can cheaply inspect the prose alone).
 */
export async function getAboutMeForUser(
  userId: string,
): Promise<string | null> {
  return (await getSelfContextForUser(userId)).aboutMe;
}

/** Whole years between `dateOfBirth` and `now`; null when unknown. */
export function deriveAgeYears(
  dateOfBirth: Date | null,
  now: Date = new Date(),
): number | null {
  if (!dateOfBirth) return null;
  let age = now.getFullYear() - dateOfBirth.getFullYear();
  const beforeBirthday =
    now.getMonth() < dateOfBirth.getMonth() ||
    (now.getMonth() === dateOfBirth.getMonth() &&
      now.getDate() < dateOfBirth.getDate());
  if (beforeBirthday) age -= 1;
  return age >= 0 && age < 130 ? age : null;
}

const GENDER_LABELS: Record<"de" | "en", Record<string, string>> = {
  de: { MALE: "männlich", FEMALE: "weiblich", OTHER: "divers" },
  en: { MALE: "male", FEMALE: "female", OTHER: "non-binary" },
};

/**
 * Compose the merged self-context text the prompt block quotes: profile
 * facts first (age/gender from the User row — the single source, never
 * duplicated into the questionnaire), then the structured answers, then
 * the free text. Returns `null` when there is nothing to say — the
 * prompt assembly skips the whole block in that case.
 *
 * Labels follow the de/en split of the surrounding block builders; the
 * quoted values themselves stay in whatever language the user wrote.
 */
export function composeSelfContextText(
  ctx: SelfContext,
  profile: { ageYears: number | null; gender: string | null },
  locale: string,
): string | null {
  const de = locale === "de";
  const lines: string[] = [];

  const facts: string[] = [];
  if (profile.ageYears !== null) {
    facts.push(de ? `Alter: ${profile.ageYears}` : `Age: ${profile.ageYears}`);
  }
  if (profile.gender) {
    const label =
      GENDER_LABELS[de ? "de" : "en"][profile.gender.toUpperCase()] ?? null;
    if (label) {
      facts.push(de ? `Geschlecht: ${label}` : `Gender: ${label}`);
    }
  }
  if (facts.length > 0) {
    lines.push(
      (de ? "Profil: " : "Profile: ") + facts.join(" · "),
    );
  }

  if (ctx.conditions) {
    lines.push(
      (de ? "Chronische Erkrankungen: " : "Chronic conditions: ") +
        ctx.conditions,
    );
  }
  if (ctx.allergies) {
    lines.push(
      (de
        ? "Allergien / Unverträglichkeiten: "
        : "Allergies / intolerances: ") + ctx.allergies,
    );
  }
  if (ctx.coachFocus) {
    lines.push(
      (de ? "Darauf soll der Coach achten: " : "The Coach should watch: ") +
        ctx.coachFocus,
    );
  }
  if (ctx.aboutMe) {
    if (lines.length > 0) lines.push("");
    lines.push(ctx.aboutMe);
  }

  // Profile facts alone are not a self-description — without at least
  // one user-authored field the block stays absent, exactly like before
  // the structured fields existed.
  const hasUserContent =
    ctx.aboutMe !== null ||
    ctx.conditions !== null ||
    ctx.allergies !== null ||
    ctx.coachFocus !== null;
  if (!hasUserContent) return null;

  return lines.join("\n");
}

/**
 * One-call variant for the prompt-assembly paths: load the structured
 * context + the profile facts and return the composed text (or `null`
 * when the user never wrote anything). Replaces the v1.15.20
 * `getAboutMeForUser` call sites.
 */
export async function getSelfContextTextForUser(
  userId: string,
  locale: string,
): Promise<string | null> {
  try {
    const [ctx, user] = await Promise.all([
      getSelfContextForUser(userId),
      prisma.user.findUnique({
        where: { id: userId },
        select: { dateOfBirth: true, gender: true },
      }),
    ]);
    return composeSelfContextText(
      ctx,
      {
        ageYears: deriveAgeYears(user?.dateOfBirth ?? null),
        gender: user?.gender ?? null,
      },
      locale,
    );
  } catch {
    return null;
  }
}

/** Hard caps on the persisted clarifying questions. */
export const PENDING_QUESTIONS_MAX = 3;
export const PENDING_QUESTION_MAX_CHARS = 200;

/** Clamp + sanitise a candidate question list before persisting. */
export function clampPendingQuestions(questions: unknown): string[] {
  if (!Array.isArray(questions)) return [];
  return questions
    .filter((q): q is string => typeof q === "string")
    .map((q) => q.trim())
    .filter((q) => q.length > 0)
    .map((q) => q.slice(0, PENDING_QUESTION_MAX_CHARS))
    .slice(0, PENDING_QUESTIONS_MAX);
}

/**
 * Read the caller's pending clarifying questions. Fail-closed: a
 * missing row, NULL payload, or undecryptable ciphertext yields `[]`.
 */
export async function getPendingQuestionsForUser(
  userId: string,
): Promise<string[]> {
  try {
    const row = await prisma.userHealthProfile.findUnique({
      where: { userId },
      select: { pendingQuestionsEncrypted: true },
    });
    if (!row?.pendingQuestionsEncrypted) return [];
    return clampPendingQuestions(
      JSON.parse(decryptFromBytes(row.pendingQuestionsEncrypted)),
    );
  } catch {
    return [];
  }
}

/**
 * Persist (or clear, with `null` / `[]`) the pending questions.
 * Upserts so a user who never saved a self-context can still receive
 * the deterministic fallback hints.
 */
export async function setPendingQuestionsForUser(
  userId: string,
  questions: string[] | null,
): Promise<void> {
  const clamped = questions === null ? [] : clampPendingQuestions(questions);
  const payload =
    clamped.length > 0 ? encryptToBytes(JSON.stringify(clamped)) : null;
  await prisma.userHealthProfile.upsert({
    where: { userId },
    create: { userId, pendingQuestionsEncrypted: payload },
    update: { pendingQuestionsEncrypted: payload },
  });
}

/**
 * Compose the delimited context block the briefing user prompt appends
 * (the GLP-1-plateau / derived-signal precedent: a SYSTEM CONTEXT block
 * after the FEATURES payload). The instruction frame pins provenance —
 * user-provided, descriptive, the only personal-context source — so the
 * model never extrapolates beyond the user's own words.
 */
export function buildAboutMeInsightBlock(
  aboutMe: string,
  locale: string,
): string {
  if (locale === "de") {
    return `

SYSTEM CONTEXT — SELBSTAUSKUNFT (vom Nutzer bereitgestellt):
"""
${aboutMe}
"""
Dieser Text stammt vom Nutzer (plus Alter/Geschlecht aus dem Profil) und
ist die EINZIGE Quelle für persönlichen Kontext jenseits der Messdaten.
Nutze ihn, um die Einordnung zu personalisieren. Behandle ihn
beschreibend, nie diagnostisch. Erfinde nichts, was weder in den Daten
noch in diesem Text steht.`;
  }
  return `

SYSTEM CONTEXT — ABOUT ME (provided by the user):
"""
${aboutMe}
"""
This text comes from the user (plus age/gender from their profile) and
is the ONLY source of personal context beyond the measurement data. Use
it to personalise the assessment. Treat it as descriptive, never
diagnostic. Do not invent anything that is in neither the data nor this
text.`;
}
