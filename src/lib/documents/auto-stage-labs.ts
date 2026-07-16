/**
 * S8 — auto-stage lab facts from a freshly indexed vault document.
 *
 * After the per-document auto-index job transcribes a stored document, a
 * document that LOOKS LIKE a lab result is run through the SAME inbound
 * extraction the manual "Extract" button uses — but the facts land PENDING for
 * the existing human-review screen. Nothing is committed here: the user still
 * taps one confirm before a value becomes a `LabResult`. Marc's sign-off is
 * explicit — auto-STAGE, never auto-COMMIT.
 *
 * Gates (ALL must hold, otherwise the manual extract button is left untouched):
 *   - both the `inboundDocuments` AND `labs` modules are on for the user;
 *   - a usable document-order provider whose egress the `documentsAutoAiRead`
 *     consent gate permits — reuses `resolveIndexProvider`, so a local pick is
 *     always eligible and an external pick needs the opt-in, IDENTICAL to the
 *     auto-index external-egress gate;
 *   - the document is still STORED with no staged facts — so a re-index, the
 *     manual path, or the labs→vault cross-link (S9) never double-stages;
 *   - the transcribed text reads like a lab report (a cheap keyword heuristic,
 *     or the user filed it under kind LAB_RESULT), so an arbitrary photo never
 *     burns an extraction call.
 *
 * It reuses the transcription the auto-index already produced (the encrypted
 * content index) and runs the extraction in TEXT mode, so no second vision call
 * is spent. The staging transition is a guarded `STORED → EXTRACTED` update:
 * if the labs-filing cross-link (S9) or the manual path moved the document
 * first, the guard matches zero rows and the auto-stage aborts without touching
 * any fact — the two writers can never corrupt each other's facts.
 */
import { AI_BUDGETS } from "@/lib/ai/ai-budgets";
import {
  buildDateKey,
  reconcileSpend,
  reserveBudget,
} from "@/lib/ai/coach/budget";
import { loadDocumentChatText } from "@/lib/documents/content-index";
import { resolveIndexProvider } from "@/lib/documents/index-document";
import {
  InboundExtractError,
  runInboundExtraction,
  type InboundExtractionResult,
} from "@/lib/documents/extract";
import { encryptFactData, encryptFactProvenance } from "@/lib/documents/store";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { isModuleEnabled } from "@/lib/modules/gate";

/**
 * Lab-report signals used to decide whether a transcribed document is worth an
 * extraction call. Each pattern is one class of evidence (a reference-range
 * label, a lab unit, a common analyte name, a report header); requiring TWO
 * distinct hits keeps a stray "mg" in a prose letter from tripping the auto
 * extraction while still catching a real panel in German or English.
 */
const LAB_SIGNALS: readonly RegExp[] = [
  /reference range|referenzbereich|normbereich|normal range|ref\.?-?bereich/i,
  /\b(mg\/dl|mmol\/l|nmol\/l|µmol\/l|umol\/l|g\/dl|µg\/l|ug\/l|ng\/ml|pg\/ml|mmol\/mol|u\/l|iu\/l|mg\/l|\/µl|\/ul)\b/i,
  /h(?:ä|ae)moglobin|hemoglobin|glu[ck]ose|cholesterin|cholesterol|kreatinin|creatinine|hba1c|leuko|erythro|thrombo|ferritin|triglycerid|\btsh\b|\bldl\b|\bhdl\b|\bcrp\b|vitamin\s?d/i,
  /labor(?:befund|wert)?|laboratory|blutbild|\bbefund\b/i,
];

/** True when the transcribed text carries at least two lab-report signals. */
export function looksLikeLabDocument(text: string): boolean {
  let hits = 0;
  for (const signal of LAB_SIGNALS) {
    if (signal.test(text) && ++hits >= 2) return true;
  }
  return false;
}

/** Why an auto-stage attempt did not stage — every branch leaves the manual path intact. */
export type AutoStageOutcome =
  | { staged: true; facts: number }
  | {
      staged: false;
      reason:
        | "modules-off"
        | "not-eligible"
        | "already-handled"
        | "no-text"
        | "not-lab"
        | "budget"
        | "extract-failed"
        | "raced";
    };

