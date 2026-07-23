/**
 * v1.21.0 (P6 / C2-5) — post-hoc numeric verifier for Coach prose.
 * v1.32.7 (Coach Guard I / G1) — typed tokenizer + normal-form reconciler.
 *
 * The Daily Briefing strips any number absent from the server-computed
 * `signalsOfDay` block (`@/lib/ai/briefing-grounding`). The Coach's TOOL path
 * had no equivalent: the addendum forbids citing un-fetched figures, but
 * nothing deterministically checks the FINAL prose against the figures the
 * tools actually returned this turn — so a transcription/paraphrase drift
 * (tool says systolic 128, prose says "~138") could ship.
 *
 * The original closure (v1.21.0 → v1.32.4) graded an UNTYPED bag of magnitudes
 * with a bare number regex, and repaired misses with a plain `indexOf`. That
 * mangled correct numbers the model merely reformatted (dates → junk fragments,
 * `10,000` → `10`, `60-100` → `60` / `-100`) and clipped a grounded number
 * inside a larger one (flagged `23` strips `20[unverified]` out of `2023`).
 *
 * G1 replaces both halves:
 *
 *   1. A TYPED TOKENIZER classifies each prose number before it is graded —
 *      ISO / written dates, clock times, bare years, ordinals, list markers,
 *      range pairs, percents, thousands-separated integers, unit-suffixed
 *      measurements. Benign types (dates / times / years / ordinals / lists)
 *      are never graded and never stripped. A range decomposes into its two
 *      endpoint magnitudes, each graded independently (per-endpoint, no
 *      min/max "bracket" arm). Thousands separators follow the reply's actual
 *      language, not the UI locale.
 *
 *   2. A NORMAL-FORM RECONCILER grades a magnitude against a typed authoritative
 *      entry — value + kind + aggregation — instead of a flat number. An
 *      entry is grounded exactly / within ±2% always; sign-insensitive,
 *      canonical rounding, ratio↔percent (in percent space, never dividing the
 *      token down), and minutes↔hours widen the match ONLY for an AGGREGATE,
 *      KINDED entry (a headline mean / latest / delta — never a raw timeline
 *      sample, where the widenings would compound into a free band). Kind
 *      scoping means a weight value can never ground a blood-pressure claim.
 *
 * Posture: NON-BLOCKING and cheap. The caller annotates
 * `coach.prose.number_unverified` and may SOFT-STRIP the unverified figure
 * from the prose (boundary-safe replacement, so a grounded number inside a
 * larger token is never clipped) — it never hard-fails the user's turn. When
 * NO tool returned figures (a qualitative answer, or the no-tools path) there
 * is no authoritative set to grade against, so the check no-ops and the
 * prompt-level grounding rule remains the backstop, exactly like the briefing's
 * "no signals → skip".
 */
import { extractNumbers } from "@/lib/ai/briefing-grounding";
import type { Locale } from "@/lib/i18n/config";

/** Absolute + relative tolerance — identical basis to the briefing verifier. */
const ABS_TOLERANCE = 0.15;
const REL_TOLERANCE = 0.02;

/**
 * Window lengths + small ordinals the prose uses structurally ("last 7 days",
 * "2 of your vitals", "3 readings") — never graded, to avoid false positives on
 * honest framing. Mirrors the briefing verifier's exemption set.
 */
const STRUCTURAL_INTEGERS = new Set([7, 14, 30, 31, 90, 180, 365]);

function isStructural(value: number, raw: string): boolean {
  if (raw.includes(".") || raw.includes(",")) return false;
  if (!Number.isInteger(value)) return false;
  const abs = Math.abs(value);
  if (abs <= 3) return true;
  return STRUCTURAL_INTEGERS.has(abs);
}

