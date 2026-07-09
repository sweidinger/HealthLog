-- Document vault: encrypted preview thumbnails.
--
--   `document_thumbnails` — a 1:1 sibling of `inbound_documents` holding a small
--   JPEG preview (~320px long edge, q70) rendered in the background from the
--   original: images are decoded + downscaled, a PDF's first page is rasterised.
--   The blob rides `thumbnail_encrypted` in the `encrypt()`-string-as-UTF-8
--   BYTEA shape (base64 of the JPEG) `document_content_index.text_encrypted`
--   uses — a scanned medical preview is PHI, never stored in the clear or
--   logged. The canvas re-encode strips EXIF/GPS from the source, so the
--   preview is metadata-free by construction.
--
--   A SIDE TABLE, not a column on `inbound_documents`, so the list/detail
--   queries that `omit` the original blob never drag this blob into the SELECT.
--
-- Both foreign keys cascade: a deleted document (or user) takes its thumbnail
-- with it. Additive; applies clean on a 0234 database and on a fresh database.

-- CreateTable
CREATE TABLE "document_thumbnails" (
  "id" TEXT NOT NULL,
  "document_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "thumbnail_encrypted" BYTEA NOT NULL,
  "width" INTEGER NOT NULL,
  "height" INTEGER NOT NULL,
  "byte_size" INTEGER NOT NULL,
  "source_mime" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "document_thumbnails_pkey" PRIMARY KEY ("id")
);

-- 1:1 with the document.
CREATE UNIQUE INDEX "document_thumbnails_document_id_key"
  ON "document_thumbnails" ("document_id");

-- Owner-scoped queries (the backfill discovery + list-page existence probe).
CREATE INDEX "document_thumbnails_user_id_idx"
  ON "document_thumbnails" ("user_id");

ALTER TABLE "document_thumbnails"
  ADD CONSTRAINT "document_thumbnails_document_id_fkey"
  FOREIGN KEY ("document_id") REFERENCES "inbound_documents" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "document_thumbnails"
  ADD CONSTRAINT "document_thumbnails_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
