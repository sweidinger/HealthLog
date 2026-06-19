/**
 * v1.17.0 — curated mood-tag icon catalog (the shared server/client seam).
 *
 * One module, two consumers:
 *   - the server derives `CUSTOM_TAG_ICON_ALLOWLIST` (custom-tags.ts) from
 *     the `name` column, so an icon a tag or group may store is exactly an
 *     entry of this catalog;
 *   - the client renders the searchable icon picker from the full rows
 *     (keywords are English-only search aids, not i18n keys; the visible
 *     label under each icon is the name itself).
 *
 * Constraints:
 *   - every `name` is a Lucide icon name the iOS client maps to an SF
 *     Symbol (`MoodTagSFSymbol`) — extend the iOS map before extending
 *     this list (see the ios-coord note for the published set);
 *   - the catalog is a strict superset of the pre-v1.17 22-name allowlist
 *     AND of the 44-name client map in `mood-tag-icons.ts`, so every icon
 *     already stored on a row keeps resolving. Never remove a name.
 *
 * No `lucide-react` import here — the server stays icon-library-agnostic
 * (it stores and validates names only).
 */

export type MoodTagIconGroup =
  | "emotions"
  | "activities"
  | "health"
  | "food"
  | "weather"
  | "places"
  | "misc";

export interface MoodTagIconCatalogEntry {
  /** Lucide icon name — the value stored on `mood_tags.icon` / `mood_tag_categories.icon`. */
  name: string;
  /** English search aids for the picker's filter input. */
  keywords: string[];
  /** Picker sub-header bucket. */
  group: MoodTagIconGroup;
}

