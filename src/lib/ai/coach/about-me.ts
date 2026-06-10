/**
 * v1.15.20 — user-authored "about me" self-description for the AI surfaces.
 *
 * The user writes a short free-text introduction (conditions they want the
 * Coach to know about, life context, goals — whatever they choose to share)
 * in Settings → AI. The text is stored encrypted at rest
 * (`UserHealthProfile.aboutMeEncrypted`, the shared Bytes codec) and is
 * injected into two prompts as a clearly delimited, user-provided context
 * block:
 *
 *   - the Coach system prompt (`getCoachSystemPrompt`, third argument), and
 *   - the daily-briefing user prompt (`/api/insights/generate` +
 *     `comprehensive-generate.ts`).
 *
 * The block carries an explicit instruction frame: the text is the user's
 *  OWN words, the single source for personal context, and nothing beyond it
 * may be invented. Reads are fail-closed per row — an undecryptable payload
 * (key rotated out of the map) yields `null` rather than ciphertext.
 *
 * Server-only — reads `@/lib/db`.
 */
import { prisma } from "@/lib/db";
import { decryptFromBytes } from "@/lib/ai/coach/bytes-codec";

export { ABOUT_ME_MAX_CHARS } from "@/lib/validations/about-me";

/**
 * Load + decrypt the caller's "about me" text. Returns `null` when the
 * user never wrote one, cleared it, or the payload no longer decrypts
 * (fail closed — never surface ciphertext, never throw into a prompt
 * assembly path).
 */
export async function getAboutMeForUser(userId: string): Promise<string | null> {
  try {
    const row = await prisma.userHealthProfile.findUnique({
      where: { userId },
      select: { aboutMeEncrypted: true },
    });
    if (!row?.aboutMeEncrypted) return null;
    const text = decryptFromBytes(row.aboutMeEncrypted).trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
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
Dieser Text stammt wörtlich vom Nutzer und ist die EINZIGE Quelle für
persönlichen Kontext jenseits der Messdaten. Nutze ihn, um die Einordnung
zu personalisieren. Behandle ihn beschreibend, nie diagnostisch. Erfinde
nichts, was weder in den Daten noch in diesem Text steht.`;
  }
  return `

SYSTEM CONTEXT — ABOUT ME (provided by the user):
"""
${aboutMe}
"""
This text is the user's own words and the ONLY source of personal context
beyond the measurement data. Use it to personalise the assessment. Treat
it as descriptive, never diagnostic. Do not invent anything that is in
neither the data nor this text.`;
}
