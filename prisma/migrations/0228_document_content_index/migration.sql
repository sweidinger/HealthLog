-- Document vault P2: the blind content-search index.
--
--   `document_content_index` — a 1:1 sibling of `inbound_documents` that makes
--   a document searchable INSIDE its body without ever storing the body in the
--   clear. Two artefacts per row:
--     - `text_encrypted` — AES-256-GCM ciphertext of the normalised extracted
--       text (the `encrypt()`-string-as-UTF-8 BYTEA shape every other PHI
--       column uses). Recoverable server-side so key rotation can re-tokenise.
--     - `search_tokens` — deduped HMAC-SHA256 (truncated hex) of the normalised
--       tokens, under an HKDF-derived index subkey. One-way / opaque at rest.
--   A GIN index over `search_tokens` accelerates the array-overlap (`&&`)
--   predicate the list search unions with the title/filename ILIKE. Prisma
--   cannot express a GIN index, so it lives here as raw SQL.
--
-- Both foreign keys cascade: a deleted document (or user) takes its index with
-- it. Additive; applies clean on a 0227 database and on a fresh database.

-- CreateTable
CREATE TABLE "document_content_index" (
  "id" TEXT NOT NULL,
  "document_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "text_encrypted" BYTEA NOT NULL,
  "search_tokens" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "source" TEXT NOT NULL,
  "provider_type" TEXT,
  "tokenizer_version" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "document_content_index_pkey" PRIMARY KEY ("id")
);

-- 1:1 with the document.
CREATE UNIQUE INDEX "document_content_index_document_id_key"
  ON "document_content_index" ("document_id");

-- Owner-scoped queries (the usage gauge + the backfill discovery).
CREATE INDEX "document_content_index_user_id_idx"
  ON "document_content_index" ("user_id");

-- Blind-token search: GIN over the token array for the array-overlap (`&&`)
-- match the list search runs. Documented in schema.prisma — Prisma cannot
-- express a GIN index, so it lives here as raw SQL.
CREATE INDEX "document_content_index_search_tokens_gin"
  ON "document_content_index" USING GIN ("search_tokens");

ALTER TABLE "document_content_index"
  ADD CONSTRAINT "document_content_index_document_id_fkey"
  FOREIGN KEY ("document_id") REFERENCES "inbound_documents" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "document_content_index"
  ADD CONSTRAINT "document_content_index_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
