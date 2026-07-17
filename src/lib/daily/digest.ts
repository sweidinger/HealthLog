/**
 * P3 — `buildDailyDigest`, the ONE data spine of the daily-value system.
 *
 * A pure, deterministic composer that assembles the day's read from data that
 * ALREADY EXISTS — the nightly `insight-pregenerate` output lifted read-only
 * from `User.insightsCachedText`, the dashboard-snapshot ingredients (health
 * score, meds-today, sleep last-seen), plus two light deterministic reads
 * (integration status, due Vorsorge reminders). It computes no analytics and
 * NEVER triggers an AI/provider call — the warm-on-mount ban extends here. The
 * IO that gathers its input lives in `./load-digest.ts`; this module is the
 * tested spine.
 *
 * The emitted `DailyDigest` is the single source of truth every later consumer
 * reads: the Today surface (S2), the daily push line (S5), and a future iOS
 * widget — none recompute, none fork a second digest path.
 *
 * Freshness (§2.4): S1 derives `phase` / `sleepPending` DETERMINISTICALLY from
 * whether last night's sleep is already in the record. The event-driven
 * provisional→final refresh (sleep-arrival debounce) is S4's work; it will
 * populate the same two fields the DTO already carries, so no consumer changes.
 */
import type { DailyBriefing, DailyBriefingSignal } from "@/lib/ai/schema";
import type { MedsTodayBlock } from "@/lib/dashboard/meds-today";
import type { ModuleKey } from "@/lib/modules/registry";
import type { ServerTranslator } from "@/lib/i18n/server-translator";
import {
  MAX_PRIORITY_ACTIONS,
  type PriorityItem,
} from "@/lib/daily/priority-item";
import {
  milestoneCopy,
  milestoneHref,
  type Milestone,
} from "@/lib/daily/milestones";
import {
  COACH_CHECKIN_REVIEW_DAYS,
  COACH_CHECKIN_KEEP_INTENT,
  COACH_CHECKIN_LETGO_INTENT,
  COACH_CHECKIN_ADJUST_INTENT,
} from "@/lib/daily/coach-checkin-intents";

/** At most three rail items — a glance, never a wall (§2.5, never padded). */
export const MAX_WORTH_A_LOOK = 3;

/** Trim a briefing-lead sentence to a lock-screen-friendly length. */
const MAX_LINE_LENGTH = 160;

const MS_PER_DAY = 86_400_000;

/**
 * S3 — coach check-in loop (§2.3). Days added to a plan's activation when the
 * coach set no review date: every accepted plan earns a check-in, not only the
 * ones the coach explicitly dated. The PATCH-to-`active` route defaults
 * `reviewDate` to `+COACH_CHECKIN_REVIEW_DAYS`; this constant is the one source.
 */
// COACH_CHECKIN_REVIEW_DAYS lives in ./coach-checkin-intents (client-safe).

/**
 * After a check-in comes due, it resurfaces for at most this many days before
 * it stops appearing on its own — the calm inversion of a streak (§2.3.3): an
 * ignored check-in sits quiet after ~two cycles rather than nagging forever,
 * and the plan's status is NEVER changed behind the user's back. Only an
 * explicit keep / let-go moves the plan; silence just retires the card.
 */
export const COACH_CHECKIN_RESURFACE_DAYS = 14;

/**
 * Closed allowlist of the check-in card's two MUTATING intents (§2.3.2). The
 * generic, id-less `PriorityCard` forwards only a single `intent` string, so
 * the target plan id is appended after the ":" — the Today handler recovers it
 * and PATCHes the existing plan-lifecycle route. "Adjust" is navigation (an
 * `href` into the coach), so it carries no plan id and never mutates here.
 */
// The check-in intents live in ./coach-checkin-intents (client-safe) and are
// imported above, so the client Today surface can use them without pulling this
// server-side builder into its bundle.

type Translate = ServerTranslator["t"];

/** Module map in the registry's DISABLED-allowlist shape (missing = enabled). */
export type DigestModuleMap = Partial<Record<ModuleKey, boolean>>;

