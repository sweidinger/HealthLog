/**
 * Transport-agnostic MCP resource registry.
 *
 * Resources expose read-only context the assistant can surface alongside tool
 * results (REQ-R10). Like the tools, they are server-authoritative reads of the
 * canonical tables scoped to the session `userId` — no new analytics, no
 * caller-supplied id. Absence is explicit via `{ present: false }` (REQ-SEC-4).
 *
 * The profile resource is deliberately data-minimised: it ships only the
 * health-relevant context an assistant needs (age in whole years, gender,
 * height, timezone, unit preferences) and omits direct identifiers (email,
 * username, role, insurance number) — narrowing the surface on the
 * external-assistant boundary.
 */
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import type { McpAuthContext } from "./auth";

export interface McpResourceDefinition {
  name: string;
  /** Fixed resource URI (e.g. `healthlog://profile`). */
  uri: string;
  title: string;
  description: string;
  mimeType: string;
  read: (ctx: McpAuthContext) => Promise<unknown>;
}

/** Whole-year age from a date of birth, or null when unknown. */
function ageYears(dateOfBirth: Date | null): number | null {
  if (!dateOfBirth) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - dateOfBirth.getUTCFullYear();
  const monthDelta = now.getUTCMonth() - dateOfBirth.getUTCMonth();
  if (
    monthDelta < 0 ||
    (monthDelta === 0 && now.getUTCDate() < dateOfBirth.getUTCDate())
  ) {
    age -= 1;
  }
  return age >= 0 && age < 150 ? age : null;
}

export const MCP_RESOURCES: McpResourceDefinition[] = [
  {
    name: "profile",
    uri: "healthlog://profile",
    title: "User profile",
    description:
      "The user's health-relevant profile context: age, gender, height, timezone, and unit preferences. Identifiers are omitted.",
    mimeType: "application/json",
    async read(ctx) {
      const user = await prisma.user.findUnique({
        where: { id: ctx.userId },
        select: {
          heightCm: true,
          dateOfBirth: true,
          gender: true,
          timezone: true,
          unitPreference: true,
          glucoseUnit: true,
        },
      });
      annotate({
        action: { name: "mcp.resource.read" },
        meta: { resource: "profile", present: user !== null },
      });
      if (!user) return { present: false };
      return {
        present: true,
        ageYears: ageYears(user.dateOfBirth),
        gender: user.gender ?? null,
        heightCm: user.heightCm ?? null,
        timezone: user.timezone,
        unitPreference:
          user.unitPreference === "imperial" ? "imperial" : "metric",
        glucoseUnit: user.glucoseUnit ?? "mg/dL",
      };
    },
  },
  {
    name: "medications",
    uri: "healthlog://medications",
    title: "Medications",
    description:
      "The user's tracked medications with their schedules (dose, cadence, time windows). Read-only list; use get_medication_compliance for adherence figures.",
    mimeType: "application/json",
    async read(ctx) {
      const medications = await prisma.medication.findMany({
        where: { userId: ctx.userId },
        include: { schedules: true },
        orderBy: { createdAt: "desc" },
      });
      annotate({
        action: { name: "mcp.resource.read" },
        meta: { resource: "medications", present: medications.length > 0 },
      });
      if (medications.length === 0) return { present: false, count: 0 };
      return {
        present: true,
        count: medications.length,
        medications: medications.map((med) => ({
          name: med.name,
          dose: med.dose,
          treatmentClass: med.treatmentClass,
          asNeeded: med.asNeeded,
          paused: med.pausedAt !== null,
          startsOn: med.startsOn ? med.startsOn.toISOString() : null,
          endsOn: med.endsOn ? med.endsOn.toISOString() : null,
          schedules: med.schedules.map((s) => ({
            label: s.label ?? null,
            dose: s.dose ?? null,
            windowStart: s.windowStart,
            windowEnd: s.windowEnd,
            timesOfDay: s.timesOfDay,
            daysOfWeek: s.daysOfWeek ?? null,
            rrule: s.rrule ?? null,
            rollingIntervalDays: s.rollingIntervalDays ?? null,
            scheduleType: s.scheduleType,
          })),
        })),
      };
    },
  },
];

/** Stable list of the registered resource URIs. */
export const MCP_RESOURCE_URIS: readonly string[] = MCP_RESOURCES.map(
  (r) => r.uri,
);
