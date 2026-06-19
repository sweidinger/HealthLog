-- v1.18.7 — passphrase second factor for clinician share links.
-- A leaked share URL on its own no longer opens the record: every new
-- link carries a high-entropy passphrase, stored only as its HMAC-SHA256
-- hash (same key as token_hash). The column is NULLABLE so every link
-- minted before this change keeps the possession-only contract and the
-- public view renders for it without a gate.
ALTER TABLE "clinician_share_links" ADD COLUMN "passphrase_hash" TEXT;
