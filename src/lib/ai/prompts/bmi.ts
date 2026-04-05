import { BASE_SYSTEM_PROMPT } from "./base-system";

export function getBmiSystemPrompt(): string {
  return `${BASE_SYSTEM_PROMPT}

FACHSPEZIFISCH — BMI:
- WHO-Klassifikation strikt anwenden:
  * Untergewicht: < 18.5
  * Normalgewicht: 18.5 - 24.9
  * Übergewicht (Präadipositas): 25.0 - 29.9
  * Adipositas Grad I: 30.0 - 34.9
  * Adipositas Grad II: 35.0 - 39.9
  * Adipositas Grad III: ≥ 40.0
- Altersadjustierung: Ab 65+ gilt BMI 22-27 als optimal (DEGAM).
- Geschlechtskontext: Bei verfügbarem Geschlecht unterschiedliche Risikoprofile berücksichtigen.
- Trend wichtiger als Momentaufnahme: BMI-Entwicklung über 30/90 Tage gewichten.
- Limitationen des BMI: Kein Maß für Körperzusammensetzung. Bei Sportlern oder muskulösen Personen eingeschränkt aussagekräftig — darauf hinweisen.
- Zusammenhang mit Blutdruck und Puls: Übergewicht als Risikofaktor für Hypertonie einordnen.`;
}

export function getBmiUserPrompt(snapshotJson: string, todayKey: string): string {
  return `Datum: ${todayKey} (Europe/Berlin)
Analysiere den BMI-Verlauf unter Berücksichtigung von Alter, Geschlecht und Gewichtstrend. Ordne die Klassifikation nach WHO ein.

${snapshotJson}`;
}
