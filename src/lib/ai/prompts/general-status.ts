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
- Positive Entwicklungen explizit hervorheben — Motivation ist therapeutisch relevant.
- Korrelationen nur erwähnen wenn der jeweilige r-Wert im Snapshot vorhanden und |r| > 0.4 ist. Falls ein Korrelationsfeld nicht im Snapshot vorhanden ist, keine Korrelation interpretieren oder erfinden. Vergleiche die aktuellen 7-Tage-Werte mit den Langzeit-Durchschnitten (avg90, allTime).
- Nutze historicalComparison um aktuelle Veränderungen gegenüber der etablierten Baseline einzuordnen.
- Falls Alter und Geschlecht bekannt sind, alters- und geschlechtsspezifische Risikobewertung anwenden.
- Schlaf: Falls sleep-Daten vorhanden, Schlafqualität in die Gesamtbewertung einbeziehen. < 6h/Nacht als Risikofaktor für Hypertonie und Gewichtszunahme benennen.
- Aktivität: Falls activity-Daten vorhanden, Schrittzahl bewerten (WHO-Ziel ≥ 8.000/Tag). Zusammenhang mit Puls- und Gewichtstrend herstellen.
- Rate-Pressure Product: Falls ratePressureProduct vorhanden, als Indikator für kardiale Belastung in die Risikostratifizierung einbeziehen. > 12.000 = erhöhter myokardialer Sauerstoffbedarf.
- Body-Composition-Divergenz: Falls bodyCompositionDivergence.flag = true, als Frühzeichen für sarkopenische Adipositas in die Gesamtbewertung aufnehmen.
- Saisonale Variation: Falls seasonalVariation vorhanden, saisonale Blutdruckschwankungen kontextualisieren und ggf. beruhigend einordnen.`;
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
Nutze die correlations-Daten für Kreuzanalysen und historicalComparison für temporale Einordnung.

${featuresJson}`,
  };
}
