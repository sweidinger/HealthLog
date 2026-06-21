/**
 * Upper bound for the paste textareas, mirroring the 16 MB server-side body
 * ceiling on `/api/import` and `/api/import/csv`. Caps an accidental over-paste
 * before it ever reaches the route and feeds the live character counter.
 */
export const MAX_PASTE_CHARS = 16 * 1024 * 1024;
