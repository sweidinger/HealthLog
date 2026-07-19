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
 * v1.28.40 — the verdict-first opener for the deterministic floor. A tiny
 * CLOSED vocabulary keyed by (direction, outsideNormalSwing) so the line leads
 * with MEANING before the number, matching the warm AI voice above it. It
 * introduces no new figure and no new claim — the numbers still come from the
 * value sentence right after — so grounding is untouched. Returns null when the
 * signal is too thin to state a confident read (no baseline / no delta), in
 * which case the line simply opens on the value as before.
 */
function verdictLead(
  signal: MetricSignal,
  locale: InsightLocale,
): string | null {
  // Inside the user's own usual swing → a steady, reassuring verdict.
  if (signal.outsideNormalSwing === false) {
    return locale === "de"
      ? "Stabil und wie gewohnt"
      : "Steady and much as usual";
  }
  // Outside the usual swing → is the move in a favourable or unfavourable
  // direction? For a target-band metric the direction alone can't say, so it
  // stays a neutral "worth a look" verdict.
  if (
    signal.outsideNormalSwing === true &&
    signal.delta !== null &&
    signal.delta !== 0
  ) {
    const favourable =
      signal.direction === "higher-better"
        ? signal.delta > 0
        : signal.direction === "lower-better"
          ? signal.delta < 0
          : null;
    if (favourable === true) {
      return locale === "de"
        ? "Das geht in eine gute Richtung"
        : "This is moving in a good direction";
    }
    return locale === "de"
      ? "Zuletzt etwas außerhalb deines üblichen Rahmens"
      : "A little off your usual lately";
  }
  // No baseline / no usable delta → no confident verdict; open on the value.
  return null;
}

/**
 * Compose a warm, grounded deterministic line from a metric signal. Leads with
 * a plain-words verdict (meaning first), then names the current value placed
 * against the user's own baseline, and ends with one pointer (when the value is
 * outside their usual swing) or an honest "nothing to act on" (when it sits in
 * range). Returns null when the signal carries no current value — the caller
 * then uses the generic tip.
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

  // 0) Verdict-first: lead with what it MEANS in plain words before the number,
  // so the floor reads like the warm AI voice and never opens on a bare value.
  const lead = verdictLead(signal, locale);
  if (lead) sentences.push(`${lead}.`);

  // 1) Then the current value, placed against the user's own baseline.
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

/**
 * The no-signal floor's opening move.
 *
 * Every floor below runs when there is no usable signal to ground against —
 * so the honest thing to lead with is not a clinical instruction ("Measure
 * blood pressure at rest…") but the situation itself: no assessment is
 * available right now. That IS the meaning-first opening for this case. It
 * claims nothing about the person's numbers, which is exactly the point — the
 * floor must never imply a read the data does not support, and a warm-sounding
 * verdict here would be manufactured.
 *
 * What follows the lead is what makes the metric readable, phrased as how the
 * measure behaves rather than as an order to the reader.
 */
function noReadLead(locale: InsightLocale): string {
  return locale === "de"
    ? "Für diese Karte liegt gerade keine Einschätzung vor."
    : "No assessment on this one right now.";
}

function floor(locale: InsightLocale, de: string, en: string): string {
  return `${noReadLead(locale)} ${getLocalizedText(locale, de, en)}`;
}

export function getNoKeyGeneralStatusText(locale: InsightLocale): string {
  // The overview spans many metrics with no single headline value to ground
  // against, so it keeps the honest, generic multi-metric pointer.
  return floor(
    locale,
    "Aussagekräftig werden diese Zahlen über mehrere Wochen, nicht über einzelne Tage — und zu konstanten Zeitpunkten erfasst, damit sie vergleichbar bleiben. Das Signal, das zählt, ist mehrere Kennzahlen, die sich gleichzeitig in dieselbe ungünstige Richtung bewegen, nicht ein Wert an einem Tag.",
    "These numbers become readable across several weeks rather than single days, and taken at consistent times so they stay comparable. The signal that counts is several metrics drifting the same unfavourable way at once, not one value on one day.",
  );
}

/**
 * Single lab-marker floor. The biomarker card used to fall back to the
 * multi-metric overview tip — text about watching several metrics at once, on
 * a card showing exactly one lab value. This says something true about a lab
 * marker instead.
 */
