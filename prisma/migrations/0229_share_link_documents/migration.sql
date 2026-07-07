-- Document vault, Phase 3: attach hand-picked documents to a clinician share
-- link.
--
--   `clinician_share_link_documents` — frozen, write-once membership rows
--   binding a stored document to a share link. The document set a share
--   exposes is modelled as this join, never a mutable column on the link, so
--   it inherits the link's frozen-scope discipline: rows are created in the
--   same transaction as the link, each document is owner-checked at create,
--   and the set is never widened afterwards. The public share serve route
--   serves ONLY a document id present in this set for the resolved token.
--
--   Both foreign keys cascade: deleting the link or the underlying document
--   removes the membership cleanly (a shared document the owner later deletes
--   simply disappears from the link).
--
-- Additive; applies clean on a 0228 database and on a fresh database as part
-- of the ordered migration chain.

CREATE TABLE "clinician_share_link_documents" (
  "id" TEXT NOT NULL,
  "share_link_id" TEXT NOT NULL,
  "document_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "clinician_share_link_documents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "clinician_share_link_documents_share_link_id_document_id_key"
  ON "clinician_share_link_documents" ("share_link_id", "document_id");

CREATE INDEX "clinician_share_link_documents_share_link_id_idx"
  ON "clinician_share_link_documents" ("share_link_id");

CREATE INDEX "clinician_share_link_documents_document_id_idx"
  ON "clinician_share_link_documents" ("document_id");

ALTER TABLE "clinician_share_link_documents"
  ADD CONSTRAINT "clinician_share_link_documents_share_link_id_fkey"
  FOREIGN KEY ("share_link_id") REFERENCES "clinician_share_links" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "clinician_share_link_documents"
  ADD CONSTRAINT "clinician_share_link_documents_document_id_fkey"
  FOREIGN KEY ("document_id") REFERENCES "inbound_documents" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
