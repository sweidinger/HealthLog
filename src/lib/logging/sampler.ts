import type { WideEvent } from "./types";
import { LOG_LEVEL_PRIORITY } from "./types";
import { getLoggingConfig, isLevelEnabled } from "./config";

/**
 * Tail Sampling: Entscheidung ob ein Event emittiert werden soll.
 *
 * Immer behalten: Fehler, Warnungen, langsame Requests, Background-Tasks.
 * Sampling nur fuer erfolgreiche, schnelle HTTP-Requests.
 */
export function shouldEmit(event: WideEvent): boolean {
  if (!isLevelEnabled(event.level)) return false;

  // Fehler und Warnungen immer behalten
  if (LOG_LEVEL_PRIORITY[event.level] >= LOG_LEVEL_PRIORITY["warn"]) return true;

  // Langsame Requests immer behalten
  const config = getLoggingConfig();
  if (event.duration_ms >= config.slowThresholdMs) return true;

  // Hintergrundaufgaben immer behalten
  if (event.kind === "background") return true;

  // Fuer normale erfolgreiche Requests: Sampling anwenden
  if (config.sampleRate >= 1.0) return true;
  if (config.sampleRate <= 0.0) return false;

  return Math.random() < config.sampleRate;
}
