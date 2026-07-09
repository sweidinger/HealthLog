/**
 * Per-user document-vault AI settings.
 *
 * `documentAutoReadEnabled(userId)` reads the `documentsAutoAiRead` opt-in — the
 * single switch that authorises ambient (no-per-document-tap) AI reading of
 * uploaded documents. OFF by default: the vault stays local-first and every
 * external egress needs an explicit per-document action + consent receipt.
 *
 * Two gates read this flag:
 *   - the document consent gate (`assertDocumentEgressConsent`) short-circuits an
 *     external pick when it is ON (the toggle IS the standing consent);
 *   - the auto-index-on-upload job stays strictly local when it is OFF and uses
 *     the document-order external pick when it is ON.
 */
import { prisma } from "@/lib/db";

/**
 * True when the user has opted into automatic AI reading of uploaded documents.
 * A missing row (deleted account raced against a job) resolves to `false` —
 * fail-closed to the local-first posture, never to external egress.
 */
export async function documentAutoReadEnabled(
  userId: string,
): Promise<boolean> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { documentsAutoAiRead: true },
  });
  return row?.documentsAutoAiRead ?? false;
}
