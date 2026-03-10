import { AsyncLocalStorage } from "node:async_hooks";
import type { WideEvent } from "./types";
import { WideEventBuilder } from "./event-builder";

/** AsyncLocalStorage fuer den aktuellen Request-Kontext */
export const eventStorage = new AsyncLocalStorage<WideEventBuilder>();

/** Aktuellen EventBuilder abrufen (null falls ausserhalb eines Kontexts) */
export function getEvent(): WideEventBuilder | null {
  return eventStorage.getStore() ?? null;
}

/**
 * Convenience: Felder im aktuellen Event annotieren.
 * Safe to call anywhere — no-op wenn kein Kontext aktiv.
 */
export function annotate(fields: {
  action?: WideEvent["action"];
  meta?: Record<string, unknown>;
}): void {
  const evt = getEvent();
  if (!evt) return;
  if (fields.action) evt.setAction(fields.action);
  if (fields.meta) {
    for (const [key, value] of Object.entries(fields.meta)) {
      evt.addMeta(key, value);
    }
  }
}
