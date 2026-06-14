/**
 * v1.16.13 — web AI-consent receipt minting.
 *
 * The `ConsentReceipt` gate (`src/lib/ai/consent-guard.ts`, shipped in
 * commit 37e9f32f) requires an active receipt before any health snapshot
 * egresses via the operator's server-managed OpenAI key (`admin-openai`).
 * iOS mints an `ai_full` receipt on consent grant + once per shell mount
 * to heal existing accounts. The web client never minted one, so web users
 * on a shared-key deployment saw the fail-closed no-key fallback on every
 * AI surface.
 *
 * This helper closes that gap: it mints an `ai_full` receipt for the web
 * user when none is active, mirroring the iOS master-grant pattern. It is
 * idempotent — a user with an active `ai_full` receipt is a no-op, so it is
 * safe to call on every AI-settings mount (the web equivalent of the iOS
 * shell-mount heal). Explicit revocation flows through the existing
 * `DELETE /api/consent/ai/latest`; this helper only ever grants.
 *
 * The artefact is a small JSON record of the web grant context (no signed
 * PDF/JWT — the web grant is an in-app affirmative action recorded with its
 * timestamp + source, which is the GDPR Art. 7 audit signal the legal team
 * needs). It stays well under the 64 KB artefact cap.
 */
import { createReceipt, latestActiveReceipt } from "@/lib/consent/receipts";
import type { ConsentReceipt } from "@/lib/consent/receipts";

/** Outcome of an idempotent web-grant call. */
export type WebConsentGrantResult =
  | { minted: true; receipt: ConsentReceipt }
  | { minted: false };

/**
 * Ensure the web user has an active `ai_full` consent receipt, minting one
 * if absent. Idempotent: returns `{ minted: false }` when an active master
 * grant already exists, so callers can invoke it freely on mount.
 *
 * Mirrors the iOS `ai_full` grant. `ai_full` is the master kind that
 * satisfies every surface gate (insights + coach), matching the iOS app's
 * single master toggle rather than per-surface web grants.
 */
export async function ensureWebAiConsentReceipt(
  userId: string,
  now: Date = new Date(),
): Promise<WebConsentGrantResult> {
  const existing = await latestActiveReceipt(userId, "ai_full");
  if (existing) return { minted: false };

  const artefact = JSON.stringify({
    source: "web",
    kind: "ai_full",
    grantedAt: now.toISOString(),
    note: "In-app affirmative AI consent granted via the web client.",
  });

  const receipt = await createReceipt(userId, "ai_full", artefact, now);
  return { minted: true, receipt };
}
