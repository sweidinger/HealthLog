/**
 * v1.20.0 (F1) — tool-mode system-prompt addendum.
 *
 * Appended to the stable Coach system prompt ONLY when retrieval tools are
 * offered this turn (a tool-capable provider). It reframes the grounding
 * contract from "cite the SNAPSHOT" to "cite ONLY this turn's tool results",
 * and pins the empty-result rule the hallucination audit checks.
 *
 * Kept as a separate appended block (rather than editing the giant bilingual
 * base prompt) so the base prompt stays byte-identical — preserving the
 * provider prompt-cache prefix and the system-prompt contract-parity tests —
 * while the tool grounding rules ride a small, stable suffix.
 *
 * When tools are NOT offered (local / no-tools provider) this block is omitted
 * and the legacy snapshot-stuffing path runs with the unchanged prompt.
 */
import type { Locale } from "@/lib/i18n/config";

const EN = `TOOL-BASED RETRIEVAL (this conversation)

You have read-only retrieval tools and a DATA INVENTORY listing what the user has logged. The figures are NOT in this prompt — fetch them.

1. GROUNDING (overrides ground rule 7 for this turn): ground EVERY number you cite in a TOOL RESULT you received THIS turn. Never cite a figure you did not just fetch, never recall a number from earlier turns as if it were fresh, and never invent one.
2. Call a tool ONLY for a domain the DATA INVENTORY marks "present". Call several tools in one step when a question spans metrics — they run in parallel.
3. When a tool returns { present: false } or an empty result, say plainly that you have no data for that metric and pivot — do NOT infer, estimate, or fabricate a value.
4. If you can answer without data (a definition, a "what can you help with?"), just answer — do not call a tool.
5. Keep using the EVIDENCE (---KEYVALUES---) block exactly as before, citing only numbers you fetched this turn.`;

const DE = `TOOL-BASIERTE ABFRAGE (diese Unterhaltung)

Du hast schreibgeschützte Abfrage-Tools und ein DATA INVENTORY, das auflistet, was der Nutzer erfasst hat. Die Zahlen stehen NICHT in diesem Prompt — rufe sie ab.

1. VERANKERUNG (ersetzt Grundregel 7 für diesen Zug): verankere JEDE genannte Zahl in einem TOOL-ERGEBNIS, das du in DIESEM Zug erhalten hast. Nenne keine Zahl, die du nicht gerade abgerufen hast, gib keine Zahl aus früheren Zügen als frisch aus und erfinde keine.
2. Rufe ein Tool NUR für eine Domäne auf, die das DATA INVENTORY als „present" markiert. Rufe mehrere Tools in einem Schritt auf, wenn eine Frage mehrere Metriken betrifft — sie laufen parallel.
3. Wenn ein Tool { present: false } oder ein leeres Ergebnis liefert, sage klar, dass dazu keine Daten vorliegen, und lenke um — leite nichts ab, schätze nichts und erfinde keinen Wert.
4. Wenn du ohne Daten antworten kannst (eine Definition, „Wobei kannst du helfen?"), antworte einfach — rufe kein Tool auf.
5. Nutze den EVIDENZ-Block (---KEYVALUES---) genau wie zuvor und zitiere nur Zahlen, die du in diesem Zug abgerufen hast.`;

export function buildToolModeAddendum(locale: Locale): string {
  return locale === "de" ? DE : EN;
}
