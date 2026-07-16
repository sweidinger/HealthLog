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
export const COACH_CHECKIN_REVIEW_DAYS = 7;

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
export const COACH_CHECKIN_KEEP_INTENT = "coach.checkin.keep";
export const COACH_CHECKIN_LETGO_INTENT = "coach.checkin.letGo";
export const COACH_CHECKIN_ADJUST_INTENT = "coach.checkin.adjust";

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
  syncIssues: DailyDigestSyncIssue[];
  preventiveDue: DailyDigestPreventiveDue[];
  /** Standing coach plans (active + reviewed) — check-in candidates (§2.3). */
  coachPlans: DailyDigestCoachPlan[];
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
  const sleepEnabled = moduleEnabled(input.modules, "sleep");
  const sleepPending =
    sleepEnabled &&
    (input.sleepLastSeenDaysAgo === null || input.sleepLastSeenDaysAgo >= 1);
  const phase: DailyDigest["phase"] = sleepPending ? "provisional" : "final";

  const topSignal = input.briefing?.signalsOfDay?.[0] ?? null;
  const briefingLead = firstSentence(input.briefing?.paragraph);

  // Priority order: an overdue dose is the most time-sensitive daily action, a
  // broken sync next, then the calm coach check-in, a preventive check-up
  // least urgent. Bounded to 3 — a check-in the cap crowds out resurfaces on a
  // following day (within its window), never lost.
  const worthALook: PriorityItem[] = [];
  const dose = buildDoseWindowItem(input.medsToday, input.modules, t);
  if (dose) worthALook.push(dose);
  worthALook.push(...buildSyncIssueItems(input.syncIssues, t));
  const checkin = buildCoachCheckinItem(
    input.coachPlans,
    input.modules,
    input.now,
    t,
  );
  if (checkin) worthALook.push(checkin);
  const preventive = buildPreventiveCareItem(input.preventiveDue, t);
  if (preventive) worthALook.push(preventive);

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
