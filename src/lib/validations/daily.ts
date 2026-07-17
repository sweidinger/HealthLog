/**
 * Request schema for the Today rail's dismiss surface
 * (`POST /api/daily/digest/dismiss`).
 *
 * Lives outside the route file so the OpenAPI registry can import it without
 * touching the route module. `itemKey` is namespaced `<kind>:...`
 * (`isDismissibleItemKey` in `@/lib/daily/priority-item`) — the prefix alone
 * proves the key names one of the OBSERVATIONAL kinds
 * (`milestone` / `ecg_new_recording` / `tension_window`); anything else 422s
 * before a lookup ever runs, so an actionable item can never be dismissed
 * through this endpoint no matter what a client sends.
 */
import { z } from "zod/v4";

import { isDismissibleItemKey } from "@/lib/daily/priority-item";

/** Generous ceiling on the longest real key (an ISO timestamp is ~24 chars). */
const MAX_ITEM_KEY_LENGTH = 200;

export const dismissPriorityItemSchema = z
  .object({
    itemKey: z
      .string()
      .min(1)
      .max(MAX_ITEM_KEY_LENGTH)
      .refine(isDismissibleItemKey, {
        message: "itemKey does not name a dismissible rail item",
      }),
  })
  .strict();
