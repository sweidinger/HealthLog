import type { Locale } from "@/lib/i18n/config";
import type { MetricSignal } from "@/lib/insights/metric-signal";

/**
 * v1.4.25 W9e — these no-key fallbacks ship DE + EN bodies only. The
 * type accepts every shipped locale (fr/es/it/pl too) and routes
 * non-DE locales through the EN body, mirroring the same fallback
 * chain the JSON message bundles use. When DE/EN-only fallbacks get
 * replaced with proper FR/ES/IT/PL bodies, expand `getLocalizedText`
 * to read the matching argument.
 *
 * v1.21.0 (coach C1 HIGH-1/2) — these surfaces used to emit static
 * clinical tips with ZERO reference to the user's own numbers, and the
 * timeout path rendered them as if they were a fresh AI assessment.
 * Each `getNoKey*StatusText` now accepts the per-metric `MetricSignal`
 * the card already built and, when present, composes a SIGNAL-GROUNDED
 * deterministic line: it names the user's current value, places it
 * against their own baseline, and ends with ONE plain-language pointer
 * — the same warm voice the LLM surfaces use, without an LLM call. The
 * generic best-practice tip stays only as the honest no-signal floor
 * (no fabricated numbers when a metric has no usable history).
 */
export type InsightLocale = Locale;

function getLocalizedText(
  locale: InsightLocale,
  de: string,
  en: string,
): string {
  return locale === "de" ? de : en;
}

// ── signal-grounded composer ────────────────────────────────────────────────

/** A natural-language metric label + the pointer phrasing for one metric. */
interface FallbackCopy {
  /** Possessive natural-language label ("your blood pressure"). */
  label: { de: string; en: string };
  /** Unit suffix appended to a value (" bpm"), empty when none. */
  unit?: string;
  /** Digits to round the rendered value to (0 for integers). */
  digits?: number;
  /**
   * One grounded pointer used when the value sits outside the user's own
   * usual swing — framed as an opportunity, never an order.
   */
  pointer: { de: string; en: string };
}

function fmtValue(value: number, copy: FallbackCopy): string {
  const digits = copy.digits ?? 0;
  // Round to the metric's precision, but never render a trailing ".0" — an
  // integer reading (steps, a whole-number BMI day) should read as "4200",
  // not "4200.0", while a genuine fractional value keeps its decimal.
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  const text = Number.isInteger(rounded)
    ? String(rounded)
    : rounded.toFixed(digits);
  return copy.unit ? `${text}${copy.unit}` : text;
}

