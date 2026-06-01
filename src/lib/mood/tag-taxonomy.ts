/**
 * v1.8.5 — default mood-tag taxonomy.
 *
 * The canonical Category → Tag catalog seeded into `mood_tag_categories`
 * + `mood_tags` by migration `0101_v185_mood_tag_taxonomy`. Modelled on
 * the standalone mood diary's structured taxonomy but keyed on i18n
 * message keys (resolved against all six locales) rather than hard-coded
 * labels, so the catalog renders localised everywhere.
 *
 * The ids are deterministic string literals so the migration seed is
 * idempotent (re-running upserts by `key`) and so the catalog rows are
 * stable across deployments. Keys are stable machine identifiers; the
 * `labelKey` is the i18n key the capture UI + breakdown resolve.
 *
 * This is purely additive next to the legacy flat `MoodEntry.tags` JSON
 * column — the structured taxonomy is a second capture surface, not a
 * replacement.
 */

export interface MoodTagSeed {
  /** Stable machine key, unique across the catalog. */
  key: string;
  /** i18n message key `mood.tag.<key>`. */
  labelKey: string;
  /** Lucide icon name. */
  icon: string;
}

export interface MoodTagCategorySeed {
  key: string;
  /** i18n message key `mood.tagCategory.<key>`. */
  labelKey: string;
  /** Lucide icon name for the category header. */
  icon: string;
  tags: MoodTagSeed[];
}

/**
 * The seeded taxonomy. Order within the arrays is the `sortOrder` used
 * for the catalog rows (category index, tag index within its category).
 */
export const MOOD_TAG_TAXONOMY: MoodTagCategorySeed[] = [
  {
    key: "feelings",
    labelKey: "mood.tagCategory.feelings",
    icon: "Heart",
    tags: [
      { key: "happy", labelKey: "mood.tag.happy", icon: "Smile" },
      { key: "excited", labelKey: "mood.tag.excited", icon: "Zap" },
      { key: "grateful", labelKey: "mood.tag.grateful", icon: "HandHeart" },
      { key: "relaxed", labelKey: "mood.tag.relaxed", icon: "CloudSun" },
      { key: "content", labelKey: "mood.tag.content", icon: "ThumbsUp" },
      { key: "tired", labelKey: "mood.tag.tired", icon: "Moon" },
      { key: "unsure", labelKey: "mood.tag.unsure", icon: "HelpCircle" },
      { key: "bored", labelKey: "mood.tag.bored", icon: "Meh" },
      { key: "tense", labelKey: "mood.tag.tense", icon: "AlertTriangle" },
      { key: "angry", labelKey: "mood.tag.angry", icon: "Flame" },
      { key: "stressed", labelKey: "mood.tag.stressed", icon: "Brain" },
      { key: "sad", labelKey: "mood.tag.sad", icon: "Frown" },
    ],
  },
  {
    key: "sleep",
    labelKey: "mood.tagCategory.sleep",
    icon: "BedDouble",
    tags: [
      { key: "slept_well", labelKey: "mood.tag.sleptWell", icon: "Moon" },
      { key: "slept_ok", labelKey: "mood.tag.sleptOk", icon: "CloudMoon" },
      { key: "slept_poorly", labelKey: "mood.tag.sleptPoorly", icon: "MoonStar" },
      { key: "early_night", labelKey: "mood.tag.earlyNight", icon: "Clock" },
    ],
  },
  {
    key: "health",
    labelKey: "mood.tagCategory.health",
    icon: "HeartPulse",
    tags: [
      { key: "worked_out", labelKey: "mood.tag.workedOut", icon: "Dumbbell" },
      { key: "ate_well", labelKey: "mood.tag.ateWell", icon: "Apple" },
      { key: "hydrated", labelKey: "mood.tag.hydrated", icon: "GlassWater" },
      { key: "walked", labelKey: "mood.tag.walked", icon: "Footprints" },
      { key: "alcohol", labelKey: "mood.tag.alcohol", icon: "Wine" },
    ],
  },
  {
    key: "social",
    labelKey: "mood.tagCategory.social",
    icon: "Users",
    tags: [
      { key: "family", labelKey: "mood.tag.family", icon: "Home" },
      { key: "friends", labelKey: "mood.tag.friends", icon: "Users" },
      { key: "party", labelKey: "mood.tag.party", icon: "PartyPopper" },
      { key: "alone", labelKey: "mood.tag.alone", icon: "User" },
    ],
  },
  {
    key: "work",
    labelKey: "mood.tagCategory.work",
    icon: "Briefcase",
    tags: [
      { key: "productive", labelKey: "mood.tag.productive", icon: "CheckCircle" },
      { key: "overtime", labelKey: "mood.tag.overtime", icon: "Clock" },
      { key: "day_off", labelKey: "mood.tag.dayOff", icon: "LogOut" },
      { key: "travel", labelKey: "mood.tag.travel", icon: "Plane" },
      { key: "sick_day", labelKey: "mood.tag.sickDay", icon: "Thermometer" },
    ],
  },
];

/** Flat list of every seeded tag key (for validation / lookups). */
export const MOOD_TAG_KEYS: string[] = MOOD_TAG_TAXONOMY.flatMap((c) =>
  c.tags.map((tagSeed) => tagSeed.key),
);