function moduleEnabled(map: DigestModuleMap, key: ModuleKey): boolean {
  return map[key] !== false;
}

export interface DailyDigestScore {
  value: number;
  band: string;
  delta: number | null;
}

/** A broken integration, deterministically derived from `IntegrationStatus`. */
export interface DailyDigestSyncIssue {
  /** Integration token (`withings`, `moodlog`, …). */
  integration: string;
  /** The failure state the row carries (`error_reauth`, `disconnected`, …). */
  state: string;
}

/** A Vorsorge / measurement reminder whose next-due instant has passed. */
export interface DailyDigestPreventiveDue {
  label: string;
}

/**
 * S11 — a confident elevated-at-rest ("tension") window for the day, already
 * detected server-side (`loadIntradayPulse`) under its full confidence gate.
 * The builder only formats it; the signal correctness lives in the analytics
 * layer, and a null here means the honest "no window" — nothing is emitted.
 */
export interface DailyDigestTensionWindow {
  /** Part of day the window's midpoint fell in — drives the cautious copy. */
  partOfDay: "morning" | "afternoon" | "evening" | "night";
}

/**
 * S10 — the latest ECG recording, for the `ecg_new_recording` rail item. Only
 * ever the DEVICE's verdict + when it was recorded — NEVER the waveform (the
 * DTO carries no samples). The builder decides "new" from `recordedAt`; the
 * card attributes any verdict to the recording device.
 */
export interface DailyDigestEcg {
  recordedAt: Date;
  /** The recording device's OWN verdict, or null when unclassified. */
  deviceVerdict: "IRREGULAR" | "NOT_DETECTED" | "INCONCLUSIVE" | null;
}

/**
 * A standing coach plan the IO seam offers as a check-in candidate (§2.3). The
 * builder computes due-ness deterministically from the plain columns — it never
 * needs a fresh AI call, reading only the existing plan lifecycle. `planText`
 * is the plan's own if→then prose (decrypted fault-isolated in the IO seam, or
 * null when its key rotated out) so the card can echo the user's own words.
 */
export interface DailyDigestCoachPlan {
  id: string;
  /** Lifecycle status — only `active` / `reviewed` reach the builder. */
  status: string;
  /** The coach-pinned review checkpoint, or null (then defaulted, see below). */
  reviewDate: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** Decrypted "if cue → then action" prose, or null when undecryptable. */
  planText: string | null;
}

/** The fully-resolved, IO-free input the composer folds into a digest. */
export interface DailyDigestInput {
  now: Date;
  modules: DigestModuleMap;
  score: DailyDigestScore | null;
  /** The cached daily briefing (paragraph + signals-of-day), or null. */
  briefing: DailyBriefing | null;
  medsToday: MedsTodayBlock;
  /** Days since the freshest sleep reading; null when never recorded. */
  sleepLastSeenDaysAgo: number | null;
  /**
   * S4 freshness (§E) — whether the event-driven morning refresh has already
   * run for the user's CURRENT local date. Derived in the IO seam by comparing
   * `User.morningDigestRefreshedOn` against today's local date (profile tz):
   * `true` once last night's sleep arrived AND the sleep-dependent generation
   * was re-run with it. This is the authoritative `final` signal — it flips
   * immediately on the refresh, before the snapshot cache (which feeds
   * `sleepLastSeenDaysAgo`) has expired.
   */
  morningRefreshedToday: boolean;
  syncIssues: DailyDigestSyncIssue[];
  preventiveDue: DailyDigestPreventiveDue[];
  /** Standing coach plans (active + reviewed) — check-in candidates (§2.3). */
  coachPlans: DailyDigestCoachPlan[];
  /**
   * S12 — the single freshly-reached durable milestone for today, or null. The
   * IO seam gathers candidates from the existing streak / personal-record
   * engines and applies the reached-once gate (`selectFreshMilestone`), so the
   * builder only ever sees a milestone worth celebrating today.
   */
  milestone?: Milestone | null;
  /** S11 — the day's detected elevated-at-rest window, or null (honest-absent). */
  tensionWindow: DailyDigestTensionWindow | null;
  /**
   * S10 — the freshest ECG recording (device verdict + recordedAt only), or
   * null. Optional so consumers that predate the ECG weave stay valid; the
   * builder treats a missing value as "no recent recording".
   */
  latestEcg?: DailyDigestEcg | null;
}