/** One prose number that matched no figure any tool returned this turn. */
export interface UnverifiedCoachNumber {
  /** The numeric value the model wrote, as parsed. */
  value: number;
  /** The raw token the value was read from (truncated). */
  source: string;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Kinds — the unit family a figure belongs to. Kind scoping is what stops a
 * fabricated systolic grounding against a numerically-nearby weight or a step
 * count. An entry / token with an unknown kind is `null` (unkinded) and matches
 * magnitude-only (exact / ±2%), never with the widening normal forms — so
 * kinding is a monotone tightening path: every kind added strictly improves
 * precision, never widens.
 * ────────────────────────────────────────────────────────────────────────── */
type NumKind =
  | "mass"
  | "pressure"
  | "pulse"
  | "percent"
  | "duration"
  | "count"
  | "glucose";

/** Resolve a kind from a unit suffix the prose attaches to a number. */
function unitToKind(unitRaw: string): NumKind | null {
  const u = unitRaw.toLowerCase().replace(/\s+/g, "");
  if (/^(?:kg|kilograms?|kgs|lb|lbs|pounds?)$/.test(u)) return "mass";
  if (u === "mmhg") return "pressure";
  if (u === "bpm") return "pulse";
  if (u === "%" || u === "percent" || u === "percent." || u === "percentage")
    return "percent";
  if (/^(?:min|mins|minute|minutes|m|h|hr|hrs|hour|hours)$/.test(u))
    return "duration";
  if (/^(?:steps?)$/.test(u)) return "count";
  if (/^(?:mg\/dl|mmol\/l|mgdl|mmoll)$/.test(u)) return "glucose";
  return null;
}

/** Resolve a kind from a payload KEY name (best-effort substring match). */
function keyToKind(key: string): NumKind | null {
  const k = key.toLowerCase();
  if (/sys|dia|systol|diastol|(?:^|[^a-z])bp(?:[^a-z]|$)|mmhg/.test(k))
    return "pressure";
  if (/weight|mass|bodyweight|kg\b/.test(k)) return "mass";
  if (/pulse|bpm|heart.?rate|restinghr|\brhr\b|resting/.test(k)) return "pulse";
  if (/sleep|asleep|awake|inbed|duration|minutesasleep/.test(k))
    return "duration";
  if (/step/.test(k)) return "count";
  if (/adherence|complian|\brate\b|percent/.test(k)) return "percent";
  if (/glucose|mgdl|mmol/.test(k)) return "glucose";
  return null;
}

/** Resolve a kind from a payload's `metric` / `type` discriminator. */
function metricToKind(metric: string): NumKind | null {
  const m = metric.toLowerCase();
  if (/weight|mass|bodyweight/.test(m)) return "mass";
  if (/^bp$|blood.?pressure|systol|diastol/.test(m)) return "pressure";
  if (/pulse|heart.?rate|\bhr\b|resting/.test(m)) return "pulse";
  if (/sleep/.test(m)) return "duration";
  if (/step/.test(m)) return "count";
  if (/adherence|complian/.test(m)) return "percent";
  if (/glucose/.test(m)) return "glucose";
  return null;
}

/**
 * v1.21.0 — the small, named "central tendency" fields every snapshot block
 * exposes (`latest`, `avg7`, `avgSys30`, `allTimeAvg`, …). A value reached
 * under one of these keys (and NOT inside a timeline array) is an AGGREGATE —
 * the widening normal forms apply to it. A raw sample, a per-day rate, a
 * per-night value (all inside arrays), or a value under any other key is a
 * SAMPLE, graded exact / ±2% only, because over a dense series the widenings
 * compound into the free band the reconciler forswears.
 */
const AGGREGATE_POINT_KEY =
  /^(?:latest|current|mean|median|avg(?:Sys|Dia)?\d*(?:LastMonth|LastYear)?|average|allTime(?:Avg|Min|Max)(?:Sys|Dia)?|min|max|spread\d*|delta(?:Vs)?\d*|rate|headline)$/i;

/** Defensive cap on aggregate points contributed to the pairwise derivation. */
const MAX_AGGREGATE_POINTS = 12;

/** A typed authoritative figure the model was shown this turn. */
interface AuthEntry {
  value: number;
  kind: NumKind | null;
  aggregation: "aggregate" | "sample";
}

/**
 * Walk a single tool-result payload and register every finite numeric leaf as
 * a typed authoritative entry. `kind` is inferred from the payload's `metric`
 * discriminator first, then the enclosing key name; `aggregation` from whether
 * the value sits under an aggregate-point key and outside every array.
 */
function collectEntries(
  value: unknown,
  out: AuthEntry[],
  ctx: { metricKind: NumKind | null; keyHint: string | null; inArray: boolean },
): void {
  if (value === null || value === undefined) return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return;
    const keyKind = ctx.keyHint ? keyToKind(ctx.keyHint) : null;
    const aggregate =
      !ctx.inArray &&
      ctx.keyHint !== null &&
      AGGREGATE_POINT_KEY.test(ctx.keyHint);
    out.push({
      value,
      kind: ctx.metricKind ?? keyKind,
      aggregation: aggregate ? "aggregate" : "sample",
    });
    return;
  }
  if (typeof value === "string") {
    // A scalar numeric string ("128", "-1.2", "92%") — pull its magnitudes.
    for (const { value: n } of extractNumbers(value)) {
      const keyKind = ctx.keyHint ? keyToKind(ctx.keyHint) : null;
      out.push({
        value: n,
        kind: ctx.metricKind ?? keyKind,
        // A number embedded in a string is not a clean aggregate point.
        aggregation: "sample",
      });
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectEntries(item, out, { ...ctx, inArray: true });
    }
    return;
  }
  if (typeof value === "object") {
    // Pick up a `metric` / `type` discriminator to kind every leaf beneath it.
    let metricKind = ctx.metricKind;
    const record = value as Record<string, unknown>;
    for (const disc of ["metric", "type", "kind", "measure"]) {
      const v = record[disc];
      if (typeof v === "string") {
        const k = metricToKind(v);
        if (k) metricKind = k;
      }
    }
    for (const [k, v] of Object.entries(record)) {
      collectEntries(v, out, { metricKind, keyHint: k, inArray: false });
    }
  }
}