export const MOOD_TAG_ICON_CATALOG: readonly MoodTagIconCatalogEntry[] = [
  // ── emotions ─────────────────────────────────────────────────────────
  { name: "Smile", keywords: ["happy", "good", "content"], group: "emotions" },
  { name: "Laugh", keywords: ["joy", "fun", "laughter"], group: "emotions" },
  {
    name: "Meh",
    keywords: ["neutral", "okay", "indifferent"],
    group: "emotions",
  },
  { name: "Frown", keywords: ["sad", "down", "unhappy"], group: "emotions" },
  {
    name: "Angry",
    keywords: ["mad", "anger", "frustration"],
    group: "emotions",
  },
  { name: "Heart", keywords: ["love", "romance", "date"], group: "emotions" },
  {
    name: "HandHeart",
    keywords: ["kindness", "gratitude", "care"],
    group: "emotions",
  },
  {
    name: "PartyPopper",
    keywords: ["party", "celebration", "birthday"],
    group: "emotions",
  },
  { name: "ThumbsUp", keywords: ["good", "win", "approve"], group: "emotions" },
  {
    name: "CheckCircle",
    keywords: ["done", "achievement", "complete"],
    group: "emotions",
  },
  {
    name: "AlertTriangle",
    keywords: ["stress", "warning", "alert"],
    group: "emotions",
  },
  {
    name: "HelpCircle",
    keywords: ["uncertainty", "confusion", "question"],
    group: "emotions",
  },
  {
    name: "Swords",
    keywords: ["conflict", "argument", "fight"],
    group: "emotions",
  },
  {
    name: "Flame",
    keywords: ["energy", "motivation", "streak"],
    group: "emotions",
  },
  { name: "Zap", keywords: ["energy", "electric", "boost"], group: "emotions" },
  {
    name: "Star",
    keywords: ["favorite", "special", "highlight"],
    group: "emotions",
  },
  {
    name: "Gift",
    keywords: ["present", "surprise", "birthday"],
    group: "emotions",
  },

  // ── activities ───────────────────────────────────────────────────────
  {
    name: "Dumbbell",
    keywords: ["gym", "workout", "strength"],
    group: "activities",
  },
  {
    name: "Activity",
    keywords: ["exercise", "pulse", "movement"],
    group: "activities",
  },
  {
    name: "Footprints",
    keywords: ["walk", "steps", "stroll"],
    group: "activities",
  },
  {
    name: "Bike",
    keywords: ["cycling", "bicycle", "ride"],
    group: "activities",
  },
  {
    name: "Music",
    keywords: ["concert", "song", "instrument"],
    group: "activities",
  },
  {
    name: "Headphones",
    keywords: ["podcast", "listening", "audio"],
    group: "activities",
  },
  {
    name: "Gamepad2",
    keywords: ["gaming", "videogame", "play"],
    group: "activities",
  },
  {
    name: "Film",
    keywords: ["movie", "cinema", "series"],
    group: "activities",
  },
  {
    name: "BookOpen",
    keywords: ["reading", "book", "novel"],
    group: "activities",
  },
  {
    name: "Book",
    keywords: ["journal", "study", "diary"],
    group: "activities",
  },
  {
    name: "Briefcase",
    keywords: ["work", "office", "job"],
    group: "activities",
  },
  {
    name: "GraduationCap",
    keywords: ["school", "study", "learning"],
    group: "activities",
  },
  {
    name: "Palette",
    keywords: ["art", "creative", "painting"],
    group: "activities",
  },
  {
    name: "Camera",
    keywords: ["photo", "photography", "picture"],
    group: "activities",
  },
  {
    name: "Trees",
    keywords: ["nature", "outdoors", "forest"],
    group: "activities",
  },
  {
    name: "Mountain",
    keywords: ["hike", "climbing", "summit"],
    group: "activities",
  },
  {
    name: "Plane",
    keywords: ["travel", "flight", "vacation"],
    group: "activities",
  },
  { name: "Car", keywords: ["drive", "commute", "road"], group: "activities" },
  {
    name: "ShoppingCart",
    keywords: ["shopping", "groceries", "errands"],
    group: "activities",
  },
  {
    name: "Phone",
    keywords: ["call", "telephone", "contact"],
    group: "activities",
  },
  {
    name: "Users",
    keywords: ["friends", "social", "family"],
    group: "activities",
  },
  { name: "User", keywords: ["alone", "solo", "me"], group: "activities" },
  {
    name: "LogOut",
    keywords: ["out", "leave", "going out"],
    group: "activities",
  },
  {
    name: "Banknote",
    keywords: ["money", "finance", "spending"],
    group: "activities",
  },
  {
    name: "Clock",
    keywords: ["time", "late", "schedule"],
    group: "activities",
  },
  {
    name: "SlidersHorizontal",
    keywords: ["adjust", "factor", "balance"],
    group: "activities",
  },

  // ── health ───────────────────────────────────────────────────────────
  {
    name: "Pill",
    keywords: ["medication", "medicine", "dose"],
    group: "health",
  },
  {
    name: "Stethoscope",
    keywords: ["doctor", "appointment", "checkup"],
    group: "health",
  },
  {
    name: "Syringe",
    keywords: ["injection", "vaccine", "shot"],
    group: "health",
  },
  {
    name: "Thermometer",
    keywords: ["fever", "sick", "temperature"],
    group: "health",
  },
  {
    name: "HeartPulse",
    keywords: ["heart rate", "cardio", "pulse"],
    group: "health",
  },
  { name: "Brain", keywords: ["mental", "focus", "therapy"], group: "health" },
  { name: "Bath", keywords: ["bath", "relax", "selfcare"], group: "health" },
  { name: "Bed", keywords: ["rest", "nap", "lie down"], group: "health" },
  {
    name: "BedDouble",
    keywords: ["sleep", "bedtime", "night"],
    group: "health",
  },
  { name: "Moon", keywords: ["night", "sleep", "dark"], group: "health" },
  {
    name: "MoonStar",
    keywords: ["deep sleep", "night", "dream"],
    group: "health",
  },
  {
    name: "Cigarette",
    keywords: ["smoking", "tobacco", "nicotine"],
    group: "health",
  },
  {
    name: "CigaretteOff",
    keywords: ["no smoking", "quit", "smoke-free"],
    group: "health",
  },
  { name: "Baby", keywords: ["baby", "kids", "parenting"], group: "health" },

  // ── food ─────────────────────────────────────────────────────────────
  { name: "Apple", keywords: ["fruit", "healthy", "snack"], group: "food" },
  { name: "Pizza", keywords: ["fastfood", "junk", "takeout"], group: "food" },
  {
    name: "UtensilsCrossed",
    keywords: ["meal", "dinner", "restaurant"],
    group: "food",
  },
  {
    name: "Coffee",
    keywords: ["caffeine", "espresso", "morning"],
    group: "food",
  },
  { name: "Wine", keywords: ["alcohol", "drinks", "glass"], group: "food" },
  {
    name: "GlassWater",
    keywords: ["water", "hydration", "drink"],
    group: "food",
  },
  { name: "CandyOff", keywords: ["no sugar", "diet", "sweets"], group: "food" },

  // ── weather ──────────────────────────────────────────────────────────
  { name: "Sun", keywords: ["sunny", "warm", "bright"], group: "weather" },
  {
    name: "CloudSun",
    keywords: ["partly cloudy", "mild", "mixed"],
    group: "weather",
  },
  { name: "Cloud", keywords: ["overcast", "grey", "cloudy"], group: "weather" },
  { name: "CloudRain", keywords: ["rain", "wet", "storm"], group: "weather" },
  {
    name: "CloudMoon",
    keywords: ["clear night", "evening", "dusk"],
    group: "weather",
  },
  { name: "Leaf", keywords: ["autumn", "plant", "season"], group: "weather" },

  // ── places ───────────────────────────────────────────────────────────
  { name: "House", keywords: ["home", "house", "indoors"], group: "places" },
  { name: "Home", keywords: ["home", "house", "indoors"], group: "places" },

  // ── misc ─────────────────────────────────────────────────────────────
  { name: "Tag", keywords: ["default", "generic", "label"], group: "misc" },
  { name: "Cat", keywords: ["cat", "pet", "animal"], group: "misc" },
  { name: "Dog", keywords: ["dog", "pet", "animal"], group: "misc" },
] as const;

/** Flat name list — the server-side allowlist source. */
export const MOOD_TAG_ICON_NAMES: readonly string[] = MOOD_TAG_ICON_CATALOG.map(
  (entry) => entry.name,
);
