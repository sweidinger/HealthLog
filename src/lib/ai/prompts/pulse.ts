import { BASE_SYSTEM_PROMPT } from "./base-system";

export function getPulseSystemPrompt(): string {
  return `${BASE_SYSTEM_PROMPT}

FACHSPEZIFISCH — PULS/HERZFREQUENZ:
- Ruhepuls-Zonen:
  * Bradykardie: < 50 bpm (bei Sportlern normal, sonst abklärungsbedürftig)
  * Athletisch: 50-60 bpm
  * Normal: 60-100 bpm
  * Tachykardie: > 100 bpm (abklärungsbedürftig)
- Trend-Stabilität: Ruhepuls-Variabilität < 5 bpm über 7 Tage ist normal.
- Stress-Indikatoren: Steigende Ruheherzfrequenz kann auf Stress, Schlafmangel oder Übertraining hinweisen.
- Erholung: Sinkender Ruhepuls über Wochen deutet auf verbesserte kardiovaskuläre Fitness hin.
- Medikamenten-Einfluss: Betablocker senken die Herzfrequenz — Compliance-Korrelation prüfen.
- Blutdruck-Korrelation: Puls × systolischen Druck = Doppelprodukt als Herzbelastungsindikator.
- Stimmungs-Korrelation: Chronischer Stress kann Ruhepuls erhöhen.
- Nutze die moodVsPulse-Korrelation um Stress-Einfluss auf den Ruhepuls einzuschätzen. Bei r > 0.3 (negative Korrelation = schlechtere Stimmung → höherer Puls) den Zusammenhang klinisch einordnen.
- Nutze die pulseVsSystolic-Korrelation für die Bewertung der hämodynamischen Kopplung.
- Vergleiche avg7 vs avg30 vs avg90 vs allTimeAvg um kurzfristige Abweichungen von der Langzeit-Baseline zu erkennen.
- Nutze historicalComparison.pulse: Bei ≥5 bpm Veränderung gegenüber der Baseline klinisch bewerten.`;
}

export function getPulseUserPrompt(snapshotJson: string, todayKey: string): string {
  return `Datum: ${todayKey} (Europe/Berlin)
Analysiere die Puls-/Herzfrequenzdaten mit Fokus auf Ruhepulstrend, Variabilität und Zusammenhänge mit Medikation und Stimmung.
Nutze die vorberechneten Korrelationen und den historischen Vergleich für eine fundierte Analyse.

${snapshotJson}`;
}
