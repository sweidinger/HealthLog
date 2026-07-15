"use client";

/**
 * The document-launched entry point into the clinician share-link create flow.
 * Mounts the shared `ShareLinkCreateForm` inside a `ResponsiveSheet` (bottom
 * sheet on phones, dialog on desktop) with the picked document(s) pre-attached
 * and a label pre-filled — the owner shares the document(s) they were looking
 * at (detail sheet) or selected (bulk multi-select) without leaving for
 * Settings, and the one-time QR / passphrase reveal lands in the same surface.
 *
 * Accepts an ARRAY: a single-document share (detail sheet) passes one entry; a
 * bulk share passes the whole selection, all folded into ONE `documentOnly`
 * link (the share model carries up to `SHARE_LINK_MAX_DOCUMENTS` docs per
 * link). The label defaults to the single title, or a `{count} documents`
 * summary for a multi-doc share.
 *
 * The frozen-write-once + ≤50 rules, the EXIF note, and expiry all come from
 * the shared form as-is; the same `POST /api/share-links` handles the create
 * and re-verifies every id as the owner's own live document. The form is
 * mounted only while the sheet is open so each open starts a fresh link (the
 * one-time secret is never re-shown for a stale create).
 */
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import type { PickedDocument } from "@/components/settings/share-document-picker";
import { ShareLinkCreateForm } from "@/components/settings/share-link-create-form";
import { useTranslations } from "@/lib/i18n/context";

export function DocumentShareSheet({
  open,
  onOpenChange,
  documents,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The document(s) to pre-attach — one entry (detail) or many (bulk). */
  documents: PickedDocument[];
}) {
  const { t } = useTranslations();

  const multiple = documents.length > 1;
  // Single doc → its title; multiple → a "{count} documents" summary. The
  // owner can still edit the label in the form before minting the link.
  const label = multiple
    ? t("documents.share.multiLabel", { count: documents.length })
    : (documents[0]?.title ?? "");

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title={
        multiple ? t("documents.share.multiTitle") : t("documents.share.title")
      }
      description={t("documents.share.description")}
      contentWidth="2xl"
    >
      {open ? (
        <ShareLinkCreateForm
          documentOnly
          initialDocuments={documents}
          initialLabel={label}
        />
      ) : null}
    </ResponsiveSheet>
  );
}
