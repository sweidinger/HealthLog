/**
 * @fileoverview Aggregates the project-local `healthlog/*` ESLint rules
 * into a single plugin object for the flat config.
 *
 *   - `queryKey-factory`     — bare-array queryKey / mutationKey bypass guard.
 *   - `safe-fetch-required`  — outbound fetch must route through safeFetch.
 *   - `api-fetch-required`   — client /api/ calls must route through apiFetch.
 *   - `no-raw-palette-color` — ban raw Tailwind palette utilities in app UI.
 */

"use strict";

const queryKeyFactory = require("./queryKey-factory.js");
const safeFetchRequired = require("./safe-fetch-required.js");
const apiFetchRequired = require("./api-fetch-required.js");
const noRawPaletteColor = require("./no-raw-palette-color.js");

module.exports = {
  rules: {
    "queryKey-factory": queryKeyFactory.rules["queryKey-factory"],
    "safe-fetch-required": safeFetchRequired,
    "api-fetch-required": apiFetchRequired,
    "no-raw-palette-color": noRawPaletteColor,
  },
};