/** Collect every aggregate-point magnitude under one payload (for derivation). */
function collectAggregatePoints(entries: readonly AuthEntry[]): number[] {
  const out = new Set<number>();
  for (const e of entries) {
    if (e.aggregation === "aggregate") out.add(e.value);
  }
  return [...out];
}

/**
 * The delta, midpoint average, and percent-change between every PAIR of a
 * SINGLE payload's own aggregate points — the shapes a model legitimately
 * narrates ("down 3.5 kg from your 7-day average", "roughly a 5% drop").
 * Registered UNKINDED (a percent-change is not the points' kind) and graded
 * exact / ±2% only, and never pooled across payloads, so a weight delta cannot
 * ground itself against an unrelated blood-pressure figure nearby.
 */
function deriveArithmeticEntries(points: readonly number[]): AuthEntry[] {
  if (points.length < 2 || points.length > MAX_AGGREGATE_POINTS) return [];
  const derived: AuthEntry[] = [];
  const add = (value: number) =>
    derived.push({ value, kind: null, aggregation: "aggregate" });
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      const a = points[i];
      const b = points[j];
      const diff = Math.abs(a - b);
      add(diff);
      add((a + b) / 2);
      if (a !== 0) add((diff / Math.abs(a)) * 100);
      if (b !== 0) add((diff / Math.abs(b)) * 100);
    }
  }
  return derived;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Reconciler — grade one typed prose magnitude against the authoritative set.
 * ────────────────────────────────────────────────────────────────────────── */

/** True when `token` rounds to `anchor` at the nearest 1 / 5 / 10. */
function isCanonicalRounding(token: number, anchor: number): boolean {
  for (const step of [1, 5, 10]) {
    if (Math.round(anchor / step) * step === token) return true;
  }
  return false;
}

