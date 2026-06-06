-- v1.15.0 — cycle prediction cache.
--
-- One cached forecast per user, regenerated debounced /
-- stale-while-revalidate (the InsightNarrative + v1.8.7 assessment cache
-- pattern), NOT per-read. Derived data — not soft-deleted. The ranged
-- Low / High band is rendered as a band, never a single date.
--
-- Reversibility (down):
--   DROP TABLE IF EXISTS "cycle_predictions";

-- CreateTable
CREATE TABLE "cycle_predictions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "method" "prediction_method" NOT NULL,
    "next_period_start" TEXT NOT NULL,
    "next_period_start_low" TEXT NOT NULL,
    "next_period_start_high" TEXT NOT NULL,
    "fertile_window_start" TEXT,
    "fertile_window_end" TEXT,
    "predicted_ovulation" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL,
    "cycles_observed" INTEGER NOT NULL,
    "generated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cycle_predictions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cycle_predictions_user_id_key" ON "cycle_predictions"("user_id");

-- AddForeignKey
ALTER TABLE "cycle_predictions" ADD CONSTRAINT "cycle_predictions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
