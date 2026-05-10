# v1.4.18 — achievements expansion research

## Benchmarking

We surveyed five reference systems before sketching the new HealthLog
achievement set:

- **Apple Health (Activity rings, Workouts)** — month-of-perfect-days,
  ring-on-fire weeks, doubled-goal challenges. Tone is _celebratory but
  optional_; nothing shames you for missing a ring.
- **Withings (Health+)** — milestone-based ("First weigh-in", "100
  weigh-ins"), trend-based ("Lost 1 kg", "Maintained ±2 kg for 30 d"),
  and seasonal challenges. Notable: never fires a coercive "you missed
  a day" badge.
- **Oura** — readiness streaks, sleep regularity, recovery PRs, "first
  workout of the year". Heavy use of personal-baseline comparisons (no
  social leaderboard).
- **Strava** — local-legend / monthly-goal / segment-hunting; explicit
  social comparison. Not a fit for HealthLog (no sharing surface).
- **Habitica** — gamified to-do; daily streaks with grace days, tag-
  based achievements, hidden lore unlocks. The "hidden quest" pattern
  is the inspiration for our Easter eggs.

## Categories that fit HealthLog

Keep the existing four (medication / vitals / security / engagement)
and introduce two new buckets: **mood** and **hidden** (the Easter-egg
group). Add two cross-cutting _axes_ that aren't categories per se:
discovery (only earnable when the user has data for the metric) and
celebration (a special toast when a hidden one fires).

Categories explicitly **avoided** (per Marc's brief):

- Coercive volume nudges ("you measured the most this week!") — bad
  incentive for a self-tracked health PWA.
- Diagnostic framing ("hypertensive milestone") — never reward a
  classification that is medical bad news.
- Social-comparison ranking — there is no social surface to support it.

## Discovery rule

A public achievement (non-hidden) is only **shown to the user** when
the precondition predicate is satisfied. Predicate examples:

- mood badges → user has at least one `MoodEntry`
- weight badges → user has at least one `Measurement` of type `WEIGHT`
- BP/pulse badges → user has at least one `BLOOD_PRESSURE_SYS` /
  `PULSE` measurement
- medication badges → user has at least one active `Medication`

Hidden Easter-eggs are _always shown as opaque "?" cards_ but never
leak their conditions in the DOM, so a curious user knows the slot
exists without learning the trigger.

## Public proposals (15)

1. `mood-first` — "First mood entry" (1 pt, mood, milestone) — log any
   mood. Precondition: user can earn once they have any data path open.
2. `mood-streak-7` — "Mood diarist" (45 pt) — 7 consecutive days of
   mood logged.
3. `mood-streak-30` — "Mood diarist · 30 d" (180 pt).
4. `mood-up-7` — "Brighter week" (90 pt) — 7-day mood mean improved by
   ≥ 1.0 vs. previous 7-day window. Personal baseline only.
5. `weight-first` — "First weigh-in" (8 pt, vitals).
6. `weight-50` — "Fifty weigh-ins" (90 pt).
7. `weight-200` — "Two hundred weigh-ins" (320 pt).
8. `bp-first` — "First reading" (8 pt) — first BP measurement.
9. `bp-50` — "Fifty BP readings" (90 pt).
10. `bp-200` — "Two hundred BP readings" (320 pt).
11. `pulse-first` — "First pulse log" (8 pt).
12. `month-25-entries` — "Consistent month" (140 pt) — at least 25
    distinct days with any entry inside one calendar month (Berlin TZ).
13. `entry-streak-7` — "Tracker streak 7 d" (70 pt) — 7 consecutive
    days with at least one measurement OR mood OR intake.
14. `entry-streak-30` — "Tracker streak 30 d" (260 pt).
15. `weekend-warrior` — "Weekend tracker" (40 pt) — logged data on 4
    consecutive Sat+Sun pairs.

## Hidden Easter-eggs (6)

- `hidden-night-owl` — logged any entry between 02:00–04:00 Berlin
  local. Single occurrence. Title only revealed on unlock.
- `hidden-early-bird` — logged any entry between 04:00–06:00 Berlin.
- `hidden-leap-day` — logged any entry on Feb 29.
- `hidden-doctor-pdf` — exported a doctor-report PDF for the first
  time (uses an existing audit log row for the trigger).
- `hidden-locale-flip` — switched UI locale at least once
  (audit log: `settings.locale.update`).
- `hidden-bug-buddy` — submitted ≥ 5 bug reports (extending the
  existing single bugReport milestone with a playful follow-on).

Total new achievements: 15 public + 6 hidden = **21**, taking the
roster from 38 → 59. Co-Authored by Claude Opus 4.7.
