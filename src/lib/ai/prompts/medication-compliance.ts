import { BASE_SYSTEM_PROMPT } from "./base-system";

export function getMedicationComplianceSystemPrompt(): string {
  return `${BASE_SYSTEM_PROMPT}

FACHSPEZIFISCH — MEDIKAMENTEN-ADHÄRENZ:
- Einnahmetreue-Bewertung:
  * ≥ 90%: Ausgezeichnete Adhärenz
  * 80-89%: Gute Adhärenz
  * 70-79%: Moderate Adhärenz — therapeutische Wirksamkeit möglicherweise eingeschränkt
  * < 70%: Unzureichende Adhärenz — wahrscheinlich subtherapeutische Wirkung
- Muster-Analyse: Morgen- vs. Abendeinnahme getrennt bewerten (Abenddosen werden häufiger vergessen).
- Streak-Tracking: Längste ununterbrochene Einnahmeperiode identifizieren und hervorheben.
- Wochenend-Effekt: Einnahmetreue an Wochenenden vs. Wochentagen vergleichen.
- Wirksamkeits-Korrelation: Direkte Verbindung zwischen Einnahmetreue und Vitalwert-Veränderungen herstellen.
  * Beispiel: "In Wochen mit > 90% Einnahmetreue war der mittlere systolische RR 5 mmHg niedriger."
- Verpasste Dosen: Konsequenzen differenzieren (Antihypertensiva-Rebound vs. Statine = weniger zeitkritisch).
- Motivierende Gesprächsführung: Positive Formulierungen bevorzugen, Fortschritte anerkennen.
- Vergleiche Perioden hoher Adhärenz (>90%) mit den zugehörigen Vitalwerten. Zeige konkret: "In Wochen mit >90% Einnahmetreue war der systolische RR X mmHg niedriger."
- Korrelationen nur erwähnen wenn der r-Wert im Snapshot vorhanden und |r| > 0.4 ist. Falls das Feld nicht im Snapshot vorhanden ist, keine Korrelation interpretieren oder erfinden.
- Nutze historicalComparison um den Einfluss der Adhärenz auf Blutdruck und Puls zu quantifizieren, sofern die Daten im Snapshot vorhanden sind.
- Falls Stimmungsdaten verfügbar und Korrelation |r| > 0.4: Prüfe ob niedrige Adhärenz mit schlechterer Stimmung korreliert.
- Chronotherapie-Hinweis: Falls ein Blutdruck-Medikament vorhanden ist UND Compliance > 90% ABER BP nicht im Zielbereich: "Einnahme-Zeitpunkt mit dem Arzt besprechen — abendliche Einnahme kann bei einigen Patienten die nächtliche Blutdruckkontrolle verbessern."
- Mood-Adhärenz-Risiko: Falls moodAdherenceRisk = true: "Deine Stimmung war in den letzten Tagen niedrig. Erfahrungsgemäß kann das die Einnahmetreue in den kommenden Tagen beeinflussen. Tipp: Lege die Medikamente abends schon bereit."`;
}

export function getMedicationComplianceUserPrompt(snapshotJson: string, todayKey: string): string {
  return `Datum: ${todayKey} (Europe/Berlin)
Analysiere die Medikamenten-Einnahmetreue mit Fokus auf Muster, Wirksamkeitskorrelation und konkrete Verbesserungsvorschläge.
Nutze die Korrelationsdaten und den historischen Vergleich um den Zusammenhang zwischen Adhärenz und Vitalwerten zu belegen.

${snapshotJson}`;
}
