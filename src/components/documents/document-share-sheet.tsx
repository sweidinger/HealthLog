"use client";

/**
 * The document-launched entry point into the clinician share-link create flow.
 * Mounts the shared `ShareLinkCreateForm` inside a `ResponsiveSheet` (bottom
 * sheet on phones, dialog on desktop) with the current document pre-attached
 * and its title pre-filled as the link label — the owner shares the document
 * they were looking at without leaving for Settings, and the one-time QR /
 * passphrase reveal lands in the same surface.
 *
 * The frozen-write-once + ≤50 rules, the EXIF note, and expiry all come from
 * the shared form as-is; the same `POST /api/share-links` handles the create.
 * The form is mounted only while the sheet is open so each open starts a fresh
 * link (the one-time secret is never re-shown for a stale create).
 */
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { ShareLinkCreateForm } from "@/components/settings/share-link-create-form";
import { useTranslations } from "@/lib/i18n/context";

export function DocumentShareSheet({
  open,
  onOpenChange,
  documentId,
  documentTitle,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  documentId: string;
  documentTitle: string;
}) {
  const { t } = useTranslations();

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("documents.share.title")}
      description={t("documents.share.description")}
      contentWidth="2xl"
    >
      {open ? (
        <ShareLinkCreateForm
          documentOnly
          initialDocuments={[{ id: documentId, title: documentTitle }]}
          initialLabel={documentTitle}
        />
      ) : null}
    </ResponsiveSheet>
  );
}
