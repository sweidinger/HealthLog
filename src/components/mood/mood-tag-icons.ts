import {
  AlertTriangle,
  Angry,
  Apple,
  BedDouble,
  BookOpen,
  Brain,
  Briefcase,
  CandyOff,
  CheckCircle,
  Clock,
  CloudMoon,
  CloudRain,
  CloudSun,
  Dumbbell,
  Film,
  Flame,
  Footprints,
  Frown,
  Gamepad2,
  GlassWater,
  HandHeart,
  Heart,
  HeartPulse,
  HelpCircle,
  Home,
  Laugh,
  LogOut,
  Meh,
  Moon,
  MoonStar,
  Music,
  Palette,
  PartyPopper,
  Pizza,
  Plane,
  SlidersHorizontal,
  Smile,
  Swords,
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
 */
const MOOD_TAG_ICONS: Record<string, LucideIcon> = {
  AlertTriangle,
  Apple,
  BedDouble,
  BookOpen,
  Brain,
  Briefcase,
  CandyOff,
  CheckCircle,
  Clock,
  CloudMoon,
  CloudRain,
  CloudSun,
  Dumbbell,
  Film,
  Flame,
  Footprints,
  Frown,
  Gamepad2,
  GlassWater,
  HandHeart,
  Heart,
  HeartPulse,
  HelpCircle,
  Home,
  LogOut,
  Meh,
  Moon,
  MoonStar,
  Music,
  Palette,
  PartyPopper,
  Pizza,
  Plane,
  SlidersHorizontal,
  Smile,
  Swords,
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
