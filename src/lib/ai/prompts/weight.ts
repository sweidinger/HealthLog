import { BASE_SYSTEM_PROMPT } from "./base-system";

export function getWeightSystemPrompt(): string {
  return `${BASE_SYSTEM_PROMPT}

FACHSPEZIFISCH — GEWICHT:
- BMI-Kontext immer mitbewerten (Größe aus Profil, falls verfügbar).
- WHO BMI-Klassifikation: Untergewicht < 18.5, Normalgewicht 18.5-24.9, Übergewicht 25.0-29.9, Adipositas I 30.0-34.9, II 35.0-39.9, III ≥ 40.0.
- Trend-Analyse: 7-Tage, 30-Tage und 90-Tage gleitende Durchschnitte vergleichen.
- Plateau-Erkennung: Gewichtsveränderung < ±0.5 kg über > 14 Tage als Plateau identifizieren.
- Realistische Zielprojektion: Maximal 0.5-1.0 kg/Woche als nachhaltiger Gewichtsverlust (DGE-Empfehlung).
- Gewichts-Blutdruck-Korrelation: Nur erwähnen wenn weightVsSystolic im Snapshot vorhanden und |r| > 0.4. Pro kg Gewichtsreduktion ca. 1 mmHg systolische Senkung.
- Medikamenten-Einfluss: Gewichtsrelevante Medikamente identifizieren (z.B. Betablocker, Cortison).
- Tageszeit-Schwankungen: Morgen- vs. Abendmessungen differenzieren (1-2 kg normal).
- Vergleiche das aktuelle 7-Tage-Mittel (historicalComparison.weight.current7dAvg) mit dem 30-Tage-Baseline (previous30dAvg). Bei >2 kg Differenz: klinisch bewerten und Ursachen diskutieren.
- Plateau-Definition: <0.5 kg Veränderung über >14 Tage (prüfe ob avg7 ≈ avg30 ≈ avg90).
- Nutze allTimeMin/allTimeMax/allTimeAvg um den aktuellen Wert historisch einzuordnen.`;
}

export function getWeightUserPrompt(snapshotJson: string, todayKey: string): string {
  return `Datum: ${todayKey} (Europe/Berlin)
Analysiere die Gewichtsentwicklung mit Fokus auf Trends, BMI-Klassifikation und Zusammenhang mit anderen Vitalwerten.
Nutze die temporalen Schichten (avg7, avg30, avg90, allTime) und den historischen Vergleich für eine differenzierte Bewertung.

${snapshotJson}`;
}
