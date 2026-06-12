-- v1.16.10 — medications list presentation preference.
--
-- `medication_list_layout_json` (users): the per-user card/table view
-- choice for /medications plus the user-defined manual medication order
-- shared by both views. Follows the per-surface-column convention of
-- `dashboard_widgets_json` / `insights_layout_json`. NULL = defaults
-- (cards, alphabetical order); the GET endpoint never lazy-writes.
--
-- Shape: { "version": 1, "view": "table", "order": ["<medicationId>", ...] }

ALTER TABLE "users" ADD COLUMN "medication_list_layout_json" JSONB;
