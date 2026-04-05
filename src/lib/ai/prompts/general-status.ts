import { BASE_SYSTEM_PROMPT } from "./base-system";

export function getGeneralStatusSystemPrompt(): string {
  return `${BASE_SYSTEM_PROMPT}

FACHSPEZIFISCH — GESAMTBEWERTUNG:
- Integriere alle verfügbaren Vitalparameter zu einem kohärenten Gesamtbild.
- Priorisiere nach klinischer Relevanz: Kritische Abweichungen > moderate Trends > stabile Parameter.
- Identifiziere die wichtigste einzelne Handlungsempfehlung ("One Thing").
- Risikostratifizierung: Bewerte das kardiovaskuläre Gesamtrisiko basierend auf der Kombination aller Faktoren.
- Medikamenten-Adhärenz: Gesamteinnahmetreue bewerten und Zusammenhang mit Vitalwerten benennen.
- Stimmung: Falls vorhanden, als kontextuellen Faktor einbeziehen (nicht übergewichten).
- Positive Entwicklungen explizit hervorheben — Motivation ist therapeutisch relevant.`;
}

export function getGeneralStatusUserPrompt(snapshotJson: string, todayKey: string): string {
  return `Datum: ${todayKey} (Europe/Berlin)
Erstelle eine umfassende Gesamtbewertung aller verfügbaren Gesundheitsdaten.
Fokussiere auf das Zusammenspiel der verschiedenen Parameter und identifiziere die wichtigste Handlungsempfehlung.

${snapshotJson}`;
}

// Backward-compatible export for insights/generate route (Task 8 uses this)
export function buildGeneratePrompts(featuresJson: string, privacyMode: string): { systemPrompt: string; userPrompt: string } {
  const modeLabel = privacyMode === "raw"
    ? "Aggregierte Daten + Rohdaten (gesamter verfügbarer Zeitraum, anonymisiert)"
    : "Nur aggregierte Daten (keine exakten Zeitstempel oder Rohwerte)";

  return {
    systemPrompt: getGeneralStatusSystemPrompt(),
    userPrompt: `Analysiere die folgenden Gesundheitsdaten.
Datenmodus: ${modeLabel}
Beachte die coverage-Objekte jeder Metrik für Informationen zu Messhäufigkeit und Zeiträumen.

${featuresJson}`,
  };
}