export interface DailyDigest {
  generatedAt: string;
  /** §2.4 freshness lifecycle — `final` once last night's sleep is in. */
  phase: "provisional" | "final";
  /** Honest-degradation flag: sleep enabled but last night not yet in. */
  sleepPending: boolean;
  score: DailyDigestScore | null;
  /**
   * The clinical-priority top signal, lifted from the cached briefing's
   * `signalsOfDay[0]`. Typed as the CACHED `DailyBriefingSignal` (not the raw
   * `SignalOfDay`): only the grounded, already-localised projection is
   * persisted — re-deriving the raw signal would mean a fresh measurement
   * fan-out on every read, exactly the warm-on-mount load the plan forbids.
   */
  topSignal: DailyBriefingSignal | null;
  /** First sentence of the cached briefing paragraph, read-only. */
  briefingLead: string | null;
  /** The push / lock-screen line (cached-AI lead with a deterministic floor). */
  line: string;
  /** Bounded 0–3 rail items, never padded. */
  worthALook: PriorityItem[];
}

/** First sentence of a paragraph, trimmed; null when empty. */
function firstSentence(paragraph: string | null | undefined): string | null {
  if (!paragraph) return null;
  const trimmed = paragraph.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^[\s\S]*?[.!?](?:\s|$)/);
  let sentence = (match ? match[0] : trimmed).trim();
  if (sentence.length > MAX_LINE_LENGTH) {
    sentence = `${sentence.slice(0, MAX_LINE_LENGTH - 1).trimEnd()}…`;
  }
  return sentence.length > 0 ? sentence : null;
}

/** Title-case a lowercase integration token for user-facing copy. */
function integrationLabel(token: string): string {
  if (!token) return token;
  return token.charAt(0).toUpperCase() + token.slice(1);
}

/**
 * Dose-window item — fires when an active-medication dose is open and overdue.
 * Gated on the `medications` module; carries a single log-dose action.
 */
function buildDoseWindowItem(
  meds: MedsTodayBlock,
  modules: DigestModuleMap,
  t: Translate,
): PriorityItem | null {
  if (!moduleEnabled(modules, "medications")) return null;
  if (!meds.nextDueOverdue) return null;
  const name = meds.nextDueMedicationName;
  return {
    kind: "dose_window",
    title: t("daily.item.doseWindow.title"),
    body: name
      ? t("daily.item.doseWindow.bodyNamed", { name })
      : t("daily.item.doseWindow.body"),
    status: "warning",
    actions: [
      {
        labelKey: "daily.action.logDose",
        intent: "dose.log",
        href: "/medications",
      },
    ],
    moduleKey: "medications",
  };
}

/** One rail item per broken integration — reconnect to keep data current. */
function buildSyncIssueItems(
  issues: DailyDigestSyncIssue[],
  t: Translate,
): PriorityItem[] {
  return issues.map((issue) => ({
    kind: "sync_issue" as const,
    title: t("daily.item.syncIssue.title"),
    body: t("daily.item.syncIssue.body", {
      integration: integrationLabel(issue.integration),
    }),
    status: "warning" as const,
    actions: [
      {
        labelKey: "daily.action.reconnect",
        intent: "sync.reconnect",
        href: "/settings/integrations",
      },
    ],
  }));
}

/** A single preventive-care item summarising the due Vorsorge reminders. */
function buildPreventiveCareItem(
  due: DailyDigestPreventiveDue[],
  t: Translate,
): PriorityItem | null {
  if (due.length === 0) return null;
  const body =
    due.length === 1
      ? t("daily.item.preventiveCare.body", { label: due[0].label })
      : t("daily.item.preventiveCare.bodyMany", { count: due.length });
  return {
    kind: "preventive_care",
    title: t("daily.item.preventiveCare.title"),
    body,
    status: "info",
    actions: [
      {
        labelKey: "daily.action.viewCheckups",
        intent: "checkup.view",
        href: "/checkups",
      },
    ],
  };
}

