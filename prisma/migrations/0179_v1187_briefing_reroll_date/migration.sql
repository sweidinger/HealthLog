-- v1.18.7 — track the daily-briefing phrasing re-roll date.
-- The content-hash gate keeps the briefing findings byte-stable on
-- unchanged data; this column lets the paragraph be re-rolled once per
-- calendar day (UTC) for phrasing variety without re-paying for findings.
ALTER TABLE "users" ADD COLUMN "insights_briefing_reroll_date" TEXT;
