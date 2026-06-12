/**
 * OpenAPI route table — medications CRUD, intake, cadence, compliance, AI extraction.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 * Schemas come from `src/lib/validations/*` where shared with the
 * runtime request parsing, so the wire contract stays single-source.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";
import {
  createMedicationSchema,
  updateMedicationSchema,
  intakeSchema,
  createInventoryItemSchema,
  updateInventoryItemSchema,
  MEDICATION_CATEGORY_VALUES,
  MEDICATION_CONTAINER_TYPE_VALUES,
  MEDICATION_TREATMENT_CLASS_VALUES,
} from "@/lib/validations/medication";
import { medicationExtractionSchema } from "@/lib/ai/coach/medication-extract-prompt";
import {
  MEDICATION_LIST_VIEWS,
  MEDICATION_ORDER_ID_MAX_LENGTH,
  MEDICATION_ORDER_MAX_ENTRIES,
} from "@/lib/medication-list-layout";
import {
  scheduleRevisionCreateSchema,
  scheduleRevisionUpdateSchema,
} from "@/lib/validations/schedule-revision";
import { dataEnvelope, errorEnvelope, stdResponses } from "./shared";

// ── Medications (v1.5 scheduling) ────────────────────────────────────
//
// The Medication + MedicationSchedule resource shapes documented below
// follow the wire envelope the seven routes registered at the bottom of
// this file emit. `windowStart` / `windowEnd` / `daysOfWeek` /
// `intervalWeeks` are the legacy primitives kept for backwards
// compatibility through the v1.5.x line; `timesOfDay`, `rrule`,
// `rollingIntervalDays`, and `reminderGraceMinutes` are the v1.5
// first-class primitives the wizard + iOS cadence picker write. The
// XOR between `rrule` and `rollingIntervalDays` is documented at the
// schema description AND enforced by the route + a DB CHECK constraint
// so iOS code-gen surfaces the mutual exclusion.

const medicationCategoryEnum = z.enum(MEDICATION_CATEGORY_VALUES).meta({
  id: "MedicationCategory",
  description:
    "Clinical taxonomy stored in the `medication_categories` side-table. Orthogonal to `MedicationTreatmentClass`.",
});

const medicationTreatmentClassEnum = z
  .enum(MEDICATION_TREATMENT_CLASS_VALUES)
  .meta({
    id: "MedicationTreatmentClass",
    description:
      "Prisma-level treatment-class discriminator. `GLP1` unlocks the GLP-1 specialist surfaces (injection-site rotation, titration history, pen inventory, GLP-1-aware Coach).",
  });

const medicationScheduleResource = z
  .object({
    id: z.string(),
    medicationId: z.string(),
    windowStart: z
      .string()
      .describe(
        "Legacy single-time-of-intake (HH:mm, user local). Preserved for backwards compatibility; the new `timesOfDay` array supersedes it.",
      ),
    windowEnd: z
      .string()
      .describe(
        "Legacy reminder-window upper bound (HH:mm). Used to derive the late-classification grace span when `reminderGraceMinutes` is null.",
      ),
    label: z.string().nullable(),
    dose: z
      .string()
      .nullable()
      .describe(
        "Per-schedule dose override. NULL means the schedule inherits `Medication.dose`.",
      ),
    daysOfWeek: z
      .string()
      .nullable()
      .describe(
        "Legacy persisted recurrence encoding (`null` | `1,3,5` | `i2;1,3,5`). v1.5 readers consult `rrule` first; the field is kept for pre-v1.5 rows. v1.6.0 drops the column.",
      ),
    timesOfDay: z
      .array(z.string())
      .describe(
        "v1.5 first-class points-in-time the dose is taken (HH:mm, user local). Backfilled to `[windowStart]` for every pre-v1.5 row.",
      ),
    reminderGraceMinutes: z
      .number()
      .int()
      .nullable()
      .describe(
        "Reminder grace window in minutes. NULL falls back to the legacy `windowEnd - windowStart` span.",
      ),
    rrule: z
      .string()
      .nullable()
      .describe(
        "RFC 5545 RRULE string (subset). Used for calendar-anchored cadences. **Mutually exclusive with `rollingIntervalDays`** — exactly one of the two is non-null on any v1.5+ schedule (or both are null on legacy rows that haven't been touched since the migration).",
      ),
    rollingIntervalDays: z
      .number()
      .int()
      .nullable()
      .describe(
        "Flexible-rolling interval in days, counted forward from the latest `MedicationIntakeEvent.takenAt`. **Mutually exclusive with `rrule`.**",
      ),
    scheduleType: z
      .enum(["SCHEDULED", "PRN", "CYCLIC"])
      .describe(
        "v1.7.0 schedule-type discriminator. SCHEDULED = rrule / rolling / legacy cadence. PRN = as-needed (never projected, reminded, or counted in compliance expected; still loggable via the intake route). CYCLIC = N weeks on / M weeks off, gating whichever inner cadence the rrule / legacy fields describe.",
      ),
    cyclicOnWeeks: z
      .number()
      .int()
      .nullable()
      .describe(
        'v1.7.0 cyclic "on" weeks. Only meaningful when `scheduleType` is CYCLIC; null otherwise.',
      ),
    cyclicOffWeeks: z
      .number()
      .int()
      .nullable()
      .describe(
        'v1.7.0 cyclic "off" weeks. Only meaningful when `scheduleType` is CYCLIC; null otherwise.',
      ),
  })
  .meta({
    id: "MedicationSchedule",
    description:
      "Schedule entry attached to a medication. v1.5 promotes `timesOfDay` to first-class and introduces `rrule` (calendar-anchored cadences) and `rollingIntervalDays` (flexible-rolling cadences). The two recurrence primitives are mutually exclusive — enforced by the Zod refine on writes, the route layer, and a DB CHECK constraint (`medication_schedules_rrule_xor_rolling`). v1.7.0 adds `scheduleType` (SCHEDULED / PRN / CYCLIC) and the cyclic on/off-week fields.",
  });

export const medicationResource = z
  .object({
    id: z.string(),
    name: z.string(),
    dose: z.string(),
    treatmentClass: medicationTreatmentClassEnum,
    dosesPerUnit: z
      .number()
      .int()
      .nullable()
      .describe(
        "Doses per pen / vial for inventory tracking. NULL = inventory tracking off.",
      ),
    unitsPerDose: z
      .number()
      .int()
      .describe(
        "v1.16.10 — inventory units one dose consumes (e.g. 2 tablets of 2 mg for a 4 mg dose). Default 1. The intake consumption hook decrements this many units per taken dose; dose-derived readouts divide unit counts by it.",
      ),
    active: z.boolean(),
    notificationsEnabled: z.boolean(),
    liveActivityEnabled: z
      .boolean()
      .describe(
        "v1.7.0 iOS Live Activity opt-in for this medication's reminders. Default false. The iOS client owns the ActivityKit lifecycle; the server only stores + echoes the flag.",
      ),
    criticalAlarmEnabled: z
      .boolean()
      .describe(
        "v1.7.0 iOS 26 AlarmKit critical-reminder opt-in. Default false. Critical alarms bypass the device mute switch / Focus; the server stores the preference only.",
      ),
    atcCode: z
      .string()
      .nullable()
      .describe(
        "v1.9.0 optional WHO ATC classification code (active-substance class, e.g. `A10BX10`). User/clinician-asserted; never machine-guessed. Emitted on the FHIR `medicationCodeableConcept` under `http://www.whocc.no/atc`. NULL = no code captured.",
      ),
    rxNormCode: z
      .string()
      .nullable()
      .describe(
        "v1.9.0 optional RxNorm RxCUI (numeric, US identifier, e.g. `2601723`). Secondary FHIR coding under `http://www.nlm.nih.gov/research/umls/rxnorm`, alongside any ATC code. NULL = no code captured.",
      ),
    pausedAt: z.iso.datetime({ offset: true }).nullable(),
    snoozedUntil: z.iso.datetime({ offset: true }).nullable(),
    nextDueAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe(
        "v1.7.0 server-computed next due instant across all the medication's schedules (earliest `nextOccurrenceAfter`). Read-only — computed, not stored. NULL when no schedule has an upcoming slot (paused, one-shot in the past, `endsOn` crossed, every schedule PRN). v1.16.4 — when an unresolved slot's anchor has passed but the catch-up band is still open (`anchor < now <= overdueEnd`, current schedule era), this carries THAT slot (a past instant) with `nextDueOverdue: true` instead of jumping to the next future slot. The list GET is cached 60 s, so a 60 s staleness is accepted.",
      ),
    nextDueOverdue: z
      .boolean()
      .describe(
        "v1.16.4 — true when `nextDueAt` is an OPEN overdue slot: its anchor has passed, `now` is still inside the slot's catch-up band, and no taken / skipped / auto-missed row resolves it. False for a regular future next-due (and when `nextDueAt` is null). Read-only — computed, not stored.",
      ),
    startsOn: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe(
        "v1.5 course start (ISO date). Anchors RRULE BYDAY / BYMONTHDAY patterns and the rolling-interval countdown's first window. NULL means active from creation.",
      ),
    endsOn: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe(
        "v1.5 course end (ISO date). NULL means chronic. Equals `startsOn` when `oneShot` is true.",
      ),
    oneShot: z
      .boolean()
      .describe(
        "v1.5 single-administration flag. When true the medication has at most one schedule (no `rrule` / `rollingIntervalDays`), and `active` auto-flips to false once the dose is logged.",
      ),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
    schedules: z.array(medicationScheduleResource),
  })
  .meta({
    id: "Medication",
    description:
      "Server-shaped medication row returned by GET / POST / PUT endpoints. Carries the v1.5 course-window fields (`startsOn`, `endsOn`, `oneShot`) at the medication level and the per-schedule cadence fields on the nested `schedules` array.",
  });

const medicationListEntry = medicationResource
  .extend({
    category: medicationCategoryEnum,
    lastTakenAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe(
        "Latest non-skipped `MedicationIntakeEvent.takenAt` for the medication. Drives the rolling-cadence countdown surface.",
      ),
    todayEventCount: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Number of ACTIONED intake events for today (user-local day window): rows with a recorded `takenAt` or an explicit skip. Pending projector-minted rows do not count — the card overdue-pill suppression compares this against the passed-dose count, and a pending mint must not read as covered.",
      ),
    stockUnitsRemaining: z
      .number()
      .int()
      .nullable()
      .describe(
        "v1.16.10 — usable inventory units left across the medication's containers (sum of `unitsRemaining` over ACTIVE / IN_USE items with units left). NULL = inventory tracking off (no items ever registered); 0 = tracking on, supply ran out. Read-only — aggregated, not stored.",
      ),
    stockDosesRemaining: z
      .number()
      .int()
      .nullable()
      .describe(
        "v1.16.10 — dose-derived stock: `floor(stockUnitsRemaining / max(1, unitsPerDose))`. NULL when inventory tracking is off. Drives the table view's Bestand column. Read-only — aggregated, not stored.",
      ),
  })
  .meta({
    id: "MedicationListEntry",
    description:
      "List-row variant of the medication resource enriched with the joined `category`, `lastTakenAt`, `todayEventCount`, and the v1.16.10 aggregated stock fields (`stockUnitsRemaining`, `stockDosesRemaining`) the dashboard + iOS client consume. The base medication fields (`id`, `name`, `dose`, `treatmentClass`, `dosesPerUnit`, `active`, `notificationsEnabled`, `pausedAt`, `snoozedUntil`, `startsOn`, `endsOn`, `oneShot`, `createdAt`, `updatedAt`, `schedules`) are inlined; see the `Medication` component for their semantics.",
  });

const medicationDetailEntry = medicationResource
  .extend({
    category: medicationCategoryEnum,
  })
  .meta({
    id: "MedicationDetail",
    description:
      "Detail variant of the medication resource enriched with the joined `category`. The base medication fields are inlined; see the `Medication` component for their semantics.",
  });

// v1.16.10 — per-container inventory entity (pen / blister pack /
// bottle). Counts UNITS; the medication's `unitsPerDose` maps units to
// doses. The intake consumption hook decrements `unitsRemaining` per
// taken dose and stamps the intake event with what it consumed.
const medicationInventoryItemResource = z
  .object({
    id: z.string(),
    userId: z.string(),
    medicationId: z.string(),
    state: z
      .enum(["ACTIVE", "IN_USE", "EXPIRED", "USED_UP"])
      .describe(
        "Container lifecycle state. ACTIVE = unopened; IN_USE = opened (30-day in-use clock running); EXPIRED = printed expiry or in-use window lapsed with units left; USED_UP = drained (terminal).",
      ),
    containerType: z
      .enum(MEDICATION_CONTAINER_TYPE_VALUES)
      .describe(
        "Kind of physical container (PEN / AMPOULE / BLISTER / INHALER / BOTTLE / OTHER). Display-level classification; defaults to OTHER.",
      ),
    unitsTotal: z
      .number()
      .int()
      .describe(
        "Units the container shipped with (tablets / ampoules / puffs; 1–1000). Dose-derived readouts divide by the medication's `unitsPerDose`.",
      ),
    unitsRemaining: z
      .number()
      .int()
      .describe(
        "Units left in the container. Decremented by the intake consumption hook (FEFO with spillover across containers); refunded when a taken dose is skipped, edited away, or deleted.",
      ),
    firstUseAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe(
        "Instant the container was first used. NULL until opened; starts the 30-day in-use clock.",
      ),
    expiresAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe(
        "Persisted MIN(firstUseAt + 30 days, printedExpiry). NULL when neither clock has started.",
      ),
    printedExpiry: z.iso.datetime({ offset: true }).nullable(),
    purchasedAt: z.iso.datetime({ offset: true }).nullable(),
    notes: z.string().nullable(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .meta({
    id: "MedicationInventoryItem",
    description:
      "One supply container (pen / blister pack / bottle) of a medication. Counts UNITS — the medication's `unitsPerDose` maps units to doses. The intake write paths consume from the open container first, then first-expiry-first-out over unopened stock.",
  });

const medicationIntakeEventResource = z
  .object({
    id: z.string(),
    userId: z.string(),
    medicationId: z.string(),
    scheduledFor: z.iso.datetime({ offset: true }),
    takenAt: z.iso.datetime({ offset: true }).nullable(),
    skipped: z.boolean(),
    source: z.enum(["WEB", "API", "REMINDER", "IMPORT"]),
    idempotencyKey: z.string().nullable(),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .meta({
    id: "MedicationIntakeEvent",
    description:
      "Single dose log row. `takenAt` is non-null for confirmed intakes; `skipped:true` represents a deliberately-missed dose (no inventory consumption).",
  });

const medicationCadenceTimelinePoint = z
  .object({
    day: z.iso.datetime({ offset: true }),
    windowStart: z.iso.datetime({ offset: true }),
    windowEnd: z.iso.datetime({ offset: true }),
    scheduleIndex: z.number().int().nonnegative(),
    status: z.string(),
  })
  .meta({
    id: "MedicationCadenceTimelinePoint",
    description:
      "One expected-vs-actual dose slot for the cadence timeline chart. `status` is one of `taken | skipped | missed | pending | future` and drives the chip colour.",
  });

const medicationCadenceChips = z
  .object({
    adherenceRate: z.number(),
    streakDays: z.number().int().nonnegative(),
    expectedSlots: z.number().int().nonnegative(),
    actualDoses: z.number().int().nonnegative(),
  })
  .meta({
    id: "MedicationCadenceChips",
    description:
      "Four compliance summary values for the medication detail page chip row.",
  });

const medicationCadenceResponse = z
  .object({
    windowDays: z.number().int().positive(),
    anchorIso: z.iso.datetime({ offset: true }),
    next: z
      .object({
        windowStart: z.iso.datetime({ offset: true }),
        windowEnd: z.iso.datetime({ offset: true }),
        scheduleIndex: z.number().int().nonnegative(),
      })
      .nullable(),
    chips: medicationCadenceChips,
    timeline: z.array(medicationCadenceTimelinePoint),
  })
  .meta({
    id: "MedicationCadenceResponse",
    description:
      "Cadence + compliance read for a single medication. `next` is the upcoming-dose envelope (null when the course has ended or the rolling clock has no pinning intake yet); `timeline` walks the requested `windowDays` worth of slots in ascending time order.",
  });

const complianceResult = z
  .object({
    totalExpected: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Full denominator over the window: `taken + skipped + missed`. Cadence-aware and clamped to the medication's `createdAt`.",
      ),
    taken: z.number().int().nonnegative(),
    skipped: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Doses the user explicitly skipped — excluded from the `rate` denominator.",
      ),
    missed: z.number().int().nonnegative(),
    rate: z
      .number()
      .int()
      .min(0)
      .max(100)
      .describe(
        "Adherence percentage `round(taken / (taken + missed) * 100)` — `skipped` is excluded from the denominator.",
      ),
    streak: z
      .number()
      .int()
      .nonnegative()
      .describe("Consecutive days with every due dose taken."),
  })
  .meta({
    id: "ComplianceResult",
    description:
      "Rolling-window adherence summary. `compliance30` is the authoritative 'last 30 days, taken vs expected' read — clients should display `rate` and use `totalExpected` as the denominator rather than re-deriving it from the daily map.",
  });

const dailyComplianceEntry = z
  .object({
    expected: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Engine-computed due-slot count for the day. Equals `expectedCount`; kept for existing consumers.",
      ),
    expectedCount: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "True due-slot count for the day (additive field clients key off so they don't infer due-ness from `expected`).",
      ),
    due: z
      .boolean()
      .describe(
        "`expectedCount > 0`. Paint a per-day glyph as expected/missed ONLY when `due === true`; off-cadence / pre-creation / PRN days are not misses.",
      ),
    taken: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    onTime: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Doses taken in the on-time band, including the `early` bucket (early counts as compliant).",
      ),
    late: z.number().int().nonnegative(),
    veryLate: z.number().int().nonnegative(),
    early: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "Doses taken before the on-time band's grace start; already folded into `onTime`, surfaced separately for consumers that differentiate.",
      ),
  })
  .meta({
    id: "DailyComplianceEntry",
    description:
      "Per-day compliance cell with the timing breakdown that drives the history glyph track.",
  });

const complianceDisplay = z
  .object({
    shortDays: z.number().int().positive(),
    longDays: z.number().int().positive(),
    expectedShort: z.number().int().nonnegative(),
    expectedLong: z.number().int().nonnegative(),
    minStableDoses: z.number().int().nonnegative(),
    short: z.object({
      rate: z.number().int().min(0).max(100),
      taken: z.number().int().nonnegative(),
      expected: z
        .number()
        .int()
        .nonnegative()
        .describe(
          "v1.15.9 rate denominator over the short window (`taken + missed`); user skips are excluded. Render `taken / expected · rate%`.",
        ),
      missed: z
        .number()
        .int()
        .nonnegative()
        .describe(
          "v1.15.9 doses counted against the rate over the short window — includes forgotten doses the auto-miss cron flipped.",
        ),
      streak: z.number().int().nonnegative(),
    }),
    long: z.object({
      rate: z.number().int().min(0).max(100),
      taken: z.number().int().nonnegative(),
      expected: z
        .number()
        .int()
        .nonnegative()
        .describe(
          "v1.15.9 rate denominator over the long window (`taken + missed`).",
        ),
      missed: z
        .number()
        .int()
        .nonnegative()
        .describe(
          "v1.15.9 doses counted against the rate over the long window.",
        ),
    }),
    currentCycle: z
      .object({
        state: z
          .enum(["on_track", "due", "missed", "none"])
          .describe(
            "Open-cycle state, decoupled from the percentage rows: `on_track` = next dose not yet due; `due` = due now / in grace; `missed` = past grace with no logged intake (the only red state); `none` = no projected next dose (PRN / paused / ended).",
          ),
        nextDueAt: z.iso
          .datetime({ offset: true })
          .nullable()
          .describe(
            "The open cycle's due instant. Null when `state` is `none`.",
          ),
        graceUntil: z.iso
          .datetime({ offset: true })
          .nullable()
          .describe(
            "End of the due slot's grace window. Null when `state` is `none`.",
          ),
        hasClosedCycles: z
          .boolean()
          .describe(
            "False for a brand-new sparse med with zero closed dose cycles — the percentage rows are vacuous and the card should show a neutral 'not enough data yet' state.",
          ),
      })
      .describe(
        "v1.13.x — the current (open) dose cycle, surfaced so a between-doses sparse med renders a neutral 'next dose in N days' line instead of a scary red 0%. The percentage rows above already exclude the open forward cycle from their denominator.",
      ),
    currentDose: z
      .object({
        status: z
          .enum([
            "upcoming",
            "on_time_window",
            "overdue",
            "missed",
            "taken_on_time",
            "taken_late",
            "skipped",
          ])
          .describe(
            "Per-dose state of the open cycle, server-derived from the window model so the card renders the take-window (green) / overdue / heavily-overdue escalation from one authority. `upcoming` when no dose is open (PRN / paused / ended).",
          ),
        targetAt: z.iso
          .datetime({ offset: true })
          .nullable()
          .describe(
            "Target instant of the open dose. Null when no dose is open.",
          ),
      })
      .describe(
        "v1.15.9 — the open dose's per-dose status + target, so the card highlights the actionable take-window green and escalates an overdue dose without re-deriving the window math client-side.",
      ),
  })
  .meta({
    id: "ComplianceDisplay",
    description:
      "The two-row card block whose windows scale with dosing cadence (dense meds keep 7 / 30 days, sparse meds step both windows up). NOT the 30-day denominator — read `compliance30.totalExpected` for that.",
  });

const medicationComplianceResponse = z
  .object({
    compliance7: complianceResult,
    compliance30: complianceResult,
    dailyCompliance: z
      .record(z.string(), dailyComplianceEntry)
      .describe(
        "Flat per-day map keyed `YYYY-MM-DD` in the user timezone, one entry per day for up to 90 days back, clamped to the medication's `createdAt` (so a recently-created med has fewer entries). No weekly/monthly collapse — this is the raw daily grid.",
      ),
    complianceDisplay,
  })
  .meta({
    id: "MedicationComplianceResponse",
    description:
      "Adherence read for a single medication. `compliance30` is the authoritative 30-day taken-vs-expected summary; `dailyCompliance` is the per-day grid for the history glyph track. The graded raw→week→month→year series used elsewhere for AI prompts does NOT apply here — this response is never downsampled.",
  });

const medicationComplianceSummaryEntry = z
  .object({
    medicationId: z.string(),
    compliance7: complianceResult,
    compliance30: complianceResult,
    complianceDisplay,
  })
  .meta({
    id: "MedicationComplianceSummaryEntry",
    description:
      "Compact per-medication adherence row for the batched card read: the 7-/30-day summaries plus the cadence-scaled display block. The per-day `dailyCompliance` grid is NOT on this shape — read the per-medication `/compliance` endpoint for the history glyph track.",
  });

// v1.16.5 — schedule-era management (the Zeitplan-tab history timeline).
// Archived eras come from two provenances: the wholesale-replace write
// path (`ARCHIVED`, immutable) and the user-entered pre-tracking flow
// (`MANUAL`, deletable through the `[revisionId]` DELETE).
const scheduleRevisionEntrySummary = z
  .object({
    timesOfDay: z
      .array(z.string())
      .describe("Daily dose times (HH:mm, user local) the era ran at."),
    label: z.string().nullable(),
    dose: z.string().nullable(),
    scheduleType: z
      .string()
      .describe("Schedule-type discriminator of the archived row (SCHEDULED / PRN / CYCLIC)."),
  })
  .meta({
    id: "ScheduleRevisionEntry",
    description:
      "Display summary of one archived schedule row inside an era. The full snapshot (windows, rrule, doseWindows, …) stays server-side; this projection carries what the timeline renders.",
  });

const scheduleRevisionResource = z
  .object({
    id: z.string(),
    validFrom: z.iso
      .datetime()
      .describe("Inclusive start instant of the era."),
    validUntil: z.iso
      .datetime()
      .describe("Exclusive end instant of the era — the moment the next plan took over."),
    source: z
      .enum(["ARCHIVED", "MANUAL"])
      .describe(
        "Provenance. ARCHIVED = minted by the schedule-replace write path (immutable). MANUAL = user-entered pre-tracking era (deletable).",
      ),
    entries: z.array(scheduleRevisionEntrySummary),
  })
  .meta({
    id: "MedicationScheduleRevision",
    description:
      "One archived schedule era covering `[validFrom, validUntil)`. The dose-history ledger, compliance tallies, and cadence chips mint past days against the era that was live then.",
  });

const scheduleRevisionListResponse = z.object({
  currentSince: z.iso
    .datetime()
    .describe(
      "Instant the LIVE plan took over: the newest revision's `validUntil`, or the medication's `createdAt` when no era has been archived.",
    ),
  revisions: z
    .array(scheduleRevisionResource)
    .describe("Archived eras, newest first."),
});

// v1.5.0 — natural-language medication extraction route. The wizard's
// optional "Beschreiben" overlay POSTs a free-text description and
// receives a partial structured payload the form merges onto whatever
// the user already typed. Citation-guarded (`name` and `dose` are
// dropped when not substring-matched in the original text) and
// closed-enum-validated.
const medicationExtractRequest = z
  .object({
    text: z
      .string()
      .min(1)
      .max(2000)
      .describe(
        "Free-text medication description (any locale). Up to 2 000 characters. The model never echoes the text back into another tenant — it is only used to produce the structured fields.",
      ),
    locale: z
      .enum(["en", "de", "es", "fr", "it", "pl"])
      .optional()
      .describe("Optional UI locale hint for the model."),
    today: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe(
        'Optional override of the reference date used to resolve relative phrases ("tomorrow", "next Monday"). Format: `YYYY-MM-DD`. Defaults to the server\'s UTC day.',
      ),
  })
  .meta({
    id: "MedicationExtractRequest",
    description:
      "Free-text medication description payload. The route runs the text through the Coach provider chain and returns a partial structured payload the wizard merges. Rate-limited 10 requests / 5 minutes / user; budget-gated against the daily Coach token ceiling.",
  });

medicationExtractionSchema.meta({
  id: "MedicationExtractionResult",
  description:
    "Citation-guarded partial extraction of medication scheduling fields. Every field is optional; the wizard merges what is present onto the form state and leaves the rest blank. `name` and `dose` are post-validated against the original free-text and dropped when not substring-matched, so the wizard cannot silently land a hallucinated brand or dose. `cadenceKind` / `doseUnit` / `weekdays` are closed enums; numeric fields are clamped to the wizard's wire bounds.",
});

// v1.16.10 — medications list presentation (cards/table view + manual
// order), persisted per user in its own `User` column following the
// dashboard-widgets / insights-layout per-surface convention.
const medicationListLayoutSchema = z
  .object({
    version: z.literal(1),
    view: z
      .enum(MEDICATION_LIST_VIEWS)
      .optional()
      .describe(
        'Which presentation /medications renders in. Default "cards". Optional on PUT — when omitted the stored value is preserved (preserve-when-absent, like `heroVisible` on the dashboard layout). Always present on responses.',
      ),
    order: z
      .array(z.string().min(1).max(MEDICATION_ORDER_ID_MAX_LENGTH))
      .max(MEDICATION_ORDER_MAX_ENTRIES)
      .optional()
      .describe(
        "User-defined manual medication order (medication ids, first = top), shared by both views. Display-only — unknown / deleted ids are ignored at render time, never 422. Optional on PUT (preserve-when-absent); always present on responses.",
      ),
  })
  .meta({
    id: "MedicationListLayout",
    description:
      "Per-user /medications presentation: the card/table view choice plus the manual medication order shared by both views. Mirrors the dashboard-widgets / insights-layout contract.",
  });

export const medicationPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/medications": {
    get: {
      tags: ["Medications"],
      summary: "List medications for the calling user",
      description:
        "Returns every medication owned by the caller (active + paused), ordered by `createdAt DESC`. Each row carries its nested `schedules`, the joined clinical `category`, the latest non-skipped `lastTakenAt`, and the count of today's actioned intake events (`todayEventCount`). The response is cached server-side for 60 s per user; writes flush the cache.",
      responses: {
        "200": {
          description: "Medication list.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.array(medicationListEntry),
                "ListMedicationsResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    post: {
      tags: ["Medications"],
      summary: "Create a medication with at least one schedule",
      description:
        "Validates the body against `CreateMedicationRequest`, applies the v1.5 cross-field invariants (one-shot consistency, recurring default `FREQ=DAILY`, `timesOfDay` dual-write), and creates the medication + its schedules in a single Prisma write. Audits as `medication.create`.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: createMedicationSchema } },
      },
      responses: {
        "201": {
          description: "Created medication with its schedules.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationDetailEntry,
                "CreateMedicationResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/medications/layout": {
    get: {
      tags: ["Medications"],
      summary: "Read the calling user's medications list presentation",
      description:
        "Returns the per-user /medications presentation (card/table view + manual order). Falls back to the defaults (cards, empty order) when the user has not customised it. Mirrors the insights-layout contract.",
      responses: {
        "200": {
          description: "The resolved presentation (custom or default).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationListLayoutSchema,
                "MedicationListLayoutResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    put: {
      tags: ["Medications"],
      summary: "Update the calling user's medications list presentation",
      description:
        "Field-scoped update: `view` and `order` are each optional, and whichever the body omits is preserved from the stored blob — a view toggle can never wipe the manual order and vice versa. The normalised presentation is returned. Invalid bodies return the multi-issue 422 envelope.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: medicationListLayoutSchema },
        },
      },
      responses: {
        "200": {
          description:
            "Presentation saved; the normalised blob is echoed back.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationListLayoutSchema,
                "MedicationListLayoutSaved",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Medications"],
      summary: "Reset the calling user's medications list presentation",
      description:
        "Clears the persisted presentation and returns the defaults (cards, empty order). Idempotent.",
      responses: {
        "200": {
          description: "Presentation reset; the defaults are returned.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationListLayoutSchema,
                "MedicationListLayoutReset",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/medications/{id}": {
    get: {
      tags: ["Medications"],
      summary: "Fetch a single medication",
      description:
        "Returns the medication + its schedules + the joined `category`. Cross-user rows surface as 404 (existence channel sealed).",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      responses: {
        "200": {
          description: "Medication detail.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationDetailEntry,
                "GetMedicationResponse",
              ),
            },
          },
        },
        "404": {
          description: "Medication not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
    put: {
      tags: ["Medications"],
      summary: "Replace a medication (partial fields)",
      description:
        "Every field on the body is optional; omitted fields are left untouched. Supplying `schedules` REPLACES the medication's full schedule list (the route deletes existing rows before re-creating). Flipping `active` to false stamps `pausedAt`; flipping back to true clears it. v1.5 invariants on the `schedules` array match `POST /api/medications`. Audits as `medication.update`.",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      requestBody: {
        required: true,
        content: { "application/json": { schema: updateMedicationSchema } },
      },
      responses: {
        "200": {
          description: "Updated medication.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationDetailEntry,
                "UpdateMedicationResponse",
              ),
            },
          },
        },
        "404": {
          description: "Medication not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Medications"],
      summary: "Delete a medication",
      description:
        "Cascades to the medication's schedules, intake events, dose changes, inventory rows, and side-effect logs. Revokes every API token scoped to `medication:<id>:ingest`. Audits as `medication.delete`.",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      responses: {
        "200": {
          description: "Deletion succeeded.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ deleted: z.boolean() }),
                "DeleteMedicationResponse",
              ),
            },
          },
        },
        "404": {
          description: "Medication not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/medications/{id}/intake": {
    post: {
      tags: ["Medications"],
      summary: "Log an intake event for a medication",
      description:
        "Records a taken or skipped dose. Idempotent via the `Idempotency-Key` header AND the optional `idempotencyKey` body field (the route walks both paths); a re-post inside the 60 s server-side dedup window returns the original event. Non-skipped intakes auto-decrement pen inventory (best-effort), refresh the per-day compliance rollup, and — for `oneShot:true` medications — flip `active` to false.",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      requestBody: {
        required: true,
        content: { "application/json": { schema: intakeSchema } },
      },
      responses: {
        "201": {
          description: "Intake event created.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationIntakeEventResource,
                "CreateMedicationIntakeResponse",
              ),
            },
          },
        },
        "200": {
          description:
            "Idempotent replay — the original event is returned without creating a new row.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationIntakeEventResource,
                "ReplayMedicationIntakeResponse",
              ),
            },
          },
        },
        "404": {
          description: "Medication not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/medications/{id}/inventory": {
    get: {
      tags: ["Medications"],
      summary: "List a medication's supply containers",
      description:
        "Returns every inventory item (all states) for the medication, ordered by state, then `expiresAt`, then `createdAt`. Items count UNITS; divide by the medication's `unitsPerDose` for dose-level figures.",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      responses: {
        "200": {
          description: "Inventory item list.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({
                  items: z.array(medicationInventoryItemResource),
                  meta: z.object({ total: z.number().int().nonnegative() }),
                }),
                "ListMedicationInventoryResponse",
              ),
            },
          },
        },
        "404": {
          description: "Medication not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
    post: {
      tags: ["Medications"],
      summary: "Register a new supply container",
      description:
        "Creates an ACTIVE inventory item with `unitsRemaining = unitsTotal`. The request's `unitsTotal` field carries UNITS (1–1000). Rate-limited 30/min/user. Audits as `medication.inventory.create`.",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: createInventoryItemSchema },
        },
      },
      responses: {
        "201": {
          description: "Created inventory item.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationInventoryItemResource,
                "CreateMedicationInventoryItemResponse",
              ),
            },
          },
        },
        "404": {
          description: "Medication not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/medications/{id}/inventory/{itemId}": {
    patch: {
      tags: ["Medications"],
      summary: "Mutate a supply container",
      description:
        "Per-item operations: manual first-use (`markAsFirstUseAt`), used-up override (`markAsUsedUp`), printed-expiry correction, absolute remaining-unit correction (`unitsRemaining`, clamped to the item's capacity), notes. The canonical state machine re-derives the state after every mutation. Audits as `medication.inventory.update`.",
      requestParams: {
        path: z.object({ id: z.string(), itemId: z.string() }),
      },
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: updateInventoryItemSchema },
        },
      },
      responses: {
        "200": {
          description: "Updated inventory item.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationInventoryItemResource,
                "UpdateMedicationInventoryItemResponse",
              ),
            },
          },
        },
        "404": {
          description:
            "Inventory item not found (or owned by another user / medication).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Medications"],
      summary: "Delete a supply container",
      description:
        "Hard-deletes the inventory item. The audit log captures the before-state (`medication.inventory.delete`) so a row can be reconstructed if needed. Consumption stamps on intake events that reference the item stay in place; a later restore skips the missing container.",
      requestParams: {
        path: z.object({ id: z.string(), itemId: z.string() }),
      },
      responses: {
        "200": {
          description: "Deletion succeeded.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ id: z.string(), deleted: z.boolean() }),
                "DeleteMedicationInventoryItemResponse",
              ),
            },
          },
        },
        "404": {
          description:
            "Inventory item not found (or owned by another user / medication).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/medications/extract": {
    post: {
      tags: ["Medications"],
      summary:
        "Extract scheduling fields from a free-text medication description",
      description:
        "Runs the user's free-text description through the Coach provider chain and returns a citation-guarded partial payload the wizard merges onto whatever the user already typed. `name` and `dose` are dropped when not substring-matched in the original text so the wizard cannot land a hallucinated brand or dose. `cadenceKind` / `doseUnit` / `weekdays` are closed enums; numeric fields are clamped. Rate-limited 10 requests / 5 minutes / user, gated against the daily Coach token budget.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: medicationExtractRequest },
        },
      },
      responses: {
        "200": {
          description: "Citation-guarded partial extraction.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationExtractionSchema,
                "MedicationExtractResponse",
              ),
            },
          },
        },
        "502": {
          description:
            "Upstream provider returned an empty, unparseable, or off-schema reply.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "503": {
          description:
            "No AI provider configured for the calling user (or operator).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/medications/{id}/cadence": {
    get: {
      tags: ["Medications"],
      summary: "Cadence + compliance read for a medication",
      description:
        "Returns the expected-vs-actual dose timeline for the requested window plus the four compliance chip values that drive the detail-page section. Pure computation — no writes. Day boundaries are resolved in the user's IANA timezone so a Tokyo user and a Berlin user see the same chips for the same medication. The `days` query parameter caps at 180.",
      requestParams: {
        path: z.object({ id: z.string() }),
        query: z.object({
          days: z.coerce
            .number()
            .int()
            .min(1)
            .max(180)
            .optional()
            .describe("Window size in days (default 30, max 180)."),
        }),
      },
      responses: {
        "200": {
          description: "Cadence response.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationCadenceResponse,
                "GetMedicationCadenceResponse",
              ),
            },
          },
        },
        "404": {
          description: "Medication not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/medications/compliance": {
    get: {
      tags: ["Medications"],
      summary: "Batched adherence read for every medication of the caller",
      description:
        "Returns one compact adherence row per medication the caller owns (active + paused), ordered by `createdAt DESC` — the single round trip the medication cards consume instead of fanning out one `/api/medications/{id}/compliance` request per card. Each row carries the 7-/30-day summaries and the cadence-scaled display block; the per-day grid stays on the per-medication endpoint. Pure computation — no writes. Served through the same per-medication server cache as the per-id read, so the two endpoints warm each other.",
      responses: {
        "200": {
          description: "One adherence row per medication.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.array(medicationComplianceSummaryEntry),
                "ListMedicationComplianceResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/medications/{id}/compliance": {
    get: {
      tags: ["Medications"],
      summary: "Adherence read for a medication",
      description:
        "Returns the 7- and 30-day adherence summaries, the per-day compliance grid for the history glyph track, and the two-row display block. Pure computation — no writes. Day boundaries are resolved in the user's IANA timezone, and the expected-dose denominator is cadence-aware (RRULE / rolling / one-shot / PRN / cyclic) and clamped to the medication's `createdAt`. Read `compliance30` for the headline 30-day taken-vs-expected percentage; build the per-day glyph track from `dailyCompliance` (draw a cell only where `due === true`).",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      responses: {
        "200": {
          description: "Compliance response.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicationComplianceResponse,
                "GetMedicationComplianceResponse",
              ),
            },
          },
        },
        "404": {
          description: "Medication not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/medications/{id}/schedule-revisions": {
    get: {
      tags: ["Medications"],
      summary: "List a medication's archived schedule eras",
      description:
        "Returns every archived schedule era (newest first) plus `currentSince`, the instant the live plan took over. The dose-history ledger and compliance tallies already mint past days against these eras; this read powers the Zeitplan-tab history timeline.",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      responses: {
        "200": {
          description: "Era list.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                scheduleRevisionListResponse,
                "ListScheduleRevisionsResponse",
              ),
            },
          },
        },
        "404": {
          description: "Medication not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
    post: {
      tags: ["Medications"],
      summary: "Append a manual schedule era (pre-tracking history)",
      description:
        "Records that the medication dosed at the given daily times during `[validFrom, validUntil)` — history from before the schedule was edited in the app. The era must end at or before the start of the live plan and must not overlap an existing era; violations return 422. The snapshot is shaped exactly like a write-path archive (`FREQ=DAILY`, window pulled to the min/max of the times), so every historical surface reads it transparently. Audits as `medication.schedule_revision.created`.",
      requestParams: {
        path: z.object({ id: z.string() }),
      },
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: scheduleRevisionCreateSchema },
        },
      },
      responses: {
        "201": {
          description: "Manual era created.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                scheduleRevisionResource,
                "CreateScheduleRevisionResponse",
              ),
            },
          },
        },
        "404": {
          description: "Medication not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/medications/{id}/schedule-revisions/{revisionId}": {
    patch: {
      tags: ["Medications"],
      summary: "Correct a recorded schedule era",
      description:
        "Replaces an era's bounds and daily times. A `MANUAL` era updates in place; an `ARCHIVED` era stays as the immutable audit record and the correction is minted as a superseding `MANUAL` revision that takes its place in every historical surface (the response carries the correction's id). Validation mirrors the sibling POST: the era must end at or before the start of the live plan and must not overlap another active era; violations return 422. An era that has already been corrected refuses with 409. Audits as `medication.schedule_revision.updated`.",
      requestParams: {
        path: z.object({ id: z.string(), revisionId: z.string() }),
      },
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: scheduleRevisionUpdateSchema },
        },
      },
      responses: {
        "200": {
          description: "Era corrected.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                scheduleRevisionResource,
                "UpdateScheduleRevisionResponse",
              ),
            },
          },
        },
        "404": {
          description:
            "Medication or revision not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "409": {
          description:
            "The revision has already been superseded by a correction.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Medications"],
      summary: "Delete a manually added schedule era",
      description:
        "Removes a `MANUAL` era — one appended through the sibling POST, or a correction minted by PATCH (deleting a correction restores the archived original it superseded). Write-path archives (`source: ARCHIVED`) are immutable history and refuse with 409. Audits as `medication.schedule_revision.deleted`.",
      requestParams: {
        path: z.object({ id: z.string(), revisionId: z.string() }),
      },
      responses: {
        "200": {
          description: "Deletion succeeded.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ deleted: z.boolean() }),
                "DeleteScheduleRevisionResponse",
              ),
            },
          },
        },
        "404": {
          description:
            "Medication or revision not found (or owned by another user).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "409": {
          description:
            "The revision is a write-path archive (`ARCHIVED`) and cannot be deleted.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
};
