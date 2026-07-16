/**
 * P1 — `PriorityItem`, the ONE typed model behind every "worth a look" item.
 *
 * A `PriorityItem` is the single rendering unit for every rail entry the
 * unified daily-value system produces: a coach check-in, a dose-window CTA, a
 * Vorsorge nudge, a failed-sync retry, a durable milestone, a new-ECG pointer,
 * and an elevated-at-rest tension window. Later slices (Today rail S2, coach
 * check-in S3, ECG weave S10, milestones S12, tension S11) each add ONE `kind`
 * plus a server-side item builder — never a new component. `PriorityCard`
 * renders it; `buildDailyDigest` emits it.
 *
 * The type is deliberately WIRE-SERIALISABLE: the digest DTO crosses the
 * `GET /api/daily/digest` boundary (and, later, a native-client / iOS-widget
 * boundary), so an item carries no React component. The card derives its
 * Lucide glyph deterministically from `kind` (see `KIND_ICON` in
 * `src/components/daily/priority-card.tsx`) — the icon lives with the
 * renderer, the closed `kind` enum with the model. This is the one intentional
 * departure from the Fable §1.2 code block (which sketched `icon: LucideIcon`
 * inline); a serialisable single-source-of-truth DTO cannot hold a component.
 */
import type { ModuleKey } from "@/lib/modules/registry";

/**
 * Closed set of rail-item kinds. It GROWS BY PR — a new rail item type is a new
 * entry here + a new server builder, nothing else. S1 ships builders for
 * `dose_window`, `preventive_care`, and `sync_issue`; the remaining kinds are
 * reserved for the slices that own them (coach check-in S3, milestone S12,
 * new-ECG S10, tension window S11) so their consumers can already type against
 * the union.
 */
export const PRIORITY_ITEM_KINDS = [
  "coach_checkin",
  "dose_window",
  "preventive_care",
  "sync_issue",
  "milestone",
  "ecg_new_recording",
  "tension_window",
] as const;

export type PriorityItemKind = (typeof PRIORITY_ITEM_KINDS)[number];

/**
 * Semantic status — meaning, not decoration. Maps to a `text-<status>` plus a
 * `bg-<status>/10` wash in the card (§3 status-colour tier), never raw palette.
 */
export type PriorityItemStatus = "success" | "warning" | "info" | "destructive";

/**
 * One of the 1–3 one-tap actions a card offers. `labelKey` is an i18n key
 * resolved CLIENT-side (the card owns the user's locale); `intent` is a stable
 * token the consumer switches on to wire the tap; `href` deep-links when the
 * action is pure navigation.
 */
export interface PriorityItemAction {
  /** i18n key under `daily.action.*`, resolved by `PriorityCard`. */
  labelKey: string;
  /** Stable action token (`dose.log`, `sync.reconnect`, …). */
  intent: string;
  /** Deep-link target when the action is navigation. */
  href?: string;
}

/**
 * The one model every rail consumer reuses. `title` and `body` are already
 * localised server-side (the builder resolves them through the server
 * translator); action labels stay as keys for the client.
 */
export interface PriorityItem {
  kind: PriorityItemKind;
  /** i18n-resolved headline (server-side). */
  title: string;
  /** Optional grounded one-liner — a plain string rendered via `ProseBlocks`. */
  body?: string;
  /** Semantic status wash; omitted for a neutral card. */
  status?: PriorityItemStatus;
  /** 1–3 one-tap actions. Never zero on a live rail item, never more than 3. */
  actions: PriorityItemAction[];
  /** Provenance of the gate that admitted the item, when module-scoped. */
  moduleKey?: ModuleKey;
}

/** Hard cap on one-tap actions per card (P1 anatomy). */
export const MAX_PRIORITY_ACTIONS = 3;
