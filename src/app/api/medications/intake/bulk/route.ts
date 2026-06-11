/**
 * `POST /api/medications/intake/bulk` — iOS SyncMode bulk backfill
 * for medication intake events.
 *
 * Mirrors the mood-entries bulk endpoint shape so the iOS sync
 * engine reuses the same retry / cursor plumbing for both.
 *
 * Body:
 *   { entries: BulkIntakeEntry[] }    — capped at 500 per call.
 *
 * Each entry:
 *   {
 *     medicationId,          — required (existing Medication row)
 *     scheduledFor,          — ISO timestamp (offset); defaults to now()
 *     takenAt?,              — ISO timestamp; omit + skipped=false = pending
 *     skipped?,              — boolean; default false
 *     idempotencyKey?,       — Medication.intake_events.idempotency_key
 *                              (existing UNIQUE column; serves as the
 *                              per-entry dedup hint)
 *     forceSlotInstant?,     — ISO timestamp; pins a taken entry onto a
 *                              named real scheduled slot (server-validated
 *                              against the band anchors)
 *   }
 *
 * Response (always 200): processed / inserted / duplicates / skipped /
 * entries[] mirroring the measurements + workouts batch envelope.
 *
 * Locked contract — see `.planning/v15-ios-handoff/06-ios-responsibilities.md`
 * §"Cumulative metrics" sibling section for the SyncMode rationale.
 */
import { NextRequest } from "next/server";
import { z } from "zod/v4";

import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { withIdempotency } from "@/lib/idempotency";
import { checkRateLimit } from "@/lib/rate-limit";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import {
  recomputeMedicationComplianceForDay,
  dayKeyForScheduledFor,
} from "@/lib/rollups/medication-compliance-rollups";
import {
  applyCanonicalSlotWrite,
  findPinConflict,
  resolveForcedSlotForWrite,
  resolveSlotForWriteByBand,
  resolveSlotInstantForWrite,
} from "@/lib/medications/scheduling/slot-upsert";
import { resolveInjectionSiteForWrite } from "@/lib/medications/injection-site-write";
import {
  injectionSiteEnum,
  type InjectionSiteValue,
} from "@/lib/validations/medication";
import type { InjectionSiteKey } from "@/lib/medications/injection-sites";

const MAX_ENTRIES_PER_BATCH = 500;
const BATCH_RATE_LIMIT_MAX = 60;
const BATCH_RATE_LIMIT_WINDOW_MS = 60 * 1000;

const bulkEntrySchema = z.object({
  medicationId: z.string().min(1),
  scheduledFor: z.iso
    .datetime({ offset: true })
    .transform((s) => new Date(s))
    .optional(),
  takenAt: z.iso
    .datetime({ offset: true })
    .transform((s) => new Date(s))
    .optional(),
  skipped: z.boolean().optional().default(false),
  idempotencyKey: z.string().min(1).max(128).optional(),
  // v1.8.5 — optional per-entry injection site. Validated against the
  // medication's effective allowed set; a disallowed site marks the
  // entry skipped (`injection_site_not_allowed`) without failing the
  // whole batch, matching the bulk endpoint's per-entry contract.
  injectionSite: injectionSiteEnum.optional(),
  // v1.15.20 — late-take "attribute anyway" pin, mirroring the single
  // intake route: pin a taken entry onto a named real scheduled slot
  // instead of the default window-band attribution. Validated server-side
  // against the band anchors; an instant that is not a slot marks the
  // entry skipped (`force_slot_invalid`) per the bulk per-entry contract.
  // Ignored on non-taken entries (a pending echo / skip carries no take
  // to attribute).
  forceSlotInstant: z.iso
    .datetime({ offset: true })
    .transform((s) => new Date(s))
    .optional(),
  // v1.16.4 — per-entry dose override, mirroring the single intake
  // route: free text (max 50 chars, like `Medication.dose`), persisted
  // only on a taken entry. Absent = the configured medication dose
  // applies.
  doseTaken: z.string().trim().min(1).max(50).optional(),
});