/**
 * Guarded `STORED → EXTRACTED` transition + PENDING fact creation in one
 * transaction. Returns the staged count, or `null` when the document was no
 * longer STORED (another writer moved it first) — the caller treats `null` as a
 * clean no-op, never an error.
 */
async function stageFactsIfStored(
  userId: string,
  documentId: string,
  result: InboundExtractionResult,
): Promise<number | null> {
  return prisma.$transaction(async (tx) => {
    const moved = await tx.inboundDocument.updateMany({
      where: { id: documentId, userId, status: "STORED", deletedAt: null },
      data: {
        status: "EXTRACTED",
        providerType: result.providerType,
        reportDate: result.reportDate
          ? new Date(`${result.reportDate}T00:00:00.000Z`)
          : null,
      },
    });
    if (moved.count === 0) return null;
    if (result.facts.length === 0) return 0;
    await tx.extractedFact.createMany({
      data: result.facts.map((f) => ({
        documentId,
        userId,
        factType: f.factType,
        status: "PENDING" as const,
        confidence: f.confidence,
        needsReview: f.needsReview,
        dataEncrypted: encryptFactData(f.data),
        provenanceEncrypted: encryptFactProvenance(f.provenance),
      })),
    });
    return result.facts.length;
  });
}

/**
 * Auto-stage lab facts for one freshly indexed document (owner-scoped). Called
 * fire-and-forget by the auto-index job after a successful index; every guard
 * miss returns a tagged no-op so the manual extract button stays the fallback.
 */
export async function maybeAutoStageLabFacts(
  userId: string,
  documentId: string,
): Promise<AutoStageOutcome> {
  const [inboundOn, labsOn] = await Promise.all([
    isModuleEnabled(userId, "inboundDocuments"),
    isModuleEnabled(userId, "labs"),
  ]);
  if (!inboundOn || !labsOn) return { staged: false, reason: "modules-off" };

  // Idempotency floor: only a still-STORED document with no facts is a
  // candidate. A re-index, the manual extract path, or the S9 cross-link all
  // leave a non-STORED / already-staged document alone.
  const doc = await prisma.inboundDocument.findFirst({
    where: { id: documentId, userId, deletedAt: null },
    select: { kind: true, status: true, _count: { select: { facts: true } } },
  });
  if (!doc || doc.status !== "STORED" || doc._count.facts > 0) {
    return { staged: false, reason: "already-handled" };
  }

  // Same provider + consent gate the auto-index external path uses.
  const provider = await resolveIndexProvider(userId);
  if (!provider.pick || !provider.consentOk) {
    return { staged: false, reason: "not-eligible" };
  }

  // Reuse the transcription the auto-index just produced — no second vision call.
  const chat = await loadDocumentChatText(userId, documentId);
  if (!chat || !chat.text.trim()) return { staged: false, reason: "no-text" };

  if (doc.kind !== "LAB_RESULT" && !looksLikeLabDocument(chat.text)) {
    return { staged: false, reason: "not-lab" };
  }

  // A text-structuring pass, not a vision call — reserve the proportionate
  // ceiling under the same daily cap the auto-index resolved.
  const dateKey = buildDateKey();
  const reservation = await reserveBudget(
    userId,
    AI_BUDGETS.ocrExtractText.maxTokens,
    dateKey,
    provider.dailyCap,
  );
  if (!reservation.allowed) return { staged: false, reason: "budget" };

  let result: InboundExtractionResult;
  try {
    result = await runInboundExtraction({
      provider: provider.pick.entry.instance,
      providerType: provider.pick.providerType,
      ocrText: chat.text,
    });
    await reconcileSpend(
      userId,
      reservation.reserved,
      reservation.reserved,
      dateKey,
    );
  } catch (err) {
    await reconcileSpend(userId, reservation.reserved, 0, dateKey);
    if (!(err instanceof InboundExtractError)) {
      annotate({
        action: { name: "documents.autoStage.failed" },
        meta: { documentId, reason: "provider_error" },
      });
    }
    return { staged: false, reason: "extract-failed" };
  }

  const staged = await stageFactsIfStored(userId, documentId, result);
  if (staged === null) return { staged: false, reason: "raced" };

  annotate({
    action: { name: "documents.autoStage.labs" },
    meta: {
      documentId,
      facts: staged,
      provider: provider.pick.providerType,
      byKind: doc.kind === "LAB_RESULT",
    },
  });
  return { staged: true, facts: staged };
}