export function getNoKeyBiomarkerStatusText(
  locale: InsightLocale,
  markerName?: string | null,
): string {
  const named =
    markerName && markerName.trim().length > 0
      ? locale === "de"
        ? ` zu „${markerName.trim()}"`
        : ` for "${markerName.trim()}"`
      : "";
  const lead =
    locale === "de"
      ? `Für diesen Laborwert${named} liegt gerade keine Einschätzung vor.`
      : `No assessment${named} right now.`;
  return `${lead} ${getLocalizedText(
    locale,
    "Ein Laborwert liest sich zuerst gegen die eigenen vorherigen Abnahmen — ein Referenzbereich ist ein grober Anker, kein Urteil. Ein Wert, der sich über mehrere Abnahmen kaum bewegt, erzählt etwas anderes als einer, der gerade gesprungen ist. Die nächste ärztliche Kontrolle ist der richtige Ort, ihn einzuordnen.",
    "A lab value reads first against your own previous draws — a reference range is a coarse anchor, not a verdict. One that has barely moved across several draws tells a different story from one that has just stepped. Your next check-up is the right place to put it in context.",
  )}`;
}

export function getNoKeyBloodPressureStatusText(
  locale: InsightLocale,
  signal?: MetricSignal | null,
): string {
  return (
    composeGroundedFallback(signal, BLOOD_PRESSURE_COPY, locale) ??
    floor(
      locale,
      "Blutdruck wird lesbar über eine Reihe ruhiger Messungen unter vergleichbaren Bedingungen — die Richtung über mehrere Tage sagt weit mehr als ein einzelner Ausreißer, und systolisch und diastolisch gehören dabei zusammen gelesen.",
      "Blood pressure becomes readable over a run of calm readings under similar conditions — the direction across several days says far more than any single outlier, and systolic and diastolic are read together rather than one at a time.",
    )
  );
}

export function getNoKeyWeightStatusText(
  locale: InsightLocale,
  signal?: MetricSignal | null,
): string {
  return (
    composeGroundedFallback(signal, WEIGHT_COPY, locale) ??
    floor(
      locale,
      "Gewicht liest sich als Verlauf, nicht als Tageszahl — unter konstanten Bedingungen gewogen, pendelt sich die normale Tagesschwankung von selbst ein. Die Richtung über Wochen, zusammen mit Blutdruck und BMI gelesen, ist das, was trägt.",
      "Weight reads as a trend rather than a daily number — weighed under consistent conditions, the normal day-to-day swing settles out on its own. The direction over weeks, read alongside blood pressure and BMI, is what carries.",
    )
  );
}

export function getNoKeyPulseStatusText(
  locale: InsightLocale,
  signal?: MetricSignal | null,
): string {
  return (
    composeGroundedFallback(signal, PULSE_COPY, locale) ??
    floor(
      locale,
      "Der Ruhepuls liest sich am besten entspannt und zur gleichen Tageszeit gemessen. Kurze Ausschläge sind gewöhnlich; was auffällt, ist ein Muster, das über mehrere Tage hält, oder wiederholtes Abdriften vom eigenen üblichen Bereich.",
      "Resting pulse reads best taken relaxed and at the same time of day. Short spikes are ordinary; what stands out is a pattern holding across several days, or repeated drift away from your usual range.",
    )
  );
}

export function getNoKeyBmiStatusText(
  locale: InsightLocale,
  signal?: MetricSignal | null,
): string {
  return (
    composeGroundedFallback(signal, BMI_COPY, locale) ??
    floor(
      locale,
      "Der BMI ist eine grobe Orientierung, kein Urteil, und bedeutet am meisten zusammen mit Gewichtstrend und Körperzusammensetzung gelesen. Eine anhaltende Bewegung über Wochen trägt, wo ein Einzelwert es nicht tut.",
      "BMI is a rough orientation rather than a verdict, and it means most read alongside your weight trend and body composition. Sustained movement over weeks carries where a single value does not.",
    )
  );
}

export function getNoKeyMedicationComplianceStatusText(
  locale: InsightLocale,
  signal?: MetricSignal | null,
): string {
  return (
    composeGroundedFallback(signal, ADHERENCE_COPY, locale) ??
    floor(
      locale,
      "Einnahmetreue liest sich als Konstanz über Wochen, nicht als eine Reihe perfekter Tage — je Medikament und im Gesamtbild. Wiederkehrende Auslassungen zur selben Tageszeit sind das Muster, auf das es ankommt, und eine feste Routine fängt sie am ehesten ab.",
      "Adherence reads as consistency over weeks rather than a run of perfect days — per medication and in the overall picture. Repeated misses at the same time of day are the pattern that counts, and a fixed routine is what usually catches them.",
    )
  );
}

export function getNoKeyMoodStatusText(
  locale: InsightLocale,
  signal?: MetricSignal | null,
): string {
  return (
    composeGroundedFallback(signal, MOOD_COPY, locale) ??
    floor(
      locale,
      "Stimmung liest sich über Wochen, nicht über einzelne Tage — wiederkehrende Muster und wie sie zu den anderen Werten passen, sind das, was trägt. Eine anhaltende Phase niedriger Stimmung ist die, die Aufmerksamkeit verdient.",
      "Mood reads over weeks rather than single days — recurring patterns, and how they line up with your other metrics, are what carry. A sustained low stretch is the one that deserves attention.",
    )
  );
}
