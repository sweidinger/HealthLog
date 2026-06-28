"use client";

import { MentalWellbeing } from "@/components/mental-health/mental-wellbeing";

/**
 * v1.25 — `/insights/mental-wellbeing`.
 *
 * Opt-in PHQ-9 / GAD-7 screener surface, beside mood tracking. The screen owns
 * its own questionnaire + result + crisis-resource flow; it deliberately does
 * NOT mount the shared Coach-launch assessment card (mental-health item content
 * is kept out of the AI Coach by construction).
 */
export default function MentalWellbeingPage() {
  return (
    <div className="p-4 sm:p-6">
      <MentalWellbeing />
    </div>
  );
}
