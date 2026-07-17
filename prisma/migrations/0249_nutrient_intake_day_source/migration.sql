-- v1.29 — `source` joins the `nutrient_intake_days` primary key so a
-- manual water entry and the Apple-synced day total coexist as two rows
-- instead of the manual write being silently clobbered by the next
-- Apple last-writer-wins sync (the batch route always upserts the
-- (userId, day, nutrient) row with the CURRENT running total, so a
-- manual increment folded into that same row would vanish on the next
-- sync — a data-loss bug by construction, not a rare race).
--
-- No data rewrite: every existing row already carries
-- `source = 'APPLE_HEALTH'` (the column default since migration 0241),
-- so dropping and recreating the PRIMARY KEY over the four columns is a
-- pure constraint change — same rows, same values, wider key. The
-- existing `(user_id, nutrient, day DESC)` index is untouched; it does
-- not reference `source` and continues to serve the window-scan reads.
ALTER TABLE "nutrient_intake_days" DROP CONSTRAINT "nutrient_intake_days_pkey";

ALTER TABLE "nutrient_intake_days"
  ADD CONSTRAINT "nutrient_intake_days_pkey"
  PRIMARY KEY ("user_id", "day", "nutrient", "source");
