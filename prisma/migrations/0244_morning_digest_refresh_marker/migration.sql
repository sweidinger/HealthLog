-- Morning-freshness marker (S4 of the unified daily-value system).
--
-- The nightly insight pre-pass runs ~04:30, before last night's sleep has
-- synced, so the morning digest/health-score reference the day WITHOUT the
-- current sleep. This column records the user-local YYYY-MM-DD (their profile
-- timezone) for which the event-driven morning refresh has completed: last
-- night's sleep arrived AND the sleep-dependent insight/score cache was
-- regenerated with it. The daily digest reports `final` once this equals the
-- user's current local date, `provisional` otherwise (honest degradation when
-- sleep is late or never arrives). Stamped by the `morning-digest-refresh`
-- pg-boss job the sleep-arrival trigger enqueues, debounced once per local
-- morning. NULL for every existing row = provisional until the next sleep
-- landing, which is the correct pre-feature reading.
ALTER TABLE "users"
  ADD COLUMN "morning_digest_refreshed_on" TEXT;
