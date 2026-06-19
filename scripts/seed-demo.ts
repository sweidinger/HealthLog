/**
 * Demo Data Seed Script for HealthLog
 *
 * Creates a realistic, aspirational demo tenant for the public `demo`
 * account (demo / demo123demo123 — credentials are intentionally public).
 * The shape is tuned so a fresh seed reads healthy, engaged, and current
 * for App-Store / marketing screenshots:
 *
 * - 1 admin user (demo/demo123demo123)
 * - 90 days of measurements (weight, BP, pulse, resting HR, body fat,
 *   sleep, steps) — flat-or-improving trends, most-recent point from today
 * - A full week of per-stage sleep nights (awake/REM/light(core)/deep),
 *   ~7.5 h each, including last night
 * - 90 days of body composition (fat/lean/muscle mass, total body water,
 *   bone mass, visceral fat, BMI) derived from the same-day weight + body fat
 * - 90 days of blood glucose in a healthy non-diabetic band (fasting +
 *   post-meal + bedtime, contexts tagged)
 * - 90 days of cardio fitness + vitals (HRV SDNN + RMSSD, SpO2, respiratory
 *   rate, VO2 max, active energy, walking/running distance, flights climbed)
 * - 90 days of WHOOP-style scores (recovery, day strain, sleep
 *   performance/efficiency/consistency) coherent with the sleep nights
 * - ~3-4 workouts/week (running, strength, cycling) with per-workout HR
 *   samples and per-workout strain
 * - 3 medications with schedules and ~90 days of intake history at high
 *   compliance, with today scheduled on-track (taken or not-yet-due)
 * - 90 days of mood entries
 * - Vorsorge (preventive-care) reminders — upcoming dental + annual physical
 * - One lab panel of biomarkers in healthy ranges
 * - One resolved illness episode in the past
 * - An AI-configured Coach with one short sample conversation
 * - App settings (registration disabled, English locale)
 *
 * Every date is relative to "now" so the demo stays fresh on every re-seed.
 *
 * Usage: npx tsx scripts/seed-demo.ts
 * Requires DATABASE_URL env var. The Coach sample conversation additionally
 * needs ENCRYPTION_KEYS / ENCRYPTION_KEY (the same key the app runs with).
 */

import { Buffer } from "node:buffer";

import pg from "pg";
import { encryptToBytes } from "../src/lib/ai/coach/bytes-codec";
import { encrypt } from "../src/lib/crypto";
import { VALUE_RANGES } from "../src/lib/validations/measurement";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL });

// ── Helpers ──────────────────────────────────────

function cuid(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "c";
  for (let i = 0; i < 24; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(
    7 + Math.floor(Math.random() * 3),
    Math.floor(Math.random() * 60),
    0,
    0,
  );
  return d;
}

// A specific local instant N days ago, at a fixed wall-clock time. Used for
// the per-stage sleep segments and the on-track intake slots where the hour
// matters (a random morning hour would scatter the sleep stages).
function daysAgoAt(n: number, hour: number, minute = 0): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(hour, minute, 0, 0);
  return d;
}

function formatDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

// Smooth random walk with mean reversion
function randomWalk(
  start: number,
  target: number,
  days: number,
  volatility: number,
  // Optional physiological band. A free walk can drift below the floor and
  // mint an out-of-range row (a systolic-0 BP reading was observed in a
  // fresh seed — iOS #33); clamping every step keeps the series inside the
  // same band the input validator enforces.
  clamp?: { min: number; max: number },
): number[] {
  const values: number[] = [start];
  for (let i = 1; i < days; i++) {
    const prev = values[i - 1];
    const drift = (target - prev) * 0.03; // mean reversion
    const noise = (Math.random() - 0.5) * volatility;
    let next = Math.round((prev + drift + noise) * 10) / 10;
    if (clamp) next = Math.min(clamp.max, Math.max(clamp.min, next));
    values.push(next);
  }
  return values;
}

// ── Main ─────────────────────────────────────────