function capitalise(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

/**
 * Compose a warm, grounded deterministic line from a metric signal. Names
 * the current value, places it against the user's own baseline, and ends
 * with one pointer (when the value is outside their usual swing) or an
 * honest "nothing to act on" (when it sits in range). Returns null when the
 * signal carries no current value — the caller then uses the generic tip.
 */
function composeGroundedFallback(
  signal: MetricSignal | null | undefined,
  copy: FallbackCopy,
  locale: InsightLocale,
): string | null {
  if (!signal || !Number.isFinite(signal.current)) return null;

  const label = locale === "de" ? copy.label.de : copy.label.en;
  const current = fmtValue(signal.current, copy);

  const sentences: string[] = [];

  // 1) Lead with the current value, placed against the user's own baseline.
  if (
    signal.baseline !== null &&
    signal.delta !== null &&
    signal.delta !== 0 &&
    Number.isFinite(signal.baseline)
  ) {
    const baseline = fmtValue(signal.baseline, copy);
    const higher = signal.delta > 0;
    sentences.push(
      locale === "de"
        ? `${capitalise(label)} liegt aktuell bei ${current} — ${
            higher ? "höher" : "niedriger"
          } als dein üblicher Schnitt von ${baseline}.`
        : `${capitalise(label)} is at ${current} right now — ${
            higher ? "higher" : "lower"
          } than your usual average of ${baseline}.`,
    );
  } else if (signal.baseline !== null && Number.isFinite(signal.baseline)) {
    sentences.push(
      locale === "de"
        ? `${capitalise(label)} liegt aktuell bei ${current}, im Bereich deines üblichen Schnitts.`
        : `${capitalise(label)} is at ${current}, right around your usual average.`,
    );
  } else {
    // No baseline yet — name the value honestly without inventing a comparison.
    sentences.push(
      locale === "de"
        ? `${capitalise(label)} liegt aktuell bei ${current}.`
        : `${capitalise(label)} is at ${current} right now.`,
    );
  }

  // 2) One grounded pointer when outside the usual swing; otherwise affirm.
  if (signal.outsideNormalSwing === true) {
    sentences.push(locale === "de" ? copy.pointer.de : copy.pointer.en);
  } else if (signal.outsideNormalSwing === false) {
    sentences.push(
      locale === "de"
        ? "Das ist in deinem gewohnten Rahmen — nichts, worauf du jetzt reagieren musst."
        : "That sits in your usual range — nothing you need to act on right now.",
    );
  } else {
    // Unknown swing (no baseline): keep one steady, non-alarming pointer.
    sentences.push(
      locale === "de"
        ? "Ein paar Messungen mehr machen die Tendenz belastbar — beobachte sie über die nächsten Tage."
        : "A few more readings will make the trend dependable — keep an eye on it over the coming days.",
    );
  }

  return sentences.join(" ");
}

// ── per-metric copy ─────────────────────────────────────────────────────────

const BLOOD_PRESSURE_COPY: FallbackCopy = {
  label: { de: "dein Blutdruck", en: "your blood pressure" },
  unit: "",
  digits: 0,
  pointer: {
    de: "Ein paar ruhige Messungen unter gleichen Bedingungen zeigen, ob das die Tendenz ist oder ein Ausreißer.",
    en: "A few calm readings under the same conditions will show whether this is the trend or a single outlier.",
  },
};

const WEIGHT_COPY: FallbackCopy = {
  label: { de: "dein Gewicht", en: "your weight" },
  unit: "",
  digits: 1,
  pointer: {
    de: "Wäge dich ein paar Tage zur gleichen Zeit, dann ordnet sich die normale Schwankung von selbst ein.",
    en: "Weigh in at the same time for a few days and the normal day-to-day swing sorts itself out.",
  },
};

const PULSE_COPY: FallbackCopy = {
  label: { de: "dein Ruhepuls", en: "your resting pulse" },
  unit: " bpm",
  digits: 0,
  pointer: {
    de: "Miss ihn entspannt und zur gleichen Tageszeit, dann siehst du, ob die Richtung anhält.",
    en: "Take it relaxed and at the same time of day to see whether the direction holds.",
  },
};

const BMI_COPY: FallbackCopy = {
  label: { de: "dein BMI", en: "your BMI" },
  unit: "",
  digits: 1,
  pointer: {
    de: "Schau ihn dir zusammen mit Gewichtstrend und Körperfett über ein paar Wochen an.",
    en: "Read it alongside your weight trend and body-fat over a few weeks rather than day by day.",
  },
};

const MOOD_COPY: FallbackCopy = {
  label: { de: "deine Stimmung", en: "your mood" },
  unit: "",
  digits: 1,
  pointer: {
    de: "Halte sie ein paar Tage fest — wiederkehrende Muster sagen mehr als ein einzelner Tag.",
    en: "Log it for a few days — a recurring pattern says more than any single day.",
  },
};

const ADHERENCE_COPY: FallbackCopy = {
  label: { de: "deine Einnahmetreue", en: "your medication adherence" },
  unit: "%",
  digits: 0,
  pointer: {
    de: "Eine feste Zeit oder ein kurzer Reminder fängt die wiederkehrenden Auslassungen am ehesten ab.",
    en: "A fixed time or a quick reminder is the most reliable way to catch the repeat misses.",
  },
};

// ── public fallbacks ────────────────────────────────────────────────────────

/**
 * Generic single-metric fallback for the dynamic per-metric card
 * (`metric-status.ts`), which carries a fully-formed signal but no
 * per-metric copy table. Grounds against the signal's OWN natural-language
 * label + unit; on a missing signal it degrades to the general tip.
 */
export function getNoKeyMetricStatusText(
  locale: InsightLocale,
  signal?: MetricSignal | null,
): string {
  const grounded =
    signal && Number.isFinite(signal.current)
      ? composeGroundedFallback(
          signal,
          {
            label: {
              de: signal.metric,
              en: signal.metric,
            },
            ...(signal.unit ? { unit: ` ${signal.unit}` } : {}),
            digits: 1,
            pointer: {
              de: "Ein paar konsistente Messungen zeigen, ob das die Richtung ist oder ein einzelner Tag.",
              en: "A few consistent readings will show whether this is the direction or a single day.",
            },
          },
          locale,
        )
      : null;
  return grounded ?? getNoKeyGeneralStatusText(locale);
}

export function getNoKeyGeneralStatusText(locale: InsightLocale): string {
  // The overview spans many metrics with no single headline value to ground
  // against, so it keeps the honest, generic multi-metric pointer.
  return getLocalizedText(
    locale,
    "Beobachte Entwicklungen über mehrere Wochen statt einzelne Tageswerte isoliert zu bewerten. Achte auf konsistente Messzeitpunkte, damit Trends belastbar vergleichbar bleiben. Reagiere früh, wenn sich mehrere Kennzahlen gleichzeitig in eine ungünstige Richtung bewegen.",
    "Track developments over several weeks instead of judging single daily values in isolation. Keep measurement timing consistent so trends remain comparable and reliable. React early when multiple metrics move in an unfavorable direction at the same time.",
  );
}

export function getNoKeyBloodPressureStatusText(
  locale: InsightLocale,
  signal?: MetricSignal | null,
): string {
  return (
    composeGroundedFallback(signal, BLOOD_PRESSURE_COPY, locale) ??
    getLocalizedText(
      locale,
      "Miss den Blutdruck möglichst in Ruhe und unter vergleichbaren Bedingungen. Entscheidend ist die Tendenz über mehrere Tage, nicht ein einzelner Ausreißer. Beurteile systolische und diastolische Werte immer gemeinsam im zeitlichen Verlauf.",
      "Measure blood pressure at rest and under comparable conditions whenever possible. The multi-day trend matters more than a single outlier. Always evaluate systolic and diastolic values together over time.",
    )
  );
}

export function getNoKeyWeightStatusText(
  locale: InsightLocale,
  signal?: MetricSignal | null,
): string {
  return (
    composeGroundedFallback(signal, WEIGHT_COPY, locale) ??
    getLocalizedText(
      locale,
      "Bewerte Gewicht vor allem im Verlauf und nicht anhand einzelner Tage. Nutze möglichst konstante Messbedingungen, um normale Schwankungen besser einzuordnen. Wichtig ist die langfristige Richtung im Zusammenspiel mit Blutdruck und BMI.",
      "Evaluate weight mainly as a trend rather than by isolated daily readings. Use consistent measurement conditions to interpret normal fluctuations more reliably. What matters most is the long-term direction together with blood pressure and BMI.",
    )
  );
}

export function getNoKeyPulseStatusText(
  locale: InsightLocale,
  signal?: MetricSignal | null,
): string {
  return (
    composeGroundedFallback(signal, PULSE_COPY, locale) ??
    getLocalizedText(
      locale,
      "Miss den Ruhepuls in einer entspannten Situation und möglichst zur gleichen Tageszeit. Kurzfristige Ausschläge sind normal, wichtiger ist die Entwicklung über mehrere Tage. Achte auf wiederkehrende Abweichungen vom persönlichen Zielbereich.",
      "Measure resting pulse in a relaxed state and ideally at the same time of day. Short-term spikes are normal, while the multi-day pattern is more important. Watch for repeated deviations from your personal target range.",
    )
  );
}

export function getNoKeyBmiStatusText(
  locale: InsightLocale,
  signal?: MetricSignal | null,
): string {
  return (
    composeGroundedFallback(signal, BMI_COPY, locale) ??
    getLocalizedText(
      locale,
      "Der BMI ist eine Orientierungsgröße und sollte immer zusammen mit Gewichtstrend und Körperfett betrachtet werden. Einzelwerte sind weniger wichtig als die Entwicklung über Wochen. Aussagekräftig sind vor allem stabile Verbesserungen oder dauerhafte Abweichungen.",
      "BMI is a directional metric and should always be viewed together with weight trend and body-fat context. Single values are less important than changes across weeks. The most meaningful signals are sustained improvements or persistent deviations.",
    )
  );
}

export function getNoKeyMedicationComplianceStatusText(
  locale: InsightLocale,
  signal?: MetricSignal | null,
): string {
  return (
    composeGroundedFallback(signal, ADHERENCE_COPY, locale) ??
    getLocalizedText(
      locale,
      "Konstanz bei der Einnahme ist wichtiger als einzelne perfekte Tage. Beurteile die Treue pro Medikament und zusätzlich im Gesamtbild über mehrere Wochen. Achte besonders auf wiederkehrende Auslassungen und stabilisiere dafür feste Zeitfenster-Routinen.",
      "Consistency in intake matters more than isolated perfect days. Evaluate adherence per medication and also in the overall multi-week picture. Pay special attention to repeated misses and stabilize fixed time-window routines.",
    )
  );
}

export function getNoKeyMoodStatusText(
  locale: InsightLocale,
  signal?: MetricSignal | null,
): string {
  return (
    composeGroundedFallback(signal, MOOD_COPY, locale) ??
    getLocalizedText(
      locale,
      "Bewerte die Stimmung im Verlauf über mehrere Wochen statt einzelne Tage isoliert zu betrachten. Achte auf wiederkehrende Muster und Zusammenhänge mit anderen Gesundheitswerten. Anhaltende Phasen niedriger Stimmung verdienen besondere Aufmerksamkeit.",
      "Evaluate mood trends over several weeks rather than isolated daily readings. Watch for recurring patterns and correlations with other health metrics. Sustained periods of low mood deserve special attention.",
    )
  );
}
