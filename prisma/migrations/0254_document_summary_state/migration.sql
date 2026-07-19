-- Record what happened to a document's summary.
--
-- `summary_encrypted` alone cannot tell four outcomes apart: a document nobody
-- ever enqueued, one whose provider is missing, one the safety screen withheld,
-- and one still in flight all leave it NULL. The detail view read that NULL as
-- "still generating" and said so forever.
--
-- Additive and backfill-free: NONE is the default and is the truthful value for
-- every pre-existing row, because none of them were ever attempted. Rows that
-- already carry a summary are moved to READY below.

CREATE TYPE "document_summary_state" AS ENUM (
  'NONE',
  'PENDING',
  'READY',
  'WITHHELD',
  'UNAVAILABLE'
);

ALTER TABLE "inbound_documents"
  ADD COLUMN "summary_state" "document_summary_state" NOT NULL DEFAULT 'NONE';

-- A document that already holds a summary is READY, not NONE.
UPDATE "inbound_documents"
  SET "summary_state" = 'READY'
  WHERE "summary_encrypted" IS NOT NULL;