/**
 * S12 — the calm reward card. Emits ONE `milestone` PriorityItem when a durable
 * state was reached TODAY (the IO seam already applied the reached-once gate).
 * Gated on the `insights` module — the daily narrative layer that hosts it.
 * Celebratory-but-quiet: `success` status, a single "view" action into the
 * metric's insight, and copy that marks arrival at a state, never a maintained
 * count. Shown the day reached and never again — never a "you broke it" note.
 */
function buildMilestoneItem(
  milestone: Milestone | null | undefined,
  modules: DigestModuleMap,
  t: Translate,
): PriorityItem | null {
  if (!milestone) return null;
  if (!moduleEnabled(modules, "insights")) return null;
  const { title, body } = milestoneCopy(milestone, t);
  return {
    kind: "milestone",
    title,
    body,
    status: "success",
    actions: [
      {
        labelKey: "daily.action.viewMilestone",
        intent: "milestone.view",
        href: milestoneHref(milestone),
      },
    ],
    moduleKey: "insights",
  };
}

/**
 * S11 — the elevated-at-rest ("tension") card. Emitted at most once per day
 * (the window is already the day's single most confident stretch), gated on
 * the `insights` module and on a non-null window (the analytics layer stays
 * silent unless every confidence gate holds). Cautious, non-diagnostic copy:
 * "possible tension", never a clinical stress verdict. The one action deep-
 * links into the pulse insight where the intraday shape is charted.
 */
function buildTensionWindowItem(
  window: DailyDigestTensionWindow | null,
  modules: DigestModuleMap,
  t: Translate,
): PriorityItem | null {
  if (!moduleEnabled(modules, "insights")) return null;
  if (!window) return null;
  return {
    kind: "tension_window",
    title: t("daily.item.tensionWindow.title"),
    body: t(`daily.item.tensionWindow.body.${window.partOfDay}`),
    status: "info",
    actions: [
      {
        labelKey: "daily.action.viewPulse",
        intent: "pulse.view",
        href: "/insights/pulse",
      },
    ],
    moduleKey: "insights",
  };
}

/**
 * The instant a plan's check-in came due (§2.3). A coach-pinned `reviewDate`
 * wins. Otherwise, a `reviewed` plan lost its `reviewDate` to the daily sweep
 * when the read-back fired, so its `updatedAt` (the flip moment) is when the
 * check-in came due. A legacy `active` plan the coach never dated defaults to
 * activation + `COACH_CHECKIN_REVIEW_DAYS` — the same rule the PATCH route now
 * writes forward, applied read-side for plans that predate it.
 */
function checkinDueAt(plan: DailyDigestCoachPlan): number {
  if (plan.reviewDate) return plan.reviewDate.getTime();
  if (plan.status === "reviewed") return plan.updatedAt.getTime();
  return plan.createdAt.getTime() + COACH_CHECKIN_REVIEW_DAYS * MS_PER_DAY;
}

/**
 * A plan is check-in-due when its due instant has passed AND it is still within
 * the resurface window. Past the window the card retires quietly — the plan's
 * status is untouched (never abandoned behind the user's back); a keep re-arms
 * it, a let-go ends it, silence just stops the card.
 */
function isCheckinDue(plan: DailyDigestCoachPlan, now: number): boolean {
  const dueAt = checkinDueAt(plan);
  if (dueAt > now) return false;
  return now - dueAt <= COACH_CHECKIN_RESURFACE_DAYS * MS_PER_DAY;
}

/**
 * The one coach check-in card (§2.3). Gated on the `coach` module. Capped at
 * ONE per day across every plan: the earliest-due check-in wins, the rest wait
 * for a following day. Reads existing plan state only — never a fresh AI call.
 * Three one-tap actions map to the plan lifecycle: keep (re-arm), adjust
 * (navigate into the coach), let go (guilt-free retirement).
 */
