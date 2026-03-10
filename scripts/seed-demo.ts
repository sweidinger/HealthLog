/**
 * Demo Data Seed Script for HealthLog
 *
 * Creates realistic demo data:
 * - 1 admin user (demo/demo123demo123)
 * - 90 days of measurements (weight, BP, pulse, body fat, sleep, steps)
 * - 3 medications with schedules and intake history
 * - 90 days of mood entries
 * - App settings (registration disabled, English locale)
 *
 * Usage: npx tsx scripts/seed-demo.ts
 * Requires DATABASE_URL env var.
 */

import pg from "pg";

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
  d.setHours(7 + Math.floor(Math.random() * 3), Math.floor(Math.random() * 60), 0, 0);
  return d;
}

function formatDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

// Smooth random walk with mean reversion
function randomWalk(start: number, target: number, days: number, volatility: number): number[] {
  const values: number[] = [start];
  for (let i = 1; i < days; i++) {
    const prev = values[i - 1];
    const drift = (target - prev) * 0.03; // mean reversion
    const noise = (Math.random() - 0.5) * volatility;
    values.push(Math.round((prev + drift + noise) * 10) / 10);
  }
  return values;
}

// ── Main ─────────────────────────────────────────

async function seed() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    console.log("Cleaning existing data...");
    await client.query("DELETE FROM mood_entries");
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
    const passwordHash = "$argon2id$v=19$m=65536,t=3,p=4$Kips6OxPAl0vmspO9SoKZQ$oX9gLgwHVnnENCqBloyM13ewuqmhPnw8EpLoemS3MNI";

    await client.query(
      `INSERT INTO users (id, username, email, password_hash, role, height_cm, date_of_birth, gender, timezone, locale, onboarding_completed_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW(), NOW())`,
      [userId, "demo", "demo@healthlog.app", passwordHash, "ADMIN", 182.0, "1990-05-15", "MALE", "Europe/Berlin", "en"]
    );

    // ── Measurements (90 days) ────────────────
    console.log("Creating 90 days of measurements...");
    const days = 90;

    // Weight: 86.5 → trending down to ~82.5
    const weights = randomWalk(86.5, 82.0, days, 0.6);
    // Systolic BP: 132 → improving to ~124
    const sysBP = randomWalk(132, 124, days, 4);
    // Diastolic BP: 85 → improving to ~78
    const diaBP = randomWalk(85, 78, days, 3);
    // Pulse: 72 → slight improvement to ~68
    const pulse = randomWalk(72, 68, days, 3);
    // Body fat: 24.5% → trending to ~22%
    const bodyFat = randomWalk(24.5, 22.0, days, 0.4);
    // Sleep: 6.5h → improving to ~7.5h
    const sleep = randomWalk(6.5, 7.5, days, 0.8);
    // Steps: 5000 → improving to ~8000
    const steps = randomWalk(5000, 8500, days, 1500);

    for (let i = 0; i < days; i++) {
      const date = daysAgo(days - i);

      // Weight (daily)
      await client.query(
        `INSERT INTO measurements (id, user_id, type, value, unit, source, measured_at, created_at, updated_at)
         VALUES ($1, $2, 'WEIGHT', $3, 'kg', 'MANUAL', $4, $4, $4)`,
        [cuid(), userId, weights[i], date]
      );

      // Blood pressure (daily)
      await client.query(
        `INSERT INTO measurements (id, user_id, type, value, unit, source, measured_at, created_at, updated_at)
         VALUES ($1, $2, 'BLOOD_PRESSURE_SYS', $3, 'mmHg', 'MANUAL', $4, $4, $4)`,
        [cuid(), userId, Math.round(sysBP[i]), date]
      );
      await client.query(
        `INSERT INTO measurements (id, user_id, type, value, unit, source, measured_at, created_at, updated_at)
         VALUES ($1, $2, 'BLOOD_PRESSURE_DIA', $3, 'mmHg', 'MANUAL', $4, $4, $4)`,
        [cuid(), userId, Math.round(diaBP[i]), date]
      );

      // Pulse (daily)
      await client.query(
        `INSERT INTO measurements (id, user_id, type, value, unit, source, measured_at, created_at, updated_at)
         VALUES ($1, $2, 'PULSE', $3, 'bpm', 'MANUAL', $4, $4, $4)`,
        [cuid(), userId, Math.round(pulse[i]), date]
      );

      // Body fat (every 2-3 days)
      if (i % 2 === 0 || Math.random() > 0.5) {
        await client.query(
          `INSERT INTO measurements (id, user_id, type, value, unit, source, measured_at, created_at, updated_at)
           VALUES ($1, $2, 'BODY_FAT', $3, '%', 'MANUAL', $4, $4, $4)`,
          [cuid(), userId, bodyFat[i], date]
        );
      }

      // Sleep (daily)
      await client.query(
        `INSERT INTO measurements (id, user_id, type, value, unit, source, measured_at, created_at, updated_at)
         VALUES ($1, $2, 'SLEEP_DURATION', $3, 'hours', 'MANUAL', $4, $4, $4)`,
        [cuid(), userId, Math.round(sleep[i] * 10) / 10, date]
      );

      // Steps (daily)
      await client.query(
        `INSERT INTO measurements (id, user_id, type, value, unit, source, measured_at, created_at, updated_at)
         VALUES ($1, $2, 'ACTIVITY_STEPS', $3, 'steps', 'MANUAL', $4, $4, $4)`,
        [cuid(), userId, Math.round(steps[i]), date]
      );
    }

    // ── Medications ───────────────────────────
    console.log("Creating medications...");

    // Medication 1: Ramipril (blood pressure)
    const med1Id = cuid();
    await client.query(
      `INSERT INTO medications (id, user_id, name, dose, active, notifications_enabled, created_at, updated_at)
       VALUES ($1, $2, 'Ramipril', '5mg', true, true, $3, $3)`,
      [med1Id, userId, daysAgo(120)]
    );
    const sched1Id = cuid();
    await client.query(
      `INSERT INTO medication_schedules (id, medication_id, window_start, window_end, label)
       VALUES ($1, $2, '08:00', '10:00', 'Morning')`,
      [sched1Id, med1Id]
    );

    // Medication 2: Vitamin D3
    const med2Id = cuid();
    await client.query(
      `INSERT INTO medications (id, user_id, name, dose, active, notifications_enabled, created_at, updated_at)
       VALUES ($1, $2, 'Vitamin D3', '2000 IE', true, true, $3, $3)`,
      [med2Id, userId, daysAgo(90)]
    );
    const sched2Id = cuid();
    await client.query(
      `INSERT INTO medication_schedules (id, medication_id, window_start, window_end, label)
       VALUES ($1, $2, '08:00', '10:00', 'Morning')`,
      [sched2Id, med2Id]
    );

    // Medication 3: Magnesium (evening)
    const med3Id = cuid();
    await client.query(
      `INSERT INTO medications (id, user_id, name, dose, active, notifications_enabled, created_at, updated_at)
       VALUES ($1, $2, 'Magnesium', '400mg', true, true, $3, $3)`,
      [med3Id, userId, daysAgo(60)]
    );
    const sched3Id = cuid();
    await client.query(
      `INSERT INTO medication_schedules (id, medication_id, window_start, window_end, label)
       VALUES ($1, $2, '20:00', '22:00', 'Evening')`,
      [sched3Id, med3Id]
    );

    // ── Medication Intake Events ──────────────
    console.log("Creating intake events (90 days)...");

    for (let i = 0; i < days; i++) {
      const date = daysAgo(days - i);

      // Ramipril: 96% compliance (miss ~1 every 25 days)
      const takeMed1 = Math.random() > 0.04;
      if (takeMed1) {
        const takenTime = new Date(date);
        takenTime.setHours(8, Math.floor(Math.random() * 45), 0);
        await client.query(
          `INSERT INTO medication_intake_events (id, user_id, medication_id, scheduled_for, taken_at, skipped, source, created_at)
           VALUES ($1, $2, $3, $4, $5, false, 'WEB', $5)`,
          [cuid(), userId, med1Id, date, takenTime]
        );
      } else {
        await client.query(
          `INSERT INTO medication_intake_events (id, user_id, medication_id, scheduled_for, taken_at, skipped, source, created_at)
           VALUES ($1, $2, $3, $4, NULL, true, 'WEB', $4)`,
          [cuid(), userId, med1Id, date]
        );
      }

      // Vitamin D3: 92% compliance
      const takeMed2 = Math.random() > 0.08;
      if (takeMed2) {
        const takenTime = new Date(date);
        takenTime.setHours(8, Math.floor(5 + Math.random() * 50), 0);
        await client.query(
          `INSERT INTO medication_intake_events (id, user_id, medication_id, scheduled_for, taken_at, skipped, source, created_at)
           VALUES ($1, $2, $3, $4, $5, false, 'WEB', $5)`,
          [cuid(), userId, med2Id, date, takenTime]
        );
      } else {
        await client.query(
          `INSERT INTO medication_intake_events (id, user_id, medication_id, scheduled_for, taken_at, skipped, source, created_at)
           VALUES ($1, $2, $3, $4, NULL, true, 'WEB', $4)`,
          [cuid(), userId, med2Id, date]
        );
      }

      // Magnesium: only last 60 days, 88% compliance
      if (i >= 30) {
        const takeMed3 = Math.random() > 0.12;
        if (takeMed3) {
          const takenTime = new Date(date);
          takenTime.setHours(20, Math.floor(Math.random() * 60), 0);
          await client.query(
            `INSERT INTO medication_intake_events (id, user_id, medication_id, scheduled_for, taken_at, skipped, source, created_at)
             VALUES ($1, $2, $3, $4, $5, false, 'WEB', $5)`,
            [cuid(), userId, med3Id, date, takenTime]
          );
        } else {
          await client.query(
            `INSERT INTO medication_intake_events (id, user_id, medication_id, scheduled_for, taken_at, skipped, source, created_at)
             VALUES ($1, $2, $3, $4, NULL, true, 'WEB', $4)`,
            [cuid(), userId, med3Id, date]
          );
        }
      }
    }

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

    // Mood trend: starts around 3, improves to ~4 over time
    const moodTrend = randomWalk(3.0, 4.2, days, 0.8);

    for (let i = 0; i < days; i++) {
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
        [cuid(), userId, formatDate(date), mood, rawScore, JSON.stringify(tags), loggedAt]
      );
    }

    // ── Achievements ─────────────────────────
    console.log("Creating achievements...");

    const achievements = [
      { id: "first-measurement", daysAgo: 89 },
      { id: "first-medication", daysAgo: 89 },
      { id: "first-mood", daysAgo: 89 },
      { id: "week-streak-measurements", daysAgo: 82 },
      { id: "week-streak-mood", daysAgo: 82 },
      { id: "month-streak-measurements", daysAgo: 59 },
      { id: "compliance-90", daysAgo: 45 },
      { id: "weight-loss-5", daysAgo: 30 },
      { id: "bp-normal", daysAgo: 20 },
      { id: "steps-10k", daysAgo: 15 },
      { id: "month-streak-mood", daysAgo: 10 },
      { id: "three-month-streak", daysAgo: 2 },
    ];

    for (const ach of achievements) {
      const unlocked = daysAgo(ach.daysAgo);
      await client.query(
        `INSERT INTO user_achievements (id, user_id, achievement_id, unlocked_at, created_at)
         VALUES ($1, $2, $3, $4, $4)`,
        [cuid(), userId, ach.id, unlocked]
      );
    }

    // ── App Settings ─────────────────────────
    console.log("Creating app settings...");
    await client.query(
      `INSERT INTO app_settings (id, registration_enabled, default_locale)
       VALUES ('singleton', false, 'en')
       ON CONFLICT (id) DO UPDATE SET registration_enabled = false, default_locale = 'en'`
    );

    // ── Audit Log (some login entries) ──────
    console.log("Creating audit log entries...");
    for (let i = 0; i < 15; i++) {
      const loginDate = daysAgo(Math.floor(Math.random() * 30));
      await client.query(
        `INSERT INTO audit_logs (id, user_id, action, details, ip_address, created_at)
         VALUES ($1, $2, 'auth.login', '{"method":"password"}', '203.0.113.42', $3)`,
        [cuid(), userId, loginDate]
      );
    }

    await client.query("COMMIT");
    console.log("\nDemo data seeded successfully!");
    console.log(`  User: demo / demo123demo123`);
    console.log(`  Measurements: ${days * 6} entries (7 types, 90 days)`);
    console.log(`  Medications: 3 (with ${days * 2 + 60} intake events)`);
    console.log(`  Mood: ~${Math.round(days * 0.95)} entries`);
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
