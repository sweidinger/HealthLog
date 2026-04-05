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
- Stimmungs-Korrelation: Chronischer Stress kann Ruhepuls erhöhen.`;
}

export function getPulseUserPrompt(snapshotJson: string, todayKey: string): string {
  return `Datum: ${todayKey} (Europe/Berlin)
Analysiere die Puls-/Herzfrequenzdaten mit Fokus auf Ruhepulstrend, Variabilität und Zusammenhänge mit Medikation und Stimmung.

${snapshotJson}`;
}