async function seed() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    console.log("Cleaning existing data...");
    await client.query("DELETE FROM coach_messages");
    await client.query("DELETE FROM coach_conversations");
    await client.query("DELETE FROM illness_episodes");
    await client.query("DELETE FROM lab_results");
    await client.query("DELETE FROM measurement_reminders");
    await client.query("DELETE FROM mood_entries");
    await client.query("DELETE FROM workout_samples");
    await client.query("DELETE FROM workouts");
    await client.query("DELETE FROM medication_intake_events");
    await client.query("DELETE FROM medication_schedules");
    await client.query("DELETE FROM reminder_phase_configs");
    await client.query("DELETE FROM medications");
    await client.query("DELETE FROM measurements");
    await client.query("DELETE FROM user_achievements");
    await client.query("DELETE FROM audit_logs");
    await client.query("DELETE FROM sessions");
    await client.query("DELETE FROM passkeys");
    await client.query("DELETE FROM auth_challenges");
    await client.query("DELETE FROM notification_channels");
    await client.query("DELETE FROM push_subscriptions");
    await client.query("DELETE FROM api_tokens");
    await client.query("DELETE FROM data_backups");
    await client.query("DELETE FROM users");

    // ── User ──────────────────────────────────
    console.log("Creating demo user...");
    const userId = cuid();
    // argon2id hash of "demo123demo123" — pre-computed
    // We'll use a bcrypt-compatible approach: register via API later
    // For now, insert with a placeholder and we'll set it via the app
    const passwordHash =
      "$argon2id$v=19$m=65536,t=3,p=4$Kips6OxPAl0vmspO9SoKZQ$oX9gLgwHVnnENCqBloyM13ewuqmhPnw8EpLoemS3MNI";

    // AI Coach is configured to the Anthropic provider so the Coach surface
    // reads as connected. The stored key is a placeholder ciphertext: the
    // public demo never makes a live provider call (the sample conversation
    // below supplies the visible content), so no real credential is seeded.
    const aiProvider = "ANTHROPIC";
    const aiModel = "claude-3-5-sonnet";
    const aiKeyEncrypted = encrypt("sk-ant-demo-placeholder-not-a-live-key");

    await client.query(
      `INSERT INTO users (id, username, email, password_hash, role, height_cm, date_of_birth, gender, timezone, locale, ai_provider, ai_model, ai_anthropic_key_encrypted, onboarding_completed_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), NOW(), NOW())`,
      [
        userId,
        "demo",
        "demo@healthlog.app",
        passwordHash,
        "ADMIN",
        182.0,
        "1990-05-15",
        "MALE",
        "Europe/Berlin",
        "en",
        aiProvider,
        aiModel,
        aiKeyEncrypted,
      ],
    );

    // ── Measurements (90 days) ────────────────
    // The loop runs i = 0..days (inclusive) so the final iteration lands a
    // point for TODAY (daysAgo(0)) — every headline metric has a current
    // reading for the dashboard, not one from yesterday.
    console.log("Creating 90 days of measurements...");
    const days = 90;
    const span = days + 1; // include today

    // Weight: 86.5 → trending down to a stable ~82 (healthy BMI ~24.7 at 182cm)
    const weights = randomWalk(86.5, 82.0, span, 0.6);
    // Systolic BP: 128 → settled in the optimal band ~118 (clamped)
    const sysBP = randomWalk(128, 118, span, 3, VALUE_RANGES.BLOOD_PRESSURE_SYS);
    // Diastolic BP: 82 → settled ~76 (clamped)
    const diaBP = randomWalk(82, 76, span, 2.5, VALUE_RANGES.BLOOD_PRESSURE_DIA);
    // Spot pulse (daytime heart rate): ~72, gently lower
    const pulse = randomWalk(74, 70, span, 3, VALUE_RANGES.PULSE);
    // Resting heart rate: clean ~60, the metric the resting-pulse tile scores
    const restingHr = randomWalk(64, 58, span, 2, VALUE_RANGES.RESTING_HEART_RATE);
    // Body fat: 24% → trending to a healthy ~19%
    const bodyFat = randomWalk(24.0, 19.0, span, 0.4, VALUE_RANGES.BODY_FAT);
    // Sleep duration in MINUTES (the SLEEP_DURATION unit): ~7h → ~7h45m
    const sleepMin = randomWalk(420, 465, span, 25, VALUE_RANGES.SLEEP_DURATION);
    // Steps: 6500 → a solid ~9000
    const steps = randomWalk(6500, 9000, span, 1500);

    for (let i = 0; i < span; i++) {
      const date = daysAgo(days - i);

      // Weight (daily)
      await client.query(
        `INSERT INTO measurements (id, user_id, type, value, unit, source, measured_at, created_at, updated_at)
         VALUES ($1, $2, 'WEIGHT', $3, 'kg', 'MANUAL', $4, $4, $4)`,
        [cuid(), userId, weights[i], date],
      );

      // Blood pressure (daily)
      await client.query(
        `INSERT INTO measurements (id, user_id, type, value, unit, source, measured_at, created_at, updated_at)
         VALUES ($1, $2, 'BLOOD_PRESSURE_SYS', $3, 'mmHg', 'MANUAL', $4, $4, $4)`,
        [cuid(), userId, Math.round(sysBP[i]), date],
      );
      await client.query(
        `INSERT INTO measurements (id, user_id, type, value, unit, source, measured_at, created_at, updated_at)
         VALUES ($1, $2, 'BLOOD_PRESSURE_DIA', $3, 'mmHg', 'MANUAL', $4, $4, $4)`,
        [cuid(), userId, Math.round(diaBP[i]), date],
      );

      // Spot pulse (daily)
      await client.query(
        `INSERT INTO measurements (id, user_id, type, value, unit, source, measured_at, created_at, updated_at)
         VALUES ($1, $2, 'PULSE', $3, 'bpm', 'MANUAL', $4, $4, $4)`,
        [cuid(), userId, Math.round(pulse[i]), date],
      );

      // Resting heart rate (daily) — scored by the resting-pulse tile
      await client.query(
        `INSERT INTO measurements (id, user_id, type, value, unit, source, measured_at, created_at, updated_at)
         VALUES ($1, $2, 'RESTING_HEART_RATE', $3, 'bpm', 'MANUAL', $4, $4, $4)`,
        [cuid(), userId, Math.round(restingHr[i]), date],
      );

      // Body fat (every 2-3 days)
      if (i % 2 === 0 || Math.random() > 0.5) {
        await client.query(
          `INSERT INTO measurements (id, user_id, type, value, unit, source, measured_at, created_at, updated_at)
           VALUES ($1, $2, 'BODY_FAT', $3, '%', 'MANUAL', $4, $4, $4)`,
          [cuid(), userId, bodyFat[i], date],
        );
      }

      // Sleep duration (daily, in minutes). This single aggregate row keeps
      // the 90-day sleep series continuous for the trend chart. The most
      // recent seven nights are instead written as per-stage breakdowns below
      // (one row per stage); skip the aggregate for those so a night is not
      // double-counted (aggregate + summed stages).
      const nightsAgo = days - i;
      if (nightsAgo >= 7) {
        await client.query(
          `INSERT INTO measurements (id, user_id, type, value, unit, source, measured_at, created_at, updated_at)
           VALUES ($1, $2, 'SLEEP_DURATION', $3, 'minutes', 'MANUAL', $4, $4, $4)`,
          [cuid(), userId, Math.round(sleepMin[i]), date],
        );
      }

      // Steps (daily)
      await client.query(
        `INSERT INTO measurements (id, user_id, type, value, unit, source, measured_at, created_at, updated_at)
         VALUES ($1, $2, 'ACTIVITY_STEPS', $3, 'steps', 'MANUAL', $4, $4, $4)`,
        [cuid(), userId, Math.round(steps[i]), date],
      );
    }

    // ── Per-stage sleep nights (last 7 nights, incl. last night) ──
    // One SLEEP_DURATION row per stage, all stamped at the same wake instant,
    // mirroring how a HealthKit night lands (AWAKE / REM / CORE / DEEP, with
    // the legacy aggregate kept above). The reader sums the stages for the
    // night's total. Durations target a healthy ~7.5 h with a normal stage
    // mix (~55% core, ~22% REM, ~18% deep, ~5% awake). Source APPLE_HEALTH
    // with device_type 'watch' so the night reads as device-tracked rather
    // than a manual estimate.
    console.log("Creating per-stage sleep nights (7 nights)...");
    const sleepStages: Array<{ stage: string; fraction: number }> = [
      { stage: "AWAKE", fraction: 0.05 },
      { stage: "REM", fraction: 0.22 },
      { stage: "CORE", fraction: 0.55 },
      { stage: "DEEP", fraction: 0.18 },
    ];
    for (let n = 1; n <= 7; n++) {
      // Wake at ~06:50 with small per-night jitter; total ~7.5 h.
      const wake = daysAgoAt(n - 1, 6, 40 + Math.floor(Math.random() * 25));
      const totalMin = 440 + Math.floor(Math.random() * 40); // 7h20m – 8h
      for (const { stage, fraction } of sleepStages) {
        const stageMin = Math.round(totalMin * fraction);
        await client.query(
          `INSERT INTO measurements (id, user_id, type, value, unit, source, sleep_stage, device_type, measured_at, created_at, updated_at)
           VALUES ($1, $2, 'SLEEP_DURATION', $3, 'minutes', 'APPLE_HEALTH', $4, 'watch', $5, $5, $5)`,
          [cuid(), userId, stageMin, stage, wake],
        );
      }
    }

    // ── Body composition (smart-scale series) ──
    // A full scale-style breakdown, written every 2–3 days like a real
    // body-composition scale would record. Every component is DERIVED from
    // the same-day weight + body-fat series above so the numbers reconcile:
    // fat mass = weight × bodyFat%, fat-free mass = weight − fat mass, and
    // the muscle / water / bone / BMI components hang off those so the demo
    // never contradicts its own headline weight + body-fat tiles. Source
    // APPLE_HEALTH with device_type 'scale' so they read as device-tracked.
    // Canonical units (see prisma/schema.prisma + VALUE_RANGES): mass
    // components in kg, VISCERAL_FAT a 1–12 rating, BODY_MASS_INDEX kg/m².
    console.log("Creating body composition series...");
    const HEIGHT_M = 1.82;
    for (let i = 0; i < span; i++) {
      // Roughly every other day, jittered, so the cadence reads organic.
      if (i % 2 !== 0 && Math.random() > 0.4) continue;
      const date = daysAgo(days - i);
      const weightKg = weights[i];
      const fatPct = bodyFat[i];
      const fatMass = Math.round(weightKg * (fatPct / 100) * 10) / 10;
      const fatFree = Math.round((weightKg - fatMass) * 10) / 10;
      // Skeletal muscle is a subset of fat-free mass (~75% of it for a lean
      // adult male); lean body mass ≈ fat-free mass.
      const muscleMass = Math.round(fatFree * 0.75 * 10) / 10;
      const leanMass = fatFree;
      // Total body water ≈ 73% of fat-free mass (kg of water).
      const bodyWater = Math.round(fatFree * 0.73 * 10) / 10;
      const boneMass = Math.round((3.1 + (Math.random() - 0.5) * 0.2) * 10) / 10;
      // Visceral-fat rating on Withings' 1–12 scale; a healthy ~6, easing
      // down slightly as the body fat trends down.
      const visceralFat = Math.round(7 - (i / span) * 1.5);
      const bmi = Math.round((weightKg / (HEIGHT_M * HEIGHT_M)) * 10) / 10;

      const composition: Array<{ type: string; value: number; unit: string }> =
        [
          { type: "FAT_MASS", value: fatMass, unit: "kg" },
          { type: "FAT_FREE_MASS", value: fatFree, unit: "kg" },
          { type: "LEAN_BODY_MASS", value: leanMass, unit: "kg" },
          { type: "MUSCLE_MASS", value: muscleMass, unit: "kg" },
          { type: "TOTAL_BODY_WATER", value: bodyWater, unit: "kg" },
          { type: "BONE_MASS", value: boneMass, unit: "kg" },
          { type: "VISCERAL_FAT", value: visceralFat, unit: "rating" },
          { type: "BODY_MASS_INDEX", value: bmi, unit: "kg/m²" },
        ];
      for (const c of composition) {
        await client.query(
          `INSERT INTO measurements (id, user_id, type, value, unit, source, device_type, measured_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 'APPLE_HEALTH', 'scale', $6, $6, $6)`,
          [cuid(), userId, c.type, c.value, c.unit, date],
        );
      }
    }

    // ── Blood glucose (healthy non-diabetic series) ──
    // A few readings per day over the full window, every value in a healthy
    // non-diabetic band: fasting ~85–95 mg/dL, a well-controlled post-meal
    // peak ~110–135, and a calm bedtime ~95–105. Canonical storage is mg/dL
    // (schema note on BLOOD_GLUCOSE); the per-reading context lands in the
    // glucose_context column (FASTING / POSTPRANDIAL / BEDTIME) so the
    // glucose panel can apply the right target band per reading.
    console.log("Creating blood glucose series...");
    const glucoseReadings: Array<{
      context: string;
      hour: number;
      base: number;
      jitter: number;
    }> = [
      { context: "FASTING", hour: 7, base: 89, jitter: 6 },
      { context: "POSTPRANDIAL", hour: 13, base: 122, jitter: 12 },
      { context: "POSTPRANDIAL", hour: 19, base: 118, jitter: 12 },
      { context: "BEDTIME", hour: 22, base: 99, jitter: 6 },
    ];
    for (let i = 0; i < span; i++) {
      for (const r of glucoseReadings) {
        const at = daysAgoAt(days - i, r.hour, Math.floor(Math.random() * 30));
        const value = Math.round(r.base + (Math.random() - 0.5) * r.jitter);
        await client.query(
          `INSERT INTO measurements (id, user_id, type, value, unit, source, glucose_context, device_type, measured_at, created_at, updated_at)
           VALUES ($1, $2, 'BLOOD_GLUCOSE', $3, 'mg/dL', 'APPLE_HEALTH', $4, 'phone', $5, $5, $5)`,
          [cuid(), userId, value, r.context, at],
        );
      }
    }

    // ── Cardio fitness + vitals ───────────────
    // The dashboard + insights surface these device-tracked vitals. All
    // recent (full window, latest point today), all in healthy/aspirational
    // bands. Canonical units per schema + VALUE_RANGES: HRV ms,
    // OXYGEN_SATURATION percent, RESPIRATORY_RATE breaths/min, VO2_MAX
    // mL/(kg·min), ACTIVE_ENERGY_BURNED kcal, WALKING_RUNNING_DISTANCE metres,
    // FLIGHTS_CLIMBED count. Source APPLE_HEALTH device_type 'watch'.
    console.log("Creating cardio fitness + vitals series...");
    // HRV SDNN: a healthy ~55 ms, gently rising; also write the RMSSD variant.
    const hrvSdnn = randomWalk(48, 58, span, 5, VALUE_RANGES.HEART_RATE_VARIABILITY);
    const hrvRmssd = randomWalk(42, 52, span, 5, VALUE_RANGES.HRV_RMSSD);
    // SpO2: 97–99%.
    const spo2 = randomWalk(98, 98, span, 0.8, VALUE_RANGES.OXYGEN_SATURATION);
    // Respiratory rate: 13–16 breaths/min.
    const respRate = randomWalk(15, 14, span, 0.8, VALUE_RANGES.RESPIRATORY_RATE);
    // Active energy: ~550 kcal/day.
    const activeKcal = randomWalk(480, 600, span, 80, VALUE_RANGES.ACTIVE_ENERGY_BURNED);
    // Walking + running distance (metres): ~6–8 km/day, tracks steps.
    const distM = randomWalk(6200, 7800, span, 900, VALUE_RANGES.WALKING_RUNNING_DISTANCE);
    // Flights climbed: ~8–14/day.
    const flights = randomWalk(9, 13, span, 4, VALUE_RANGES.FLIGHTS_CLIMBED);

    for (let i = 0; i < span; i++) {
      const date = daysAgo(days - i);
      const vitals: Array<{ type: string; value: number; unit: string }> = [
        { type: "HEART_RATE_VARIABILITY", value: Math.round(hrvSdnn[i]), unit: "ms" },
        { type: "HRV_RMSSD", value: Math.round(hrvRmssd[i]), unit: "ms" },
        { type: "OXYGEN_SATURATION", value: Math.round(spo2[i] * 10) / 10, unit: "%" },
        { type: "RESPIRATORY_RATE", value: Math.round(respRate[i] * 10) / 10, unit: "count/min" },
        { type: "ACTIVE_ENERGY_BURNED", value: Math.round(activeKcal[i]), unit: "kcal" },
        { type: "WALKING_RUNNING_DISTANCE", value: Math.round(distM[i]), unit: "m" },
        { type: "FLIGHTS_CLIMBED", value: Math.round(flights[i]), unit: "count" },
      ];
      for (const v of vitals) {
        await client.query(
          `INSERT INTO measurements (id, user_id, type, value, unit, source, device_type, measured_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 'APPLE_HEALTH', 'watch', $6, $6, $6)`,
          [cuid(), userId, v.type, v.value, v.unit, date],
        );
      }
      // VO2 max: only every ~10 days (Apple samples it rarely), ~46–49.
      if (i % 10 === 0) {
        const vo2 = Math.round((46 + (i / span) * 3) * 10) / 10;
        await client.query(
          `INSERT INTO measurements (id, user_id, type, value, unit, source, device_type, measured_at, created_at, updated_at)
           VALUES ($1, $2, 'VO2_MAX', $3, 'mL/(kg·min)', 'APPLE_HEALTH', 'watch', $4, $4, $4)`,
          [cuid(), userId, vo2, date],
        );
      }
    }

    // ── Recovery / strain / sleep scores (WHOOP-style) ──
    // The WHOOP-style readiness surface. These are stored as Measurement rows
    // (type RECOVERY_SCORE / DAY_STRAIN / SLEEP_PERFORMANCE / SLEEP_EFFICIENCY
    // / SLEEP_CONSISTENCY, unit 'score' or '%') with source WHOOP, distinct
    // from the COMPUTED engine's own rows. Coherent with the seeded sleep:
    // well-slept nights pair with high recovery + efficiency, and day-strain
    // sits in a sustainable band. RECOVERY_SCORE / sleep percentages are
    // 0–100; DAY_STRAIN is on WHOOP's 0–21 scale.
    console.log("Creating recovery / strain / sleep scores...");
    const recovery = randomWalk(68, 78, span, 8, VALUE_RANGES.RECOVERY_SCORE);
    const dayStrain = randomWalk(11, 13, span, 2.5, VALUE_RANGES.DAY_STRAIN);
    const sleepPerf = randomWalk(82, 90, span, 6, VALUE_RANGES.SLEEP_PERFORMANCE);
    const sleepEff = randomWalk(88, 93, span, 4, VALUE_RANGES.SLEEP_EFFICIENCY);
    const sleepConsistency = randomWalk(74, 84, span, 6, VALUE_RANGES.SLEEP_CONSISTENCY);
    for (let i = 0; i < span; i++) {
      // Anchor scores to the morning wake instant so a night's recovery sits
      // on the day it belongs to.
      const at = daysAgoAt(days - i, 7, 0);
      const scores: Array<{ type: string; value: number; unit: string }> = [
        { type: "RECOVERY_SCORE", value: Math.round(recovery[i]), unit: "score" },
        { type: "DAY_STRAIN", value: Math.round(dayStrain[i] * 10) / 10, unit: "score" },
        { type: "SLEEP_PERFORMANCE", value: Math.round(sleepPerf[i]), unit: "%" },
        { type: "SLEEP_EFFICIENCY", value: Math.round(sleepEff[i]), unit: "%" },
        { type: "SLEEP_CONSISTENCY", value: Math.round(sleepConsistency[i]), unit: "%" },
      ];
      for (const s of scores) {
        await client.query(
          `INSERT INTO measurements (id, user_id, type, value, unit, source, device_type, measured_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 'WHOOP', 'band', $6, $6, $6)`,
          [cuid(), userId, s.type, s.value, s.unit, at],
        );
      }
    }

    // ── Workouts ──────────────────────────────
    // ~3–4 sessions/week across the window: a mix of running, strength, and
    // cycling, with the fields the workout tiles render — duration, energy,
    // avg/max HR, distance (running/cycling). Each workout carries a sparse
    // HR sample series in WorkoutSamples (the per-workout HR chart) and its
    // per-workout strain in metadata (WORKOUT_STRAIN lives on the workout row
    // per the schema note, not as a free-floating Measurement). Distances in
    // metres, energy in kcal, durations in seconds — matching the model.
    console.log("Creating workouts...");
    const workoutPlan: Array<{
      sport: string;
      durationMin: number;
      kcal: number;
      avgHr: number;
      maxHr: number;
      distanceM: number | null;
      strain: number;
    }> = [
      { sport: "running", durationMin: 38, kcal: 420, avgHr: 148, maxHr: 171, distanceM: 6500, strain: 13.4 },
      { sport: "strength", durationMin: 52, kcal: 360, avgHr: 118, maxHr: 152, distanceM: null, strain: 10.2 },
      { sport: "cycling", durationMin: 65, kcal: 520, avgHr: 134, maxHr: 158, distanceM: 24000, strain: 12.1 },
    ];
    // Step backwards through the window placing ~2 sessions a week per slot
    // so the cadence lands around 3–4/week without overlapping.
    let planIdx = 0;
    for (let dayOffset = days - 1; dayOffset >= 1; dayOffset -= 2) {
      // Skip ~25% of slots so the week isn't perfectly regular.
      if (Math.random() < 0.25) continue;
      const plan = workoutPlan[planIdx % workoutPlan.length];
      planIdx += 1;
      const startHour = 17 + Math.floor(Math.random() * 3);
      const startedAt = daysAgoAt(dayOffset, startHour, Math.floor(Math.random() * 50));
      const durationSec = plan.durationMin * 60;
      const endedAt = new Date(startedAt.getTime() + durationSec * 1000);
      const workoutId = cuid();
      await client.query(
        `INSERT INTO workouts (id, user_id, sport_type, started_at, ended_at, duration_sec, total_energy_kcal, total_distance_m, avg_heart_rate, max_heart_rate, source, metadata, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'APPLE_HEALTH', $11, $4, $4)`,
        [
          workoutId,
          userId,
          plan.sport,
          startedAt,
          endedAt,
          durationSec,
          plan.kcal,
          plan.distanceM,
          plan.avgHr,
          plan.maxHr,
          JSON.stringify({ workoutStrain: plan.strain }),
        ],
      );
      // A sparse HR series — one sample every ~5 minutes across the session,
      // rising into the working band and easing at the end. The per-workout
      // HR chart renders straight from this WorkoutSamples blob.
      const sampleCount = Math.max(2, Math.round(plan.durationMin / 5));
      const samples: Array<{ t: string; hr: number }> = [];
      for (let s = 0; s < sampleCount; s++) {
        const frac = s / (sampleCount - 1);
        // Warm up from ~60% to the avg, peak near the max around 70% through.
        const peakBias = 1 - Math.abs(frac - 0.7) * 0.6;
        const hr = Math.round(
          plan.avgHr + (plan.maxHr - plan.avgHr) * peakBias * 0.7,
        );
        const t = new Date(startedAt.getTime() + frac * durationSec * 1000);
        samples.push({ t: t.toISOString(), hr });
      }
      await client.query(
        `INSERT INTO workout_samples (id, workout_id, samples, sample_count, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [cuid(), workoutId, JSON.stringify(samples), samples.length],
      );
    }

    // ── Medications ───────────────────────────
    console.log("Creating medications...");

    // Medication 1: Ramipril (blood pressure)
    const med1Id = cuid();
    await client.query(
      `INSERT INTO medications (id, user_id, name, dose, active, notifications_enabled, created_at, updated_at)
       VALUES ($1, $2, 'Ramipril', '5mg', true, true, $3, $3)`,
      [med1Id, userId, daysAgo(120)],
    );
    const sched1Id = cuid();
    await client.query(
      `INSERT INTO medication_schedules (id, medication_id, window_start, window_end, label)
       VALUES ($1, $2, '08:00', '10:00', 'Morning')`,
      [sched1Id, med1Id],
    );

    // Medication 2: Vitamin D3
    const med2Id = cuid();
    await client.query(
      `INSERT INTO medications (id, user_id, name, dose, active, notifications_enabled, created_at, updated_at)
       VALUES ($1, $2, 'Vitamin D3', '2000 IU', true, true, $3, $3)`,
      [med2Id, userId, daysAgo(90)],
    );
    const sched2Id = cuid();
    await client.query(
      `INSERT INTO medication_schedules (id, medication_id, window_start, window_end, label)
       VALUES ($1, $2, '08:00', '10:00', 'Morning')`,
      [sched2Id, med2Id],
    );

    // Medication 3: Magnesium (evening)
    const med3Id = cuid();
    await client.query(
      `INSERT INTO medications (id, user_id, name, dose, active, notifications_enabled, created_at, updated_at)
       VALUES ($1, $2, 'Magnesium', '400mg', true, true, $3, $3)`,
      [med3Id, userId, daysAgo(60)],
    );
    const sched3Id = cuid();
    await client.query(
      `INSERT INTO medication_schedules (id, medication_id, window_start, window_end, label)
       VALUES ($1, $2, '20:00', '22:00', 'Evening')`,
      [sched3Id, med3Id],
    );

    // ── Medication Intake Events ──────────────
    // High compliance with no overdue doses. Historical days (i < days) carry
    // a taken/skip row at ~95%+ adherence. TODAY is handled separately below
    // so the dashboard always reads on-track (morning doses taken, the
    // evening dose left as a not-yet-due pending row — never a miss).
    console.log("Creating intake events (90 days)...");

    for (let i = 0; i < days; i++) {
      const date = daysAgo(days - i);

      // Ramipril: 98% compliance (miss ~1 every 50 days)
      const takeMed1 = Math.random() > 0.02;
      if (takeMed1) {
        const takenTime = new Date(date);
        takenTime.setHours(8, Math.floor(Math.random() * 45), 0);
        await client.query(
          `INSERT INTO medication_intake_events (id, user_id, medication_id, scheduled_for, taken_at, skipped, source, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, false, 'WEB', $5, $5)`,
          [cuid(), userId, med1Id, date, takenTime],
        );
      } else {
        await client.query(
          `INSERT INTO medication_intake_events (id, user_id, medication_id, scheduled_for, taken_at, skipped, source, created_at, updated_at)
           VALUES ($1, $2, $3, $4, NULL, true, 'WEB', $4, $4)`,
          [cuid(), userId, med1Id, date],
        );
      }

      // Vitamin D3: 95% compliance
      const takeMed2 = Math.random() > 0.05;
      if (takeMed2) {
        const takenTime = new Date(date);
        takenTime.setHours(8, Math.floor(5 + Math.random() * 50), 0);
        await client.query(
          `INSERT INTO medication_intake_events (id, user_id, medication_id, scheduled_for, taken_at, skipped, source, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, false, 'WEB', $5, $5)`,
          [cuid(), userId, med2Id, date, takenTime],
        );
      } else {
        await client.query(
          `INSERT INTO medication_intake_events (id, user_id, medication_id, scheduled_for, taken_at, skipped, source, created_at, updated_at)
           VALUES ($1, $2, $3, $4, NULL, true, 'WEB', $4, $4)`,
          [cuid(), userId, med2Id, date],
        );
      }

      // Magnesium: only last 60 days, 94% compliance
      if (i >= 30) {
        const takeMed3 = Math.random() > 0.06;
        if (takeMed3) {
          const takenTime = new Date(date);
          takenTime.setHours(20, Math.floor(Math.random() * 60), 0);
          await client.query(
            `INSERT INTO medication_intake_events (id, user_id, medication_id, scheduled_for, taken_at, skipped, source, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, false, 'WEB', $5, $5)`,
            [cuid(), userId, med3Id, date, takenTime],
          );
        } else {
          await client.query(
            `INSERT INTO medication_intake_events (id, user_id, medication_id, scheduled_for, taken_at, skipped, source, created_at, updated_at)
             VALUES ($1, $2, $3, $4, NULL, true, 'WEB', $4, $4)`,
            [cuid(), userId, med3Id, date],
          );
        }
      }
    }

    // ── Today's doses (on-track, no overdue) ──
    // Morning meds: taken inside their 08:00–10:00 window. Evening Magnesium:
    // a pending row anchored on tonight's 20:00 slot, never auto-missed — it
    // reads as "not yet due" regardless of the seed wall-clock, and the
    // compliance engine excludes a plain pending row from the denominator, so
    // "today" never shows 0% or an overdue dose.
    console.log("Creating today's on-track doses...");
    const todayMorning = daysAgoAt(0, 8, 30);
    await client.query(
      `INSERT INTO medication_intake_events (id, user_id, medication_id, scheduled_for, taken_at, skipped, source, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4, false, 'WEB', $4, $4)`,
      [cuid(), userId, med1Id, todayMorning],
    );
    await client.query(
      `INSERT INTO medication_intake_events (id, user_id, medication_id, scheduled_for, taken_at, skipped, source, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4, false, 'WEB', $4, $4)`,
      [cuid(), userId, med2Id, todayMorning],
    );
    const todayEvening = daysAgoAt(0, 20, 0);
    await client.query(
      `INSERT INTO medication_intake_events (id, user_id, medication_id, scheduled_for, taken_at, skipped, auto_missed, source, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NULL, false, false, 'WEB', $4, $4)`,
      [cuid(), userId, med3Id, todayEvening],
    );

    // ── Mood Entries ─────────────────────────
    console.log("Creating mood entries (90 days)...");

    const moodOptions = ["SUPER_GUT", "GUT", "OKAY", "SCHLECHT", "LAUSIG"];
    const tagOptions = [
      ["productive", "exercise", "well-rested"],
      ["focused", "social", "creative"],
      ["tired", "stressed"],
      ["anxious", "low-energy"],
      ["exhausted", "pain"],
    ];

    // Mood trend: starts solid (~3.5) and improves to ~4.4 — flat-or-up, so
    // the score never dips into an alarming band.
    const moodTrend = randomWalk(3.5, 4.4, span, 0.7);

    for (let i = 0; i < span; i++) {
      // Skip ~5% of days (forgot to log)
      if (Math.random() < 0.05) continue;

      const date = daysAgo(days - i);
      const rawScore = Math.round(Math.min(5, Math.max(1, moodTrend[i])));
      const mood = moodOptions[5 - rawScore]; // invert: score 5 = SUPER_GUT
      const tags = tagOptions[5 - rawScore];
      const loggedAt = new Date(date);
      loggedAt.setHours(21, Math.floor(Math.random() * 59), 0);

      await client.query(
        `INSERT INTO mood_entries (id, user_id, date, mood, score, tags, source, mood_logged_at, synced_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'WEB', $7, $7, $7, $7)`,
        [
          cuid(),
          userId,
          formatDate(date),
          mood,
          rawScore,
          JSON.stringify(tags),
          loggedAt,
        ],
      );
    }

    // ── Vorsorge reminders (preventive care) ──
    // User-created (origin VORSORGE) checklist reminders with no auto-resolve
    // measurement target. Both anchored to fire comfortably in the future so
    // the Vorsorge surface shows sensible upcoming items, not overdue ones.
    console.log("Creating Vorsorge reminders...");
    const dentalNextDue = daysAgo(-45); // ~6 weeks out
    await client.query(
      `INSERT INTO measurement_reminders (id, user_id, label, interval_days, anchor_date, origin, notify_hour, location, next_due_at, created_at, updated_at)
       VALUES ($1, $2, 'Dental check-up', 365, $3, 'VORSORGE', 9, 'Dentist', $4, NOW(), NOW())`,
      [cuid(), userId, daysAgo(320), dentalNextDue],
    );
    const physicalNextDue = daysAgo(-90); // ~3 months out
    await client.query(
      `INSERT INTO measurement_reminders (id, user_id, label, interval_days, anchor_date, origin, notify_hour, location, next_due_at, created_at, updated_at)
       VALUES ($1, $2, 'Annual physical', 365, $3, 'VORSORGE', 9, 'Family doctor', $4, NOW(), NOW())`,
      [cuid(), userId, daysAgo(275), physicalNextDue],
    );

    // ── Lab panel (biomarkers in healthy ranges) ──
    // One grouped panel taken ~10 days ago, every analyte comfortably inside
    // its reference range, so the labs surface reads clean.
    console.log("Creating lab panel...");
    const panelTakenAt = daysAgo(10);
    const labResults: Array<{
      analyte: string;
      value: number;
      unit: string;
      low: number;
      high: number;
    }> = [
      { analyte: "Total Cholesterol", value: 178, unit: "mg/dL", low: 0, high: 200 },
      { analyte: "LDL", value: 98, unit: "mg/dL", low: 0, high: 130 },
      { analyte: "HDL", value: 58, unit: "mg/dL", low: 40, high: 100 },
      { analyte: "Triglycerides", value: 92, unit: "mg/dL", low: 0, high: 150 },
      { analyte: "HbA1c", value: 5.2, unit: "%", low: 4.0, high: 5.6 },
      { analyte: "Fasting Glucose", value: 89, unit: "mg/dL", low: 70, high: 99 },
      { analyte: "Vitamin D", value: 42, unit: "ng/mL", low: 30, high: 100 },
      { analyte: "TSH", value: 1.8, unit: "mIU/L", low: 0.4, high: 4.0 },
      { analyte: "Ferritin", value: 120, unit: "ng/mL", low: 30, high: 400 },
    ];
    for (const lab of labResults) {
      await client.query(
        `INSERT INTO lab_results (id, user_id, panel, analyte, value, unit, reference_low, reference_high, taken_at, source, created_at, updated_at)
         VALUES ($1, $2, 'Annual blood panel', $3, $4, $5, $6, $7, $8, 'MANUAL', NOW(), NOW())`,
        [
          cuid(),
          userId,
          lab.analyte,
          lab.value,
          lab.unit,
          lab.low,
          lab.high,
          panelTakenAt,
        ],
      );
    }

    // ── Resolved illness episode ──────────────
    // A short cold ~7 weeks ago, fully recovered, so the illness journal shows
    // a clean "resolved" entry rather than an active sickness.
    console.log("Creating resolved illness episode...");
    await client.query(
      `INSERT INTO illness_episodes (id, user_id, label, type, lifecycle, onset_at, resolved_at, created_at, updated_at)
       VALUES ($1, $2, 'Common cold', 'INFECTION', 'ACUTE', $3, $4, NOW(), NOW())`,
      [cuid(), userId, daysAgo(49), daysAgo(43)],
    );

    // ── Achievements ─────────────────────────
    console.log("Creating achievements...");

    // Every id below is a real key from the achievement registry
    // (src/lib/gamification/achievements.ts) so the badge resolves to a real
    // title/icon rather than an "unknown" placeholder. Only milestones the
    // seeded history genuinely supports are unlocked (first-entry badges,
    // logging streaks, in-range BP/pulse/BMI streaks, compliance + miss-free
    // streaks, the self-context + 7-night sleep badges). The dynamic streak
    // families use the `<prefix>-<target>` naming the generator emits.
    const achievements = [
      { id: "weight-first", daysAgo: 89 },
      { id: "bp-first", daysAgo: 89 },
      { id: "pulse-first", daysAgo: 89 },
      { id: "mood-first", daysAgo: 89 },
      { id: "self-context-complete", daysAgo: 88 },
      { id: "entry-streak-7", daysAgo: 82 },
      { id: "mood-streak-7", daysAgo: 82 },
      { id: "sleep-log-7", daysAgo: 70 },
      { id: "mood-up-7", daysAgo: 68 },
      { id: "weight-50", daysAgo: 60 },
      { id: "bp-50", daysAgo: 55 },
      { id: "entry-streak-30", daysAgo: 50 },
      { id: "mood-streak-30", daysAgo: 50 },
      { id: "miss-free-7", daysAgo: 48 },
      { id: "consistent-month", daysAgo: 45 },
      { id: "bp-green-7", daysAgo: 42 },
      { id: "pulse-green-7", daysAgo: 40 },
      { id: "bmi-green-7", daysAgo: 38 },
      { id: "compliance-80-30", daysAgo: 30 },
      { id: "miss-free-30", daysAgo: 30 },
      { id: "on-time-perfect-7", daysAgo: 28 },
      { id: "measurement-weeks-4", daysAgo: 25 },
      { id: "bp-green-30", daysAgo: 12 },
      { id: "pulse-green-30", daysAgo: 10 },
      { id: "miss-free-90", daysAgo: 2 },
    ];

    for (const ach of achievements) {
      const unlocked = daysAgo(ach.daysAgo);
      await client.query(
        `INSERT INTO user_achievements (id, user_id, achievement_id, unlocked_at, created_at)
         VALUES ($1, $2, $3, $4, $4)`,
        [cuid(), userId, ach.id, unlocked],
      );
    }

    // ── Coach sample conversation ─────────────
    // A short, encrypted two-turn exchange so the Coach surface shows real
    // content. Messages use the same AES-256-GCM Bytes codec the app writes
    // with (encryptToBytes → encrypt() under ENCRYPTION_KEYS), so they decrypt
    // exactly like a live conversation — no faked / plaintext rows.
    console.log("Creating Coach sample conversation...");
    const convoId = cuid();
    const convoStart = daysAgo(3);
    await client.query(
      `INSERT INTO coach_conversations (id, user_id, title, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4)`,
      [convoId, userId, "Blood pressure trend", convoStart],
    );

    const coachTurns: Array<{
      role: string;
      content: string;
      metricSourceJson?: string;
    }> = [
      {
        role: "user",
        content: "How has my blood pressure been trending lately?",
      },
      {
        role: "assistant",
        content:
          "Your blood pressure has been settling nicely. Over the last few " +
          "weeks the morning readings have drifted into the optimal band, and " +
          "your resting heart rate is sitting in a comfortable range too. " +
          "Keeping up the steady sleep and daily movement looks like it is " +
          "paying off — worth staying consistent with the morning measurements " +
          "so the trend stays easy to read.",
        metricSourceJson: JSON.stringify({
          window: "last30days",
          metrics: ["bloodPressure", "restingHeartRate", "sleep"],
        }),
      },
    ];
    for (let t = 0; t < coachTurns.length; t++) {
      const turn = coachTurns[t];
      const ts = new Date(convoStart.getTime() + t * 60_000);
      const encrypted = Buffer.from(encryptToBytes(turn.content));
      await client.query(
        `INSERT INTO coach_messages (id, conversation_id, role, encrypted_content, metric_source_json, provider_type, prompt_version, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          cuid(),
          convoId,
          turn.role,
          encrypted,
          turn.metricSourceJson ?? null,
          turn.role === "assistant" ? aiProvider : null,
          turn.role === "assistant" ? "demo" : null,
          ts,
        ],
      );
    }

    // ── App Settings ─────────────────────────
    console.log("Creating app settings...");
    await client.query(
      `INSERT INTO app_settings (id, registration_enabled, default_locale)
       VALUES ('singleton', false, 'en')
       ON CONFLICT (id) DO UPDATE SET registration_enabled = false, default_locale = 'en'`,
    );

    // ── Audit Log (some login entries) ──────
    console.log("Creating audit log entries...");
    for (let i = 0; i < 15; i++) {
      const loginDate = daysAgo(Math.floor(Math.random() * 30));
      await client.query(
        `INSERT INTO audit_logs (id, user_id, action, details, ip_address, created_at)
         VALUES ($1, $2, 'auth.login', '{"method":"password"}', '203.0.113.42', $3)`,
        [cuid(), userId, loginDate],
      );
    }

    await client.query("COMMIT");
    console.log("\nDemo data seeded successfully!");
    console.log(`  User: demo / demo123demo123`);
    console.log(`  Measurements: weight, BP, pulse, resting HR, body fat, steps, sleep`);
    console.log(`  Body composition: fat/lean/muscle mass, water, bone, visceral fat, BMI`);
    console.log(`  Blood glucose: ${glucoseReadings.length} readings/day (fasting + post-meal + bedtime)`);
    console.log(`  Cardio + vitals: HRV (SDNN + RMSSD), SpO2, resp. rate, VO2max, active energy, distance, flights`);
    console.log(`  Scores: recovery, day strain, sleep performance/efficiency/consistency`);
    console.log(`  Sleep: 7 per-stage nights (4 stages each) + daily aggregate`);
    console.log(`  Medications: 3 (high compliance, today on-track)`);
    console.log(`  Workouts: ~3-4/week (running, strength, cycling) with HR samples`);
    console.log(`  Mood: ~${Math.round(span * 0.95)} entries`);
    console.log(`  Vorsorge reminders: 2 (dental, annual physical)`);
    console.log(`  Lab panel: ${labResults.length} biomarkers`);
    console.log(`  Illness: 1 resolved episode`);
    console.log(`  Coach: 1 conversation (${coachTurns.length} messages)`);
    console.log(`  Achievements: ${achievements.length}`);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Seed failed:", err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
