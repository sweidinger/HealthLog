# Garmin (via Apple Health or Google Health Connect)

**There is no direct Garmin connector for a self-hosted HealthLog instance, and
there cannot be one.** Garmin's data-sharing program is business-partner-only:
it is approval-gated, requires a public callback endpoint, and is not the
"register your own app, paste a key" model the wearable integrations here rely
on. So instead of a broken half-integration, HealthLog reads Garmin data the
honest way — through the phone health platform your Garmin already feeds.

## The path that works

```
Garmin device  →  Garmin Connect  →  Apple Health (iOS)  ─┐
                                   →  Google Health Connect ├─→  HealthLog
                                      (Android)            ─┘
```

- **iOS:** Garmin Connect writes to Apple Health automatically. Import it with
  the existing [Apple Health](./apple-health.md) path (the `export.zip` upload or
  the native client's background sync).
- **Android:** since Garmin Connect 5.14.1 (July 2025) the app writes to **Google
  Health Connect**. Connect HealthLog through the existing
  [Google Health](./google-health.md) integration.

No extra code, no Garmin developer account, no approval queue — if your Garmin
already syncs to your phone's health platform, HealthLog already reads it.

## What comes through

Everything Garmin shares with Apple Health / Health Connect flows in: steps,
heart rate (including beat-to-beat variability), sleep stages (REM / deep /
light), calories (active and total), distance, weight and body composition,
cadence, and — partially — blood-oxygen saturation.

## What Garmin withholds

These are Garmin's **proprietary** scores. Garmin does **not** share them with
Apple Health or Health Connect, so no self-hosted integration — and no amount of
configuration — can obtain them. They are only available inside Garmin Connect
itself:

- Body Battery
- HRV Status
- VO₂ max
- Training Load and Training Effect
- Recovery Time
- Intensity Minutes
- Stress score
- Running dynamics

If you rely on those specific numbers, keep the Garmin Connect app for them;
everything else lands in HealthLog through the platform path above.
