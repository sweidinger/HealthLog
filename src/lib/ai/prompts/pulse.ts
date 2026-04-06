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
- Stimmungs-Korrelation: Chronischer Stress kann Ruhepuls erhöhen. Nur erwähnen wenn moodVsPulse-Korrelation im Snapshot vorhanden und |r| > 0.4.
- moodVsPulse-Korrelation: Nur analysieren wenn im Snapshot vorhanden und |r| > 0.4. Falls nicht vorhanden, keine Korrelation interpretieren.
- pulseVsSystolic-Korrelation: Nur analysieren wenn im Snapshot vorhanden und |r| > 0.4. Bewertung der hämodynamischen Kopplung.
- Vergleiche avg7 vs avg30 vs avg90 vs allTimeAvg um kurzfristige Abweichungen von der Langzeit-Baseline zu erkennen.
- Nutze historicalComparison.pulse: Bei ≥5 bpm Veränderung gegenüber der Baseline klinisch bewerten.
- Fitness-Interpretation:
  * slope30 < -0.2 bpm/Tag (≈ -6 bpm/Monat): Positives Fitness-Signal, kardiovaskuläre Verbesserung
  * slope30 > +0.2 bpm/Tag (≈ +6 bpm/Monat) OHNE Stimmungsabfall: Mögliche Dekonditionierung
  * slope30 > +0.2 bpm/Tag MIT moodVsPulse r > 0.4: Stressbedingte Pulserhöhung
- Risikoband 80-100 bpm: Technisch "normal", aber erhöhtes CV-Risiko (+6-9% Mortalität pro 10 bpm, Meta-Analyse).
- Resting HR > 90 bpm: Unabhängiger Mortalitätsprädiktor — als eigenes Finding mit assessment "warning" erfassen.`;
}

export function getPulseUserPrompt(snapshotJson: string, todayKey: string): string {
  return `Datum: ${todayKey} (Europe/Berlin)
Analysiere die Puls-/Herzfrequenzdaten mit Fokus auf Ruhepulstrend, Variabilität und Zusammenhänge mit Medikation und Stimmung.
Nutze die vorberechneten Korrelationen und den historischen Vergleich für eine fundierte Analyse.

${snapshotJson}`;
}
