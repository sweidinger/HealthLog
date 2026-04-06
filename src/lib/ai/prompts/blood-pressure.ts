import { BASE_SYSTEM_PROMPT } from "./base-system";

export function getBloodPressureSystemPrompt(): string {
  return `${BASE_SYSTEM_PROMPT}

FACHSPEZIFISCH — BLUTDRUCK:
- Klassifikation nach ESC/ESH 2023:
  * Optimal: < 120/80 mmHg
  * Normal: 120-129/80-84 mmHg
  * Hochnormal: 130-139/85-89 mmHg
  * Hypertonie Grad 1: 140-159/90-99 mmHg
  * Hypertonie Grad 2: 160-179/100-109 mmHg
  * Hypertonie Grad 3: ≥ 180/≥ 110 mmHg
  * Isolierte systolische Hypertonie: ≥ 140/< 90 mmHg
- Zielwerte: Bei unkomplizierter Hypertonie Ziel < 130/80 mmHg (18-69 Jahre), < 140/80 mmHg (≥ 70 Jahre).
- Morning Surge: Morgendlicher Blutdruckanstieg > 20 mmHg systolisch als Risikofaktor identifizieren.
- Pulsdruck: (Systolisch - Diastolisch) > 60 mmHg als Marker für arterielle Steifigkeit bewerten.
- Medikamenten-Korrelation: Einnahmetreue von Antihypertensiva mit Blutdruckverlauf korrelieren.
- Gewichts-Korrelation: Gewichtstrend mit Blutdruckverlauf vergleichen (pro kg Gewichtsverlust ca. 1 mmHg Senkung erwartet).
- Stimmungs-Korrelation: Nur erwähnen wenn moodVsSystolicCorrelation im Snapshot vorhanden und |r| > 0.4. Falls nicht vorhanden, keine Korrelation interpretieren.
- weightVsSystolic-Korrelation: Nur analysieren wenn im Snapshot vorhanden und |r| > 0.4. Pro kg Gewichtsreduktion kann 1 mmHg systolische Senkung erwartet werden.
- weightVsDiastolic-Korrelation: Nur analysieren wenn im Snapshot vorhanden und |r| > 0.4.
- Vergleiche avgSys30 und avgSys90 sowie allTimeAvg um langfristige Trends zu erkennen.
- Nutze historicalComparison.systolic und historicalComparison.diastolic: Bei ≥5 mmHg systolischer bzw. ≥3 mmHg diastolischer Veränderung klinisch bewerten.`;
}

export function getBloodPressureUserPrompt(snapshotJson: string, todayKey: string): string {
  return `Datum: ${todayKey} (Europe/Berlin)
Analysiere die folgenden Blutdruck-Daten mit Fokus auf Trends, Zielwerterreichung und Medikamentenwirksamkeit.
Berücksichtige die Messzeiträume und Datendichte für die Konfidenzeinschätzung.
Nutze die vorberechneten Korrelationen (correlations) und den historischen Vergleich (historicalComparison) für eine fundierte temporale Analyse.

${snapshotJson}`;
}
