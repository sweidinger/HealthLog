/**
 * Shared duration constants in milliseconds.
 *
 * Replaces the inline `24 * 60 * 60 * 1000` (and friends) scattered across
 * the codebase. Centralising the literal keeps the intent readable at the
 * call site and removes the off-by-a-zero risk of hand-typing the product.
 * Pure module — no imports, safe to use anywhere (server or client).
 */

/** One minute in milliseconds. */
export const MS_PER_MINUTE = 60 * 1000;

/** One hour in milliseconds. */
export const MS_PER_HOUR = 60 * MS_PER_MINUTE;

/** One day in milliseconds. */
export const MS_PER_DAY = 24 * MS_PER_HOUR;