/** Exact / ±2% magnitude match — the floor every entry allows. */
function withinTolerance(token: number, anchor: number): boolean {
  const tol = Math.max(ABS_TOLERANCE, Math.abs(anchor) * REL_TOLERANCE);
  return Math.abs(token - anchor) <= tol;
}

/**
 * True when the typed prose magnitude reconciles against any authoritative
 * entry. Kind scoping: a kinded token never matches a differently-kinded
 * entry. Widening forms (sign, rounding, ratio↔percent, minutes↔hours) fire
 * only for an aggregate, kinded entry.
 */
function reconciles(
  token: { value: number; kind: NumKind | null },
  entries: readonly AuthEntry[],
): boolean {
  for (const entry of entries) {
    // Kind gate — only rejects when BOTH sides are confidently kinded.
    if (token.kind !== null && entry.kind !== null && token.kind !== entry.kind)
      continue;

    // Exact / ±2% is always available (this is the unkinded / sample floor).
    if (withinTolerance(token.value, entry.value)) return true;

    // Widening forms apply ONLY to an aggregate, kinded entry.
    if (entry.aggregation !== "aggregate" || entry.kind === null) continue;

    // Sign-insensitive — a delta narrated as a positive "drop".
    if (withinTolerance(Math.abs(token.value), Math.abs(entry.value)))
      return true;

    // Canonical rounding — anchored to the authoritative value, never a band.
    if (isCanonicalRounding(token.value, entry.value)) return true;

    // Ratio↔percent — normalise INTO percent space (multiply the ratio up),
    // never divide the token down (dividing turns ±0.15 into ±15 points).
    if (
      (entry.kind === "percent" || token.kind === "percent") &&
      entry.value > 0 &&
      entry.value <= 1
    ) {
      if (withinTolerance(token.value, entry.value * 100)) return true;
    }

    // Minutes↔hours — a per-day duration narrated in hours (444 min ⇔ 7.4 h).
    if (entry.kind === "duration") {
      if (withinTolerance(token.value, entry.value / 60)) return true;
    }
  }
  return false;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Typed tokenizer — classify each prose number before grading. Benign types
 * (date / time / year / ordinal / list marker) are dropped; magnitudes
 * (percent / measurement / count / range endpoint / plain) are returned for
 * grading with their unit-derived kind.
 * ────────────────────────────────────────────────────────────────────────── */

interface ProseMagnitude {
  value: number;
  raw: string;
  kind: NumKind | null;
}

const MONTHS =
  "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|januar|februar|märz|maerz|april|mai|juni|juli|august|september|oktober|november|dezember";

/** Parse a raw number token honouring the reply language's separators. */
function parseLocaleNumber(raw: string, locale: Locale): number | null {
  let normalised: string;
  if (locale === "en") {
    // EN: "," groups thousands, "." is the decimal point.
    normalised = raw.replace(/,/g, "");
  } else {
    // DE / fr / es / it / pl: "." groups thousands, "," is the decimal point.
    normalised = raw.replace(/\./g, "").replace(/,/g, ".");
  }
  const value = Number.parseFloat(normalised);
  return Number.isFinite(value) ? value : null;
}

/**
 * Tokenize the prose into gradeable magnitudes. Everything that is positively
 * typed as benign — an ISO or written date, a clock time, a bare year, an
 * English ordinal, or a numbered-list marker — is skipped, so it is never
 * graded and never stripped. Range pairs decompose into two endpoint
 * magnitudes.
 */
function tokenizeMagnitudes(prose: string, locale: Locale): ProseMagnitude[] {
  const out: ProseMagnitude[] = [];
  // Every character index already consumed by a benign / structural token, so
  // a later pass does not re-read its digits as a bare magnitude.
  const consumed = new Array<boolean>(prose.length).fill(false);
  const claim = (start: number, end: number): boolean => {
    for (let i = start; i < end; i += 1) if (consumed[i]) return false;
    for (let i = start; i < end; i += 1) consumed[i] = true;
    return true;
  };

  const numFrag =
    locale === "en"
      ? String.raw`[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?|[+-]?\d+(?:\.\d+)?`
      : String.raw`[+-]?\d{1,3}(?:\.\d{3})+(?:,\d+)?|[+-]?\d+(?:,\d+)?`;

  const runPass = (
    re: RegExp,
    handle: (m: RegExpExecArray) => void,
  ): void => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(prose)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex += 1;
        continue;
      }
      handle(m);
    }
  };

  // (1) ISO dates — the whole span is benign.
  runPass(/\b\d{4}-\d{2}-\d{2}\b/g, (m) => {
    claim(m.index, m.index + m[0].length);
  });

  // (2) Clock times — "22:45", "7:30:00".
  runPass(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, (m) => {
    claim(m.index, m.index + m[0].length);
  });

  // (3) Written dates — "July 21st", "21. Juli", "6 May", "Mai 6".
  runPass(
    new RegExp(
      String.raw`\b(?:(?:${MONTHS})\s+\d{1,2}(?:st|nd|rd|th)?|\d{1,2}\.?\s+(?:${MONTHS}))\b`,
      "gi",
    ),
    (m) => {
      claim(m.index, m.index + m[0].length);
    },
  );

  // (4) English ordinals — "21st", "3rd" (a day-of-month or a rank).
  runPass(/\b\d{1,3}(?:st|nd|rd|th)\b/gi, (m) => {
    claim(m.index, m.index + m[0].length);
  });

  // (5) Numbered-list markers at line start — "1. Cut back on sodium".
  runPass(/(?:^|\n)[ \t]*\d{1,3}\.[ \t]/g, (m) => {
    claim(m.index, m.index + m[0].length);
  });

  // (5b) Hyphenated time-span adjectives — "10-year", "7-day", "12-week". The
  //      number is a window length, never a health magnitude. Hours / minutes
  //      are deliberately excluded so a real duration ("7.4 hours") is graded.
  runPass(/\b\d{1,3}-(?:year|yr|month|week|day)s?\b/gi, (m) => {
    claim(m.index, m.index + m[0].length);
  });

  // (6) Bare years — 19xx / 20xx standing alone (not part of a larger number
  //     or a decimal; a trailing sentence comma / period is fine).
  runPass(/(?<![\d.,])(?:19|20)\d{2}(?![\d]|[.,]\d)/g, (m) => {
    claim(m.index, m.index + m[0].length);
  });

  // (7) Range pairs — "60-100", "between 120 and 135", "from 120 to 135". Both
  //     endpoints are decomposed into magnitudes graded independently. The unit
  //     that trails the pair kinds both endpoints.
  const rangeUnit = String.raw`(?:\s*(mmHg|bpm|kg|mg\/dl|mmol\/l|%|steps?|minutes?|mins?|hours?|hrs?|hr))?`;
  const dashRange = new RegExp(
    String.raw`\b(\d+(?:[.,]\d+)?)\s*(?:-|–|—|to|bis)\s*(\d+(?:[.,]\d+)?)${rangeUnit}`,
    "gi",
  );
  runPass(dashRange, (m) => {
    if (!claim(m.index, m.index + m[0].length)) return;
    const kind = m[3] ? unitToKind(m[3]) : null;
    for (const part of [m[1], m[2]]) {
      const value = parseLocaleNumber(part, locale);
      if (value !== null) out.push({ value: Math.abs(value), raw: part, kind });
    }
  });
  const wordRange = new RegExp(
    String.raw`\b(?:between|from|zwischen|von)\s+(\d+(?:[.,]\d+)?)\s+(?:and|to|und|bis)\s+(\d+(?:[.,]\d+)?)${rangeUnit}`,
    "gi",
  );
  runPass(wordRange, (m) => {
    if (!claim(m.index, m.index + m[0].length)) return;
    const kind = m[3] ? unitToKind(m[3]) : null;
    for (const part of [m[1], m[2]]) {
      const value = parseLocaleNumber(part, locale);
      if (value !== null) out.push({ value: Math.abs(value), raw: part, kind });
    }
  });

  // (8) Percents — "93%", "93 percent".
  runPass(
    new RegExp(String.raw`(${numFrag})\s*(%|percent|per\s+cent|prozent)`, "gi"),
    (m) => {
      if (!claim(m.index, m.index + m[0].length)) return;
      const value = parseLocaleNumber(m[1], locale);
      if (value !== null) out.push({ value, raw: m[1], kind: "percent" });
    },
  );

  // (9) Unit-suffixed measurements — "72.4 kg", "128 mmHg", "10,000 steps".
  const unitFrag =
    "kg|kilograms?|lbs?|pounds?|mmHg|bpm|mg\\/dl|mmol\\/l|steps?|minutes?|mins?|hours?|hrs?|hr";
  runPass(
    new RegExp(String.raw`(${numFrag})\s*(${unitFrag})\b`, "gi"),
    (m) => {
      if (!claim(m.index, m.index + m[0].length)) return;
      const value = parseLocaleNumber(m[1], locale);
      if (value !== null)
        out.push({ value, raw: m[1], kind: unitToKind(m[2]) });
    },
  );

  // (10) Everything left — plain magnitudes (no benign type, no unit).
  runPass(new RegExp(`(?:${numFrag})`, "g"), (m) => {
    if (!claim(m.index, m.index + m[0].length)) return;
    const value = parseLocaleNumber(m[0], locale);
    if (value !== null) out.push({ value, raw: m[0], kind: null });
  });

  return out;
}