function buildCoachCheckinItem(
  plans: DailyDigestCoachPlan[],
  modules: DigestModuleMap,
  now: Date,
  t: Translate,
): PriorityItem | null {
  if (!moduleEnabled(modules, "coach")) return null;
  const nowMs = now.getTime();
  const due = plans
    .filter((p) => isCheckinDue(p, nowMs))
    .sort((a, b) => {
      const byDue = checkinDueAt(a) - checkinDueAt(b);
      if (byDue !== 0) return byDue;
      // Deterministic tie-break so the same day always surfaces the same card.
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  const plan = due[0];
  if (!plan) return null;

  const body = plan.planText
    ? t("daily.item.coachCheckin.bodyPlan", { plan: plan.planText })
    : t("daily.item.coachCheckin.body");

  return {
    kind: "coach_checkin",
    title: t("daily.item.coachCheckin.title"),
    body,
    status: "info",
    actions: [
      {
        labelKey: "daily.action.checkinKeep",
        intent: `${COACH_CHECKIN_KEEP_INTENT}:${plan.id}`,
      },
      {
        labelKey: "daily.action.checkinAdjust",
        intent: COACH_CHECKIN_ADJUST_INTENT,
        href: "/coach",
      },
      {
        labelKey: "daily.action.checkinLetGo",
        intent: `${COACH_CHECKIN_LETGO_INTENT}:${plan.id}`,
      },
    ],
    moduleKey: "coach",
  };
}

/**
 * S10 — how recently an ECG recording must have landed to count as "new" for
 * the rail (§3.5.3). A calendar-day window: a recording synced within the last
 * day surfaces once, then retires on its own (no persisted "seen" marker, no
 * migration). The 24h window is itself the one/day cap — at most one recording
 * is the freshest, and it drops off the rail after a day.
 */
const ECG_NEW_WINDOW_MS = MS_PER_DAY;

/** Device verdict → the calm, device-attributed verdict key for the card body. */
const ECG_VERDICT_KEYS: Record<
  NonNullable<DailyDigestEcg["deviceVerdict"]>,
  string
> = {
  IRREGULAR: "daily.item.ecgNewRecording.verdict.irregular",
  NOT_DETECTED: "daily.item.ecgNewRecording.verdict.notDetected",
  INCONCLUSIVE: "daily.item.ecgNewRecording.verdict.inconclusive",
};

/**
 * The one ECG "new recording" item (§3.5.3). Gated on the `insights` module
 * (the ECG viewer's own gate). Fires ONLY when the freshest recording landed
 * within the last day — a calm "a new ECG recording is ready to view" pointer
 * into the viewer. NON-DIAGNOSTIC: the body echoes ONLY the RECORDING DEVICE's
 * verdict, attributed to the device; HealthLog never interprets the trace (the
 * DTO carries no waveform). The 24h window caps it at one/day and retires it on
 * its own without a persisted seen-marker.
 */
function buildEcgNewRecordingItem(
  ecg: DailyDigestEcg | null | undefined,
  modules: DigestModuleMap,
  now: Date,
  t: Translate,
): PriorityItem | null {
  if (!moduleEnabled(modules, "insights")) return null;
  if (!ecg) return null;
  const age = now.getTime() - ecg.recordedAt.getTime();
  // Skip a future-dated row (clock skew) and anything older than the window.
  if (age < 0 || age > ECG_NEW_WINDOW_MS) return null;

  const verdictKey = ecg.deviceVerdict
    ? ECG_VERDICT_KEYS[ecg.deviceVerdict]
    : null;
  const body = verdictKey
    ? t("daily.item.ecgNewRecording.bodyVerdict", { verdict: t(verdictKey) })
    : t("daily.item.ecgNewRecording.body");

  return {
    kind: "ecg_new_recording",
    title: t("daily.item.ecgNewRecording.title"),
    body,
    status: "info",
    actions: [
      {
        labelKey: "daily.action.viewEcg",
        intent: "ecg.view",
        href: "/insights#ecg",
      },
    ],
    moduleKey: "insights",
  };
}

/**
 * The push / lock-screen line: prefer the warmer cached briefing lead, fall
 * back to the top signal's headline, then a deterministic score floor, then
 * the honest all-clear. NEVER a fresh AI call — every branch reads cache or a
 * deterministic string, so a keyless self-hoster still gets a first-class line.
 */
function composeLine(
  briefingLead: string | null,
  topSignal: DailyBriefingSignal | null,
  score: DailyDigestScore | null,
  t: Translate,
): string {
  if (briefingLead) return briefingLead;
  if (topSignal?.headline) return topSignal.headline.trim();
  if (score) return t("daily.line.score", { score: score.value });
  return t("daily.line.allClear");
}

export function buildDailyDigest(
  input: DailyDigestInput,
  t: Translate,
): DailyDigest {
  // §E freshness lifecycle. The day is `final` once ANY of:
  //   - sleep is disabled (nothing to wait for);
  //   - the event-driven morning refresh has run for today (authoritative,
  //     fast — flips the instant the sleep-arrival job stamps the marker);
  //   - last night's sleep is already visibly in the record (`daysAgo === 0`) —
  //     the eventual-consistency backstop for when the refresh job never ran
  //     (no boss worker / keyless self-hoster) but the snapshot has caught up.
  // Otherwise it stays `provisional`, and `sleepPending` drives the honest
  // "last night's sleep not yet in" note.
  const sleepEnabled = moduleEnabled(input.modules, "sleep");
  const lastNightSleepIn = input.sleepLastSeenDaysAgo === 0;
  const isFinal =
    !sleepEnabled || input.morningRefreshedToday || lastNightSleepIn;
  const sleepPending = sleepEnabled && !isFinal;
  const phase: DailyDigest["phase"] = isFinal ? "final" : "provisional";

  const topSignal = input.briefing?.signalsOfDay?.[0] ?? null;
  const briefingLead = firstSentence(input.briefing?.paragraph);

  // Priority order: an overdue dose is the most time-sensitive daily action, a
  // broken sync next, then the calm coach check-in, a preventive check-up
  // least urgent. Bounded to 3 — a check-in the cap crowds out resurfaces on a
  // following day (within its window), never lost.
  const worthALook: PriorityItem[] = [];
  const dose = buildDoseWindowItem(input.medsToday, input.modules, t);
  if (dose) worthALook.push(dose);
  // A freshly-reached milestone is rare and one-per-day — surface it ahead of
  // the ambient sync / check-in items so the calm reward is not buried, but
  // below an overdue dose (the one genuinely time-critical daily action).
  const milestone = buildMilestoneItem(input.milestone, input.modules, t);
  if (milestone) worthALook.push(milestone);
  worthALook.push(...buildSyncIssueItems(input.syncIssues, t));
  const checkin = buildCoachCheckinItem(
    input.coachPlans,
    input.modules,
    input.now,
    t,
  );
  if (checkin) worthALook.push(checkin);
  const ecg = buildEcgNewRecordingItem(
    input.latestEcg,
    input.modules,
    input.now,
    t,
  );
  if (ecg) worthALook.push(ecg);
  const preventive = buildPreventiveCareItem(input.preventiveDue, t);
  if (preventive) worthALook.push(preventive);
  // S11 — the calm, informational tension marker sits last: it is context, not
  // an action that expires, so a time-sensitive dose / sync / check-in wins the
  // bounded rail ahead of it.
  const tension = buildTensionWindowItem(input.tensionWindow, input.modules, t);
  if (tension) worthALook.push(tension);

  // Defence-in-depth: no card ever exceeds the P1 action cap.
  for (const item of worthALook) {
    item.actions = item.actions.slice(0, MAX_PRIORITY_ACTIONS);
  }

  return {
    generatedAt: input.now.toISOString(),
    phase,
    sleepPending,
    score: input.score,
    topSignal,
    briefingLead,
    line: composeLine(briefingLead, topSignal, input.score, t),
    worthALook: worthALook.slice(0, MAX_WORTH_A_LOOK),
  };
}
