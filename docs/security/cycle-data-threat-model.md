# Cycle-data threat model

A compact statement of what self-hosting HealthLog's cycle tracking
protects against and what it does not. Pair this with the operator
guidance in
[`self-hosting/reproductive-health-data.md`](../self-hosting/reproductive-health-data.md).

The scope here is reproductive-health data specifically (menstrual,
fertility, pregnancy, contraception, sexual-activity fields), because
that is the category where the "who can reach my data" question carries
the highest stakes.

## What self-hosting + encryption-at-rest protects against

- **A cloud vendor holding your data.** There is no SaaS account and no
  vendor key escrow. No third party can be served process for data it
  does not have.
- **A stolen disk or a leaked backup, while the key is held separately.**
  The intent-revealing fields are AES-256-GCM encrypted at rest; a disk
  image without the `ENCRYPTION_KEYS` value does not yield them.
- **Casual lock-screen disclosure.** Discreet notifications collapse
  every cycle reminder to a generic "HealthLog reminder" so the event is
  never named on a lock screen.
- **Third-party analytics / ad-tech leakage.** HealthLog ships no
  telemetry and no third-party trackers; cycle data is never sent to an
  analytics or advertising endpoint.

## What it does NOT protect against

- **Seizure or compulsion of your own host.** If the running machine is
  seized, imaged, or compelled, the data is on it. Encryption at rest
  does not help against a live host or a key stored beside the data.
- **Your hosting provider.** A VPS provider can snapshot the disk and
  can be served process. Self-hosting on rented infrastructure narrows
  the set of parties that hold the data; it does not eliminate them.
- **Your own backups.** Any `pg_dump` or off-host export carries the
  same data and must be protected as part of the same surface.
- **A compromised or unlocked client device.** A phone or laptop with a
  live session or cached client holds data locally. Server-side
  protection does nothing for an unlocked device.
- **Re-identification from "plaintext" fields.** Flow, basal body
  temperature, ovulation tests, cervical mucus, and cycle dates stay in
  plaintext so the engines can read them. They are health observations,
  not the disclosure-sensitive intent fields — but they are still
  health data on your host.

## The one-line version

Self-hosting means **no cloud vendor to subpoena**. It does **not** mean
the data is beyond reach: your own infrastructure, your provider, your
backups, and your devices are all still part of the surface. Size your
operator-side hardening to your own threat model.
