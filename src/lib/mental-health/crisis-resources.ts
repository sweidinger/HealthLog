/**
 * v1.25 — locale-aware crisis-resource signposting for the PHQ-9 item-9 safety
 * path. This is SUPPORT, not interpretation: when item 9 is answered with any
 * non-zero value the UI shows a calm, non-alarmist card pointing to real help.
 *
 * The list is maintained config (not hardcoded in a component) so a self-hoster
 * can localise it. Names resolve via the `mentalHealth.crisisResource.<id>.name`
 * i18n key; the contact lines (phone numbers / URLs) are literal data, never
 * translated. The emergency number is region-specific and always shown first.
 *
 * HARD RULE: showing these resources NEVER triggers any third-party alert,
 * never notifies a contact, never emails. It is private, on-device-only
 * signposting on a self-host.
 */

export interface CrisisResource {
  /** Stable id; the `mentalHealth.crisisResource.<id>.name` i18n key resolves the label. */
  id: string;
  /** Contact lines (phone / SMS / chat URL) — literal, not translated. */
  contacts: readonly string[];
}

export interface CrisisResourceSet {
  /** Region's universal emergency number, shown first ("if in immediate danger…"). */
  emergencyNumber: string;
  resources: readonly CrisisResource[];
}

/** International fallback set (used when a region has no dedicated entry). */
const INTERNATIONAL: CrisisResourceSet = {
  emergencyNumber: "112",
  resources: [
    { id: "findahelpline", contacts: ["findahelpline.com"] },
    { id: "euEmotionalSupport", contacts: ["116 123"] },
  ],
};

/** Germany (de) — TelefonSeelsorge + youth lines + acute emergency. */
const DE: CrisisResourceSet = {
  emergencyNumber: "112",
  resources: [
    {
      id: "telefonSeelsorge",
      contacts: ["0800 111 0 111", "0800 111 0 222", "telefonseelsorge.de"],
    },
    { id: "nummerGegenKummer", contacts: ["116 111"] },
    { id: "krisenchat", contacts: ["krisenchat.de"] },
    { id: "findahelpline", contacts: ["findahelpline.com"] },
  ],
};

/** United States (en-US region hint) — 988 + Crisis Text Line. */
const US: CrisisResourceSet = {
  emergencyNumber: "911",
  resources: [
    { id: "lifeline988", contacts: ["988"] },
    { id: "crisisTextLine", contacts: ["Text HOME to 741741"] },
    { id: "findahelpline", contacts: ["findahelpline.com"] },
  ],
};

/**
 * Resolve a crisis-resource set from the user's locale. Region detection is
 * coarse (locale prefix) and defaults to the international set — the goal is to
 * always surface SOMETHING actionable, never to be exhaustive.
 */
export function crisisResourcesForLocale(
  locale: string | null | undefined,
): CrisisResourceSet {
  const lc = (locale ?? "").toLowerCase();
  if (lc.startsWith("de")) return DE;
  if (lc === "en-us" || lc.startsWith("en_us") || lc === "us") return US;
  return INTERNATIONAL;
}
