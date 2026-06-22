/**
 * v1.20.0 (F1) — Coach DATA INVENTORY manifest.
 *
 * The tiny, always-sent manifest that replaces snapshot-stuffing in the base
 * context. It tells the model WHAT data exists (so it never invents a metric)
 * and WHICH tool to call to fetch it — without shipping the figures themselves.
 *
 * Built deterministically from a single `buildCoachSnapshot` over the user's
 * effective scope: the snapshot already resolves the module / cycle gates and
 * computes presence + counts, so a domain the user opted out of is structurally
 * absent from the manifest (it will report `present: false`). The build is
 * memoised by the 60s snapshot LRU, so the tools that fire on the same turn
 * re-use these reads rather than paying for them twice.
 *
 * Cost: the manifest is ~0.3–0.5k tokens vs the ~6–15k-token snapshot JSON it
 * replaces — the figures move out of the prompt and into on-demand tool results.
 */
import { isCycleAvailableForUser } from "@/lib/cycle/gate";
import { buildCoachSnapshot } from "@/lib/ai/coach/snapshot";
import type { CoachProvenanceMetric, CoachScope } from "@/lib/ai/coach/types";

/** One row of the inventory: a domain + whether the user has data for it. */
export interface InventoryEntry {
  /** The tool that fetches this domain. */
  tool: string;
  /** Stable domain label the model reads (e.g. "blood pressure", "glucose"). */
  domain: string;
  present: boolean;
  /** Sample count, when the snapshot reported one. */
  count?: number;
  /** For get_metric_series rows: the `metric` argument to pass. */
  metric?: string;
}

export interface CoachDataInventory {
  entries: InventoryEntry[];
  /** Illness rest-mode flag, so the safety framing is right before any call. */
  restMode: boolean;
  /** Whether cycle tracking is available (the get_cycle tool is deferred). */
  cycleEnabled: boolean;
  /** The window the inventory was built against. */
  window: string;
}

/**
 * Map a snapshot section key → an inventory row. The per-metric series tool
 * carries the `metric` argument; the dedicated-tool domains name their tool.
 */
const METRIC_SERIES_DOMAINS: Array<{
  sectionKey: string;
  metric: string;
  domain: string;
  provenance: CoachProvenanceMetric;
}> = [
  {
    sectionKey: "bloodPressure",
    metric: "bp",
    domain: "blood pressure",
    provenance: "bp",
  },
  {
    sectionKey: "weight",
    metric: "weight",
    domain: "weight",
    provenance: "weight",
  },
  {
    sectionKey: "pulse",
    metric: "pulse",
    domain: "pulse",
    provenance: "pulse",
  },
  { sectionKey: "mood", metric: "mood", domain: "mood", provenance: "mood" },
  {
    sectionKey: "heartRateVariability",
    metric: "hrv",
    domain: "heart-rate variability",
    provenance: "hrv",
  },
  {
    sectionKey: "restingHeartRate",
    metric: "resting_hr",
    domain: "resting heart rate",
    provenance: "resting_hr",
  },
  {
    sectionKey: "steps",
    metric: "steps",
    domain: "steps",
    provenance: "steps",
  },
  {
    sectionKey: "vo2Max",
    metric: "vo2_max",
    domain: "VO2 max",
    provenance: "vo2_max",
  },
];

export async function buildCoachDataInventory(
  userId: string,
  scope: CoachScope | undefined,
): Promise<CoachDataInventory> {
  const [snapshot, cycleEnabled] = await Promise.all([
    buildCoachSnapshot(userId, scope),
    isCycleAvailableForUser(userId),
  ]);
  const sections = snapshot.sections;
  const counts = snapshot.provenance.counts ?? {};
  const has = (key: string): boolean =>
    sections[key] !== undefined && sections[key] !== null;

  const entries: InventoryEntry[] = [];

  // get_metric_series domains — one row per metric the snapshot surfaced.
  for (const m of METRIC_SERIES_DOMAINS) {
    const present = has(m.sectionKey);
    entries.push({
      tool: "get_metric_series",
      metric: m.metric,
      domain: m.domain,
      present,
      ...(present && typeof counts[m.provenance] === "number"
        ? { count: counts[m.provenance] }
        : {}),
    });
  }

  // Dedicated-tool domains.
  entries.push({
    tool: "get_glucose_panel",
    domain: "glucose",
    present: has("glucose"),
    ...(typeof counts.glucose === "number" ? { count: counts.glucose } : {}),
  });
  entries.push({
    tool: "get_sleep",
    domain: "sleep",
    present: has("sleep") || has("sleepRhythm"),
    ...(typeof counts.sleep === "number" ? { count: counts.sleep } : {}),
  });
  entries.push({
    tool: "get_medication_compliance",
    domain: "medication compliance",
    present: has("compliance") || has("weeklyContext"),
    ...(typeof counts.compliance === "number"
      ? { count: counts.compliance }
      : {}),
  });
  entries.push({
    tool: "get_labs",
    domain: "lab results",
    present: has("labs"),
  });
  entries.push({
    tool: "get_illness_recovery",
    domain: "illness & recovery",
    present:
      has("illness") || has("derived") || has("dayStrain") || has("trajectory"),
  });

  // restMode rides the illness section.
  const illness = sections.illness as { restMode?: boolean } | undefined;
  const restMode = illness?.restMode === true;

  const scopeBlock = sections.scope as { window?: string } | undefined;

  return {
    entries,
    restMode,
    cycleEnabled,
    window: scopeBlock?.window ?? scope?.window ?? "last30days",
  };
}

/**
 * Render the inventory as the compact text block that rides the base context.
 * Brand-free, deterministic, and stable across turns so the prompt-cache prefix
 * stays intact. Each line tells the model the domain, whether data exists, and
 * the tool + argument to call.
 */
export function renderDataInventory(inventory: CoachDataInventory): string {
  const lines: string[] = [];
  lines.push("DATA INVENTORY");
  lines.push(
    "This lists which of the user's data exists and how to fetch it. Call the named tool ONLY for a domain marked present. Never cite a figure you did not fetch with a tool this turn; when a tool returns present:false, say plainly you have no data for it and pivot.",
  );
  lines.push(`Window: ${inventory.window}.`);
  if (inventory.restMode) {
    lines.push(
      "The user is currently in REST MODE (recovering from illness) — frame any activity guidance gently.",
    );
  }
  for (const e of inventory.entries) {
    const arg = e.metric ? ` (metric:"${e.metric}")` : "";
    lines.push(
      `- ${e.domain}: ${e.present ? "present" : "absent"} → ${e.tool}${arg}${
        e.present && typeof e.count === "number" ? ` [~${e.count} samples]` : ""
      }`,
    );
  }
  return lines.join("\n");
}
