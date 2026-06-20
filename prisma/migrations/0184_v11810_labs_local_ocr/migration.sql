-- v1.18.10 — opt-in local (in-browser) OCR for lab-report scans.
--
-- One additive, defaulted column on `users`. When `true`, a user whose AI
-- provider cannot read images (ChatGPT-OAuth/Codex, a text-only model) can
-- still scan a paper report: the image is OCR'd in the browser via tesseract.js
-- and only the extracted TEXT is forwarded to the text-only provider for
-- structuring. The raw image never leaves the device in this mode.
--
-- Less accurate than a native vision model — the mandatory per-row review
-- screen stays the safety backstop, and the in-app copy sets that expectation.
-- The default `false` backfills every existing row onto the current behaviour
-- (vision-only scan, or no scan affordance), so this is a no-op for anyone who
-- never opts in.

ALTER TABLE "users"
  ADD COLUMN "labs_local_ocr_enabled" BOOLEAN NOT NULL DEFAULT false;
