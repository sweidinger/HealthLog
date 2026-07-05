/**
 * @fileoverview Aggregates the project-local `healthlog/*` ESLint rules
 * into a single plugin object for the flat config.
 *
 *   - `queryKey-factory`     — bare-array queryKey / mutationKey bypass guard.
 *   - `safe-fetch-required`  — outbound fetch must route through safeFetch.
 *   - `api-fetch-required`   — client /api/ calls must route through apiFetch.
 *   - `no-raw-palette-color` — ban raw Tailwind palette utilities in app UI.
 *   - `spacing-scale`        — no pt-/pb- overrides on gap-based Card slots.
 */

"use strict";

const queryKeyFactory = require("./queryKey-factory.js");
const safeFetchRequired = require("./safe-fetch-required.js");
const apiFetchRequired = require("./api-fetch-required.js");
const noRawPaletteColor = require("./no-raw-palette-color.js");
const spacingScale = require("./spacing-scale.js");

module.exports = {
  rules: {
    "queryKey-factory": queryKeyFactory.rules["queryKey-factory"],
    "safe-fetch-required": safeFetchRequired,
    "api-fetch-required": apiFetchRequired,
    "no-raw-palette-color": noRawPaletteColor,
    "spacing-scale": spacingScale,
    // Same module as `no-raw-palette-color`, registered under a second
    // name so the flat config can run the `dracula` check at a different
    // severity (warn) than the error-level checks. See the staged plan in
    // the rule header.
    "no-dracula-utility": noRawPaletteColor,
  },
};
