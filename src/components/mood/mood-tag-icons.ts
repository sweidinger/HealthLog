import {
  Activity,
  AlertTriangle,
  Angry,
  Apple,
  Baby,
  Banknote,
  Bath,
  Bed,
  BedDouble,
  Bike,
  Book,
  BookOpen,
  Brain,
  Briefcase,
  Camera,
  CandyOff,
  Car,
  Cat,
  CheckCircle,
  Cigarette,
  CigaretteOff,
  Clock,
  Cloud,
  CloudMoon,
  CloudRain,
  CloudSun,
  Coffee,
  Dog,
  Dumbbell,
  Film,
  Flame,
  Footprints,
  Frown,
  Gamepad2,
  Gift,
  GlassWater,
  GraduationCap,
  HandHeart,
  Headphones,
  Heart,
  HeartPulse,
  HelpCircle,
  Home,
  House,
  Laugh,
  Leaf,
  LogOut,
  Meh,
  Moon,
  MoonStar,
  Mountain,
  Music,
  Palette,
  PartyPopper,
  Phone,
  Pill,
  Pizza,
  Plane,
  ShoppingCart,
  SlidersHorizontal,
  Smile,
  Star,
  Stethoscope,
  Sun,
  Swords,
  Syringe,
  Tag,
  Thermometer,
  ThumbsUp,
  Trees,
  User,
  Users,
  UtensilsCrossed,
  Wine,
  Zap,
  type LucideIcon,
} from "lucide-react";

/**
 * v1.8.5 — icon-name → Lucide component map for the structured mood-tag
 * taxonomy. The catalog stores Lucide icon names as strings (so the
 * server stays icon-library-agnostic); this map resolves them on the
 * client. Mirrors the static-map convention used by the workout / sport
 * icon lookups. `Tag` is the fallback for an unmapped name.
 *
 * v1.17 — extended to a superset of the server's custom-tag icon
 * allowlist (`src/lib/mood/icon-catalog.ts`): the allowlist is the
 * contract, this map must always cover at least every allowed name so a
 * user-picked icon never falls back to the generic glyph on web.
 */
const MOOD_TAG_ICONS: Record<string, LucideIcon> = {
  Activity,
  AlertTriangle,
  Angry,
  Apple,
  Baby,
  Banknote,
  Bath,
  Bed,
  BedDouble,
  Bike,
  Book,
  BookOpen,
  Brain,
  Briefcase,
  Camera,
  CandyOff,
  Car,
  Cat,
  CheckCircle,
  Cigarette,
  CigaretteOff,
  Clock,
  Cloud,
  CloudMoon,
  CloudRain,
  CloudSun,
  Coffee,
  Dog,
  Dumbbell,
  Film,
  Flame,
  Footprints,
  Frown,
  Gamepad2,
  Gift,
  GlassWater,
  GraduationCap,
  HandHeart,
  Headphones,
  Heart,
  HeartPulse,
  HelpCircle,
  Home,
  House,
  Laugh,
  Leaf,
  LogOut,
  Meh,
  Moon,
  MoonStar,
  Mountain,
  Music,
  Palette,
  PartyPopper,
  Phone,
  Pill,
  Pizza,
  Plane,
  ShoppingCart,
  SlidersHorizontal,
  Smile,
  Star,
  Stethoscope,
  Sun,
  Swords,
  Syringe,
  Tag,
  Thermometer,
  ThumbsUp,
  Trees,
  User,
  Users,
  UtensilsCrossed,
  Wine,
  Zap,
};

export function moodTagIcon(name: string | null | undefined): LucideIcon {
  if (!name) return Tag;
  return MOOD_TAG_ICONS[name] ?? Tag;
}

/**
 * v1.17 — every icon name this client can resolve to a real glyph.
 * The searchable icon picker filters the shared catalog against this
 * set so a catalog entry the bundle can't draw is never offered.
 */
export function isMoodTagIconName(name: string): boolean {
  return name in MOOD_TAG_ICONS;
}

/**
 * v1.12.0 — face icon per mood enum for the "How are you?" 5-face hero.
 *
 * The logging surface renders these five faces best-on-the-left
 * (`SUPER_GUT` … `LAUSIG`) as the primary mood input. Monochrome by
 * default; the selection accent is applied by the caller (the one
 * sanctioned tint), matching the iOS `Mood1…Mood5` imageset order.
 */
const MOOD_FACE_ICONS: Record<string, LucideIcon> = {
  SUPER_GUT: Laugh,
  GUT: Smile,
  OKAY: Meh,
  SCHLECHT: Frown,
  LAUSIG: Angry,
};

export function moodFaceIcon(mood: string): LucideIcon {
  return MOOD_FACE_ICONS[mood] ?? Meh;
}