const bulkPayloadSchema = z.object({
  entries: z.array(bulkEntrySchema).min(1).max(MAX_ENTRIES_PER_BATCH),
});

// v1.8.2 — `updated` joins the per-entry status vocabulary: a write that
// snaps onto an existing scheduled-slot row (e.g. the pending REMINDER
// row) updates it in place rather than inserting. The iOS sync engine
// treats `updated` the same as `inserted` for cursor advancement — both
// mean "the server accepted this entry and produced a row id".
type EntryStatus = "inserted" | "updated" | "duplicate" | "skipped";
interface EntryResult {
  index: number;
  status: EntryStatus;
  reason?: string;
  id?: string;
}

export const POST = apiHandler(withIdempotency<[NextRequest]>(postBulk));

async function postBulk(request: NextRequest): Promise<Response> {
  const { user } = await requireAuth();

  const rl = await checkRateLimit(
    `medications:intake:bulk:${user.id}`,
    BATCH_RATE_LIMIT_MAX,
    BATCH_RATE_LIMIT_WINDOW_MS,
  );
  if (!rl.allowed) {
    return apiError("Too many bulk submissions, try again later", 429);
  }

  const { data: rawBody, error: jsonError } = await safeJson(request, {
    maxBytes: 2 * 1024 * 1024,
  });
  if (jsonError) return jsonError;

  if (
    typeof rawBody === "object" &&
    rawBody !== null &&
    "entries" in rawBody &&
    Array.isArray((rawBody as { entries: unknown }).entries) &&
    (rawBody as { entries: unknown[] }).entries.length > MAX_ENTRIES_PER_BATCH
  ) {
    return apiError(
      `Batch exceeds the ${MAX_ENTRIES_PER_BATCH}-entry limit`,
      422,
      { errorCode: "medications.intake.bulk.too_large" },
    );
  }

  const parsed = bulkPayloadSchema.safeParse(rawBody);
  if (!parsed.success) {
    // v1.4.43 W6 — bulk intake ingest; preserve the existing
    // `medications.intake.bulk.invalid` errorCode meta so the iOS
    // Sync engine's retry classifier still branches on it. Audit
    // breadcrumb keyed `medications.intake.bulk.validation-failed`.
    const issues = sanitiseZodIssues(parsed.error.issues);
    annotate({
      action: { name: "medications.intake.bulk.validation-failed" },
      meta: { issue_count: issues.length },
    });
    // v1.4.49 — strip `message` from the audit-ledger row.
    const auditIssues = sanitiseZodIssues(parsed.error.issues, {
      stripValuesFromMessage: true,
    });
    prisma.auditLog
      .create({
        data: {
          userId: user.id,
          action: "medications.intake.bulk.validation-failed",
          details: JSON.stringify({ issues: auditIssues }),
        },
      })
      .catch(() => {
        /* swallow — 422 response is the contract */
      });
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "medications.intake.bulk.invalid",
    });
  }

  const { entries } = parsed.data;

  // Up-front ownership check — the user can only POST intake events
  // against medications they own. One read covers every medicationId
  // in the batch.
  const medicationIds = Array.from(new Set(entries.map((e) => e.medicationId)));
  const ownedMedications = await prisma.medication.findMany({
    where: { id: { in: medicationIds }, userId: user.id },
    // v1.8.5 — pull the injection-tracking fields so a per-entry
    // `injectionSite` can be resolved + validated without an extra
    // per-entry read.
    select: {
      id: true,
      deliveryForm: true,
      trackInjectionSites: true,
      allowedInjectionSites: true,
    },
  });
  const ownedSet = new Set(ownedMedications.map((m) => m.id));
  const medById = new Map(ownedMedications.map((m) => [m.id, m]));

  // v1.8.5 — the user's global exclusion deny-list, loaded once for the
  // whole batch (it is user-scoped, not per-medication). Only read when
  // at least one entry actually carries an `injectionSite`, so the hot
  // sync path (no site) pays for zero extra round-trips.
  const batchHasInjectionSite = entries.some(
    (e) => e.injectionSite !== undefined,
  );
  let globalExcluded: InjectionSiteValue[] = [];
  if (batchHasInjectionSite) {
    const userRow = await prisma.user.findUnique({
      where: { id: user.id },
      select: { globalExcludedInjectionSites: true },
    });
    globalExcluded = (userRow?.globalExcludedInjectionSites ??
      []) as InjectionSiteValue[];
  }

  const results: EntryResult[] = [];
  let inserted = 0;
  let updated = 0;
  let duplicates = 0;
  const skipped: Array<{ index: number; reason: string }> = [];
  // v1.4.39 W-MED — collect distinct `(medicationId, dayKey)` pairs
  // touched by the batch so one rollup recompute fires per pair after
  // all inserts complete. Per-row recompute would balloon a 500-entry
  // batch into 500 sequential rollup hits.
  const touchedDays = new Map<
    string,
    { medicationId: string; dayKey: string }
  >();

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];

    if (!ownedSet.has(entry.medicationId)) {
      const reason = "medication_not_found";
      skipped.push({ index: i, reason });
      results.push({ index: i, status: "skipped", reason });
      continue;
    }

    try {
      const incomingScheduledFor =
        entry.scheduledFor ?? entry.takenAt ?? new Date();

      // C2 — classify the incoming write. An offline-sync replay echoes a
      // PENDING projection (no `takenAt`, `skipped:false`) for a slot the
      // user may already have actioned; that echo must NEVER clear a
      // recorded `takenAt`. An explicit `takenAt` or `skipped:true` is a
      // real user action and applies last-write-wins.
      const isExplicitTaken = !entry.skipped && entry.takenAt !== undefined;
      const isExplicitSkip = entry.skipped === true;

      // v1.15.20 — taken writes attribute through the window-band engine
      // (the SAME minter the read ledger + the compliance % consume), so a
      // bulk-synced take binds to a slot identically to the single-route
      // write. The optional `forceSlotInstant` pins an off-window take onto
      // a named real slot. Pending echoes and skips carry no take to
      // attribute by, so they keep the canonical anchor snap that binds
      // them to the projector/worker-minted slot row.
      let canonicalSlot: Date | null;
      // v1.15.20 — binding provenance: USER_PIN on the forced path, AUTO on
      // a band decision. Pending echoes / skips carry no decision
      // (undefined → the upsert leaves an existing USER_PIN untouched).
      let attributionSource: "AUTO" | "USER_PIN" | undefined;
      if (isExplicitTaken && entry.forceSlotInstant !== undefined) {
        canonicalSlot = await resolveForcedSlotForWrite({
          userId: user.id,
          medicationId: entry.medicationId,
          userTz: user.timezone,
          slotInstant: entry.forceSlotInstant,
        });
        if (canonicalSlot === null) {
          // Mirrors the single route's 422 (`medications.intake.force_slot
          // .invalid`) as a per-entry skip so one bad pin never fails the
          // batch.
          const reason = "force_slot_invalid";
          skipped.push({ index: i, reason });
          results.push({ index: i, status: "skipped", reason });
          continue;
        }
        // v1.16.0 — refuse to pin onto a slot another recorded action
        // already serves: the explicit-write last-write-wins rule would
        // silently overwrite that dose record. Per-entry skip, mirroring
        // the single route's 422 `medications.intake.force_slot.occupied`.
        if (
          await findPinConflict({
            userId: user.id,
            medicationId: entry.medicationId,
            canonicalSlot,
            incomingTakenAt: entry.takenAt ?? null,
          })
        ) {
          const reason = "force_slot_occupied";
          skipped.push({ index: i, reason });
          results.push({ index: i, status: "skipped", reason });
          continue;
        }
        attributionSource = "USER_PIN";
      } else if (isExplicitTaken) {
        const attribution = await resolveSlotForWriteByBand({
          userId: user.id,
          medicationId: entry.medicationId,
          userTz: user.timezone,
          takenAt: entry.takenAt as Date,
        });
        canonicalSlot = attribution.slotInstant;
        attributionSource = "AUTO";
      } else {
        // v1.8.2 — source-agnostic anchor snap for pending echoes + skips.
        // iOS posts the reminder actions here (source API); without this
        // they inserted a SECOND row for a slot already carrying the
        // projector/worker's pending REMINDER row (the unique key includes
        // `source`, and the iOS-vs-server `scheduledFor` drifts by a
        // minute). Snap onto the canonical slot instant and update the
        // existing row in place.
        canonicalSlot = await resolveSlotInstantForWrite({
          userId: user.id,
          medicationId: entry.medicationId,
          userTz: user.timezone,
          incoming: incomingScheduledFor,
          // Only a client-supplied `scheduledFor` names a real slot. A
          // defaulted-now write must not snap across the wide ±halfGap
          // window onto a far slot (phantom morning dose).
          instantIsExplicit: entry.scheduledFor !== undefined,
          // Pending echoes / skips never record a take; a pending sync
          // echo legitimately maps to a future slot, so the taken
          // future-slot guard stays off here.
          isTakenWrite: false,
        });
      }

      // The `scheduledFor` instant the row actually lands on — set by the
      // branch that performs the write so the rollup recompute below keys
      // the same day the stored row anchors to.
      let effectiveScheduledFor = canonicalSlot ?? incomingScheduledFor;

      // v1.8.5 — resolve + validate the optional per-entry injection
      // site. A disallowed site marks the entry skipped without failing
      // the batch (per-entry contract); a non-injection / tracking-off /
      // non-taken entry silently drops it.
      let resolvedInjectionSite: InjectionSiteKey | null = null;
      if (entry.injectionSite !== undefined) {
        const med = medById.get(entry.medicationId);
        const resolution = resolveInjectionSiteForWrite({
          submitted: entry.injectionSite,
          taken: isExplicitTaken,
          deliveryForm: med?.deliveryForm ?? "ORAL",
          trackInjectionSites: med?.trackInjectionSites ?? false,
          allowedInjectionSites: (med?.allowedInjectionSites ??
            []) as InjectionSiteKey[],
          globalExcludedInjectionSites: globalExcluded as InjectionSiteKey[],
        });
        if (resolution.kind === "disallowed") {
          const reason = "injection_site_not_allowed";
          skipped.push({ index: i, reason });
          results.push({ index: i, status: "skipped", reason });
          continue;
        }
        resolvedInjectionSite = resolution.site;
      }

      if (canonicalSlot) {
        // Scheduled dose — converge onto the one canonical slot row through
        // the shared upsert: H1 deterministic selection, C2 no-downgrade
        // guard, and a C1 race-safe create that re-finds + updates on a
        // P2002 collision rather than misclassifying it as a duplicate and
        // dropping the dose.
        const applied = await applyCanonicalSlotWrite({
          client: prisma,
          userId: user.id,
          medicationId: entry.medicationId,
          canonicalSlot,
          takenAt: entry.takenAt ?? null,
          skipped: entry.skipped,
          isExplicitTaken,
          isExplicitSkip,
          idempotencyKey: entry.idempotencyKey ?? null,
          createSource: "API",
          injectionSite: resolvedInjectionSite,
          attributionSource,
          // v1.16.4 — dose override only documents a consumed dose.
          doseTaken: (!entry.skipped && entry.doseTaken) || null,
        });
        if (applied.noDowngradeNoOp) {
          // C2 — pending echo onto an already-actioned slot. Report it as a
          // duplicate so the iOS cursor advances WITHOUT downgrading the
          // recorded dose.
          duplicates += 1;
          results.push({ index: i, status: "duplicate", id: applied.row.id });
        } else if (applied.outcome === "updated") {
          updated += 1;
          results.push({ index: i, status: "updated", id: applied.row.id });
        } else {
          inserted += 1;
          results.push({ index: i, status: "inserted", id: applied.row.id });
        }
      } else {
        // Resolver-null: PRN / off-slot / future-slot-guarded. Before the
        // standalone insert, two guards keep the slot from forking into a
        // second live row:
        //
        //   1. idempotencyKey replay pre-check — a re-submission returns the
        //      existing row as "duplicate" (previously reached via the P2002
        //      catch; the explicit probe keeps that contract now that a
        //      replay could otherwise converge as "updated" below).
        //   2. source-agnostic convergence probe — when ANY live row already
        //      sits on the incoming instant (e.g. the pending REMINDER row
        //      the worker pre-minted on a slot the taken-write future guard
        //      refused to snap to), converge onto THAT row through the shared
        //      slot upsert instead of inserting a sibling that differs only
        //      by `source`. The partial unique index carries `source`, so it
        //      cannot catch this duplicate; the probe must.
        if (entry.idempotencyKey) {
          const replay = await prisma.medicationIntakeEvent.findUnique({
            where: { idempotencyKey: entry.idempotencyKey },
            select: { id: true },
          });
          if (replay) {
            duplicates += 1;
            results.push({ index: i, status: "duplicate", id: replay.id });
            continue;
          }
        }
        // Only an explicit client `scheduledFor` names a slot a row could
        // already sit on; a defaulted anchor (takenAt / now) never does, so
        // the probe is skipped on that path.
        const existingSlotRow =
          entry.scheduledFor !== undefined
            ? await prisma.medicationIntakeEvent.findFirst({
                where: {
                  userId: user.id,
                  medicationId: entry.medicationId,
                  scheduledFor: incomingScheduledFor,
                  deletedAt: null,
                },
                select: { id: true },
              })
            : null;
        if (existingSlotRow) {
          const applied = await applyCanonicalSlotWrite({
            client: prisma,
            userId: user.id,
            medicationId: entry.medicationId,
            canonicalSlot: incomingScheduledFor,
            takenAt: entry.takenAt ?? null,
            skipped: entry.skipped,
            isExplicitTaken,
            isExplicitSkip,
            idempotencyKey: entry.idempotencyKey ?? null,
            createSource: "API",
            injectionSite: resolvedInjectionSite,
            attributionSource,
            doseTaken: (!entry.skipped && entry.doseTaken) || null,
          });
          if (applied.noDowngradeNoOp) {
            duplicates += 1;
            results.push({ index: i, status: "duplicate", id: applied.row.id });
          } else if (applied.outcome === "updated") {
            updated += 1;
            results.push({ index: i, status: "updated", id: applied.row.id });
          } else {
            inserted += 1;
            results.push({ index: i, status: "inserted", id: applied.row.id });
          }
        } else {
          // Genuinely standalone. Anchor the row on the intake instant —
          // the documented ad-hoc contract (`scheduledFor = takenAt`) — so
          // an unresolvable client anchor (a future slot instant the taken
          // guard rejected) can never park a live row exactly on a slot the
          // worker later mints a pending REMINDER row for. A pending echo
          // (no takenAt) keeps the incoming instant. The idempotencyKey,
          // when supplied, has a UNIQUE index; a racing re-submission
          // returns the existing row via P2002 → status: "duplicate".
          effectiveScheduledFor = entry.takenAt ?? incomingScheduledFor;
          const row = await prisma.medicationIntakeEvent.create({
            data: {
              userId: user.id,
              medicationId: entry.medicationId,
              scheduledFor: effectiveScheduledFor,
              takenAt: entry.takenAt ?? null,
              skipped: entry.skipped,
              source: "API",
              idempotencyKey: entry.idempotencyKey ?? null,
              // v1.8.5 — site only on a resolved taken-injection entry.
              ...(resolvedInjectionSite !== null && {
                injectionSite: resolvedInjectionSite,
              }),
              // v1.16.4 — dose override only on a taken entry carrying one.
              ...(!entry.skipped &&
                entry.doseTaken && { doseTaken: entry.doseTaken }),
            },
          });
          inserted += 1;
          results.push({ index: i, status: "inserted", id: row.id });
        }
      }
      const dayKey = dayKeyForScheduledFor(
        effectiveScheduledFor,
        user.timezone,
      );
      touchedDays.set(`${entry.medicationId}|${dayKey}`, {
        medicationId: entry.medicationId,
        dayKey,
      });
    } catch (err: unknown) {
      // P2002 = unique-constraint violation. Two shapes reach here:
      //   1. an idempotencyKey collision on the unscheduled/PRN insert →
      //      "duplicate" (the canonical-slot path already absorbs its own
      //      same-slot P2002 race inside `applyCanonicalSlotWrite`);
      //   2. a same-slot collision on the unscheduled insert. In both
      //      cases we surface the existing row id so the cursor advances.
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code: string }).code === "P2002"
      ) {
        const existing = entry.idempotencyKey
          ? await prisma.medicationIntakeEvent.findUnique({
              where: { idempotencyKey: entry.idempotencyKey },
              select: { id: true },
            })
          : null;
        duplicates += 1;
        results.push({
          index: i,
          status: "duplicate",
          id: existing?.id,
        });
        continue;
      }
      const reason =
        err instanceof Error ? err.message.slice(0, 120) : "create_failed";
      skipped.push({ index: i, reason });
      results.push({ index: i, status: "skipped", reason });
    }
  }

  await auditLog("medications.intake.bulk.ingest", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      processed: entries.length,
      inserted,
      updated,
      duplicates,
      skipped: skipped.length,
    },
  });

  annotate({
    action: { name: "medications.intake.bulk.ingest" },
    meta: {
      processed: entries.length,
      inserted,
      updated,
      duplicates,
      skipped: skipped.length,
    },
  });

  // v1.4.34 IW-G — bust per-user medications + compliance + achievement
  // caches when at least one row landed so the next read reflects the
  // ingested batch. v1.16.8 — hard-evict: this bulk endpoint is the iOS
  // user's INTERACTIVE intake path (a dose taken / skipped on the phone
  // syncs through here), so the very next read must show the user their
  // own action — a marked-stale SWR cell would hand back the pre-dose
  // payload. The genuinely background writers (the auto-miss cron in
  // `intake-auto-skip.ts`, slot dedup in `intake-slot-dedup.ts`) keep
  // the default mark-stale at their own call sites.
  if (inserted > 0 || updated > 0) {
    invalidateUserMedications(user.id, { evict: true });
  }

  // v1.4.39 W-MED — refresh one rollup row per distinct
  // `(medicationId, dayKey)` touched by the batch. Best-effort: failures
  // are swallowed by the helper's `recomputeMedicationComplianceForEvent`
  // wrapper, but bulk callers wrap recompute directly to keep the
  // tight ingest loop unaffected by populator issues.
  for (const { medicationId, dayKey } of touchedDays.values()) {
    try {
      await recomputeMedicationComplianceForDay(
        user.id,
        medicationId,
        dayKey,
        user.timezone,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      annotate({
        meta: {
          medication_compliance_rollup_bulk_failed: true,
          medication_compliance_rollup_bulk_error: message,
          medication_compliance_rollup_medication: medicationId,
          medication_compliance_rollup_day: dayKey,
        },
      });
    }
  }

  return apiSuccess({
    processed: entries.length,
    inserted,
    updated,
    duplicates,
    skipped,
    entries: results,
  });
}
