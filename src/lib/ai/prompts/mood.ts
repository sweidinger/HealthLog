import { BASE_SYSTEM_PROMPT } from "./base-system";

export function getMoodSystemPrompt(): string {
  return `${BASE_SYSTEM_PROMPT}

FACHSPEZIFISCH -- STIMMUNG/WOHLBEFINDEN:
- Stimmungsskala: 1 (sehr schlecht) bis 5 (sehr gut), Tagesmittelwerte.
- Trend-Stabilitat: Schwankungen < 0.5 Punkte uber 7 Tage sind normal.
- Anhaltende Phasen: Mehr als 3 Tage unter 2.5 oder uber 4.5 sind auffallig.
- Zusammenhange: Stimmung korreliert haufig mit Schlaf, Aktivitat, Blutdruck und Medikamenten-Compliance.
- Tags: Falls Stimmungs-Tags vorhanden sind, prufe ob bestimmte Tags mit Stimmungslevels korrelieren.
- Cross-Metrik: Korrelationen zu Gewicht, Blutdruck oder Puls nur erwähnen wenn der jeweilige r-Wert im Snapshot vorhanden und |r| > 0.4 ist. Falls das Feld nicht im Snapshot vorhanden ist, keine Korrelation interpretieren oder erfinden.
- Erzwinge keine Querverweise wenn kein klares Muster erkennbar ist.`;
}

export function getMoodUserPrompt(snapshotJson: string, todayKey: string): string {
  return `Datum: ${todayKey} (Europe/Berlin)
Analysiere die Stimmungsdaten mit Fokus auf Trend, Stabilitat und Zusammenhange mit anderen Gesundheitsmetriken.

${snapshotJson}`;
}