/**
 * Recursively collect every finite numeric leaf from a tool-result payload as
 * a plain magnitude set. Retained for callers that only need magnitudes (the
 * eval harness); the runtime verifier uses the typed `collectEntries` above.
 */
export function collectNumericLeaves(value: unknown, out: Set<number>): void {
  const entries: AuthEntry[] = [];
  collectEntries(value, entries, {
    metricKind: null,
    keyHint: null,
    inArray: false,
  });
  for (const e of entries) out.add(e.value);
}

/**
 * Find every number the Coach prose asserts that does not trace to a figure
 * returned by a tool this turn. Returns an empty array when there is no prose,
 * no authoritative figure set (no present tool result with numbers), or every
 * cited number is grounded.
 *
 * `toolPayloads` is the `data` payload of each PRESENT tool result this turn.
 * `locale` is the reply's language, used only to parse thousands / decimal
 * separators the right way ("10,000" is ten thousand in EN, "10.000" in DE).
 */
export function findUnverifiedCoachNumbers(
  prose: string,
  toolPayloads: ReadonlyArray<unknown>,
  locale: Locale = "en",
): UnverifiedCoachNumber[] {
  if (!prose) return [];
  const authoritative: AuthEntry[] = [];
  for (const payload of toolPayloads) {
    const entries: AuthEntry[] = [];
    collectEntries(payload, entries, {
      metricKind: null,
      keyHint: null,
      inArray: false,
    });
    authoritative.push(...entries);
    // Widen with figures a model may legitimately compute from THIS payload's
    // own headline numbers, without pooling across unrelated payloads.
    authoritative.push(
      ...deriveArithmeticEntries(collectAggregatePoints(entries)),
    );
  }
  // No authoritative figures (a qualitative turn / no-tools path) — nothing to
  // grade against. The prompt-level grounding rule remains the backstop.
  if (authoritative.length === 0) return [];

  const findings: UnverifiedCoachNumber[] = [];
  for (const token of tokenizeMagnitudes(prose, locale)) {
    if (isStructural(token.value, token.raw)) continue;
    if (reconciles(token, authoritative)) continue;
    findings.push({ value: token.value, source: token.raw.slice(0, 32) });
  }
  return findings;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Structured-claim grounding (B0 — additive; the numeric API above is unchanged).
 *
 * The numeric verifier catches a figure the model invented or mis-copied. It
 * cannot catch a CLAIM made in words: "your blood pressure is high", "this is
 * above your usual range", "you scored well". Those carry no number, so the
 * numeric set never grades them. The eval harness needs a high-precision
 * deterministic floor for the claim categories the D5 taxonomy pins —
 * threshold, own-baseline, and confident-verdict-on-sparse-data — to gate
 * Coach changes without a paid judge call.
 *
 * Posture (deliberately narrow): each detector is HIGH PRECISION, not high
 * recall. It fires only on unambiguous phrasings, so a green grade is trusted
 * and the open-ended remainder (tone, nuance, partial claims) is left to the
 * live judge in layer 2. A claim-grounding miss here is a false NEGATIVE the
 * judge covers — never a false positive that blocks a good answer.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Confident-verdict phrasings: an unhedged state assertion. These are the
 * phrasings a data-honesty case must NOT see when the snapshot is sparse —
 * "still learning" framing is required there, never a confident verdict.
 */
const CONFIDENT_VERDICT_PATTERNS: readonly RegExp[] = [
  /\byou(?:'re| are)\s+(?:clearly|definitely|certainly|obviously)\s+\w+/i,
  /\bthis\s+(?:clearly|definitely|certainly)\s+(?:shows|means|proves)\b/i,
  /\b(?:there(?:'s| is)\s+no\s+doubt|without\s+a\s+doubt|it'?s\s+clear\s+that)\b/i,
];

/**
 * Threshold-verdict phrasings: a diagnosis-shaped claim that the user HAS a
 * named condition. Surfaced as its own claim kind because the medical-claim
 * boundary is the sharpest line — the Coach narrates data, it never diagnoses.
 */
const THRESHOLD_VERDICT_PATTERNS: readonly RegExp[] = [
  /\byou\s+(?:have|'ve\s+got|are\s+developing|are\s+showing\s+signs\s+of)\s+(?:hypertension|hypotension|diabetes|prediabetes|a\s+condition|an?\s+arrhythmia)\b/i,
  /\byou\s+(?:are|'re)\s+(?:hypertensive|diabetic|prediabetic)\b/i,
];

/**
 * Hedge / data-honesty phrasings that make a sparse-data answer honest:
 * "still learning", "early to say", "not enough data yet", "a few readings".
 * Their PRESENCE is what a sparse case asserts; their ABSENCE alongside a
 * confident verdict is the regression.
 */
const HONESTY_HEDGE_PATTERNS: readonly RegExp[] = [
  /\bstill\s+(?:learning|getting\s+to\s+know|building)\b/i,
  /\b(?:too\s+early|early\s+days|early\s+to\s+say|hard\s+to\s+say)\b/i,
  /\bnot\s+(?:enough|much)\s+(?:data|readings?|history)\b/i,
  /\b(?:only\s+)?(?:a\s+few|just\s+a\s+(?:few|couple))\s+(?:readings?|days?|entries)\b/i,
  /\b(?:keep\s+logging|once\s+(?:i\s+have|there(?:'s| is)|it'?s|you\s+start)|when\s+you\s+start)\b/i,
  /\bgive\s+it\s+(?:a\s+few\s+more|more)\s+(?:days|readings?)\b/i,
  /\b(?:i\s+)?don'?t\s+have\s+(?:any\s+)?(?:\w+\s+)?(?:data|readings?|entries|history)\s+(?:logged\s+)?yet\b/i,
  /\bno\s+(?:\w+\s+)?(?:data|readings?|entries)\s+(?:logged\s+)?yet\b/i,
];

/**
 * Own-baseline framing: the answer is anchored to the USER's own range, not a
 * population norm. "above your usual", "for you", "your typical", "compared to
 * your baseline". Their presence is what an own-baseline case asserts.
 */
const OWN_BASELINE_PATTERNS: readonly RegExp[] = [
  /\b(?:above|below|within|outside)\s+your\s+(?:usual|typical|normal|baseline|range)\b/i,
  /\bfor\s+you\b/i,
  /\byour\s+(?:usual|typical|own|personal)\s+(?:range|baseline|average|level)\b/i,
  /\bcompared\s+to\s+your\b/i,
  /\b(?:higher|lower)\s+than\s+(?:you\s+usually|your\s+usual)\b/i,
];

/**
 * Population-norm framing the grader flags when a case forbids it: "the normal
 * range is", "healthy adults", "the general population". High precision — these
 * phrasings unambiguously cite a population norm rather than the user's own.
 */
const POPULATION_NORM_PATTERNS: readonly RegExp[] = [
  /\bthe\s+normal\s+range\s+(?:is|for)\b/i,
  /\b(?:healthy|most|the\s+average)\s+(?:adults?|people|population)\b/i,
  /\bthe\s+general\s+population\b/i,
  /\b(?:guidelines?|doctors?)\s+(?:say|recommend|consider)\b.{0,40}\bnormal\b/i,
];

/** True when the prose carries any data-honesty hedge. */
export function hasHonestyHedge(prose: string): boolean {
  return HONESTY_HEDGE_PATTERNS.some((p) => p.test(prose));
}

/** True when the prose anchors against the user's OWN range/baseline. */
export function hasOwnBaselineFraming(prose: string): boolean {
  return OWN_BASELINE_PATTERNS.some((p) => p.test(prose));
}

/** True when the prose cites a POPULATION norm (vs the user's own baseline). */
export function hasPopulationNormFraming(prose: string): boolean {
  return POPULATION_NORM_PATTERNS.some((p) => p.test(prose));
}

/** True when the prose makes an unhedged confident state verdict. */
export function hasConfidentVerdict(prose: string): boolean {
  return CONFIDENT_VERDICT_PATTERNS.some((p) => p.test(prose));
}

/** True when the prose makes a diagnosis-shaped threshold verdict. */
export function hasThresholdVerdict(prose: string): boolean {
  return THRESHOLD_VERDICT_PATTERNS.some((p) => p.test(prose));
}

/**
 * Soft-correct the prose: replace each unverified numeric token with a neutral
 * placeholder so a drifted figure never reaches the user as if authoritative,
 * while the surrounding qualitative framing is preserved. Conservative — it
 * only rewrites the exact ungrounded tokens the verifier flagged, and only the
 * first occurrence of each.
 *
 * Boundary-safe (v1.32.7): the flagged token is matched only where it is NOT
 * embedded in a larger number, so a flagged "23" can never clip "20[unverified]"
 * out of a grounded "2023". The old plain `indexOf` had that exact bug.
 *
 * Returns the (possibly unchanged) prose plus the count of tokens stripped.
 */
export function stripUnverifiedNumbers(
  prose: string,
  findings: ReadonlyArray<UnverifiedCoachNumber>,
): { prose: string; stripped: number } {
  if (findings.length === 0) return { prose, stripped: 0 };
  let out = prose;
  let stripped = 0;
  for (const f of findings) {
    const token = f.source;
    if (token.length === 0) continue;
    // Match the token bounded by non-digit / non-separator edges so a larger
    // number that merely contains it is never clipped.
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const bounded = new RegExp(`(?<![\\d.,+-])${escaped}(?![\\d.,])`);
    const match = bounded.exec(out);
    if (match === null) continue;
    const idx = match.index;
    out = `${out.slice(0, idx)}[unverified]${out.slice(idx + token.length)}`;
    stripped += 1;
  }
  return { prose: out, stripped };
}
