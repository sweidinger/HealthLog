-- Server-side "dismiss / mark seen" ledger for the Today rail's OBSERVATIONAL
-- PriorityItem kinds (milestone, ecg_new_recording, tension_window). The
-- ACTIONABLE kinds (dose_window, sync_issue, preventive_care, coach_checkin)
-- never write a row here — they clear on their own once the user acts.
--
-- `item_key` is a deterministic identity for the candidate INSTANCE the
-- digest builder already computes (kind + metric + reach day for a
-- milestone, the recording's own timestamp for an ECG, the local day for a
-- tension window) — not the bare kind — so dismissing today's milestone never
-- suppresses tomorrow's.

-- CreateTable
CREATE TABLE "dismissed_priority_items" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "item_key" TEXT NOT NULL,
  "dismissed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "dismissed_priority_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex — the dismiss upsert's natural key + the digest read's
-- `userId + itemKey IN (...)` lookup.
CREATE UNIQUE INDEX "dismissed_priority_items_user_id_item_key_key"
  ON "dismissed_priority_items" ("user_id", "item_key");

-- AddForeignKey — deleting a user cascades its dismissal rows away.
ALTER TABLE "dismissed_priority_items"
  ADD CONSTRAINT "dismissed_priority_items_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
