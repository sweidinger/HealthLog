/**
 * GET / PUT / DELETE dashboard widget layout.
 *
 * GET returns the resolved effective layout (defaults merged in if the user
 * hasn't customized yet). PUT replaces the layout atomically. DELETE resets
 * to default.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess, apiError, safeJson } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
import {
  resolveDashboardLayout,
  serializeDashboardLayout,
  DEFAULT_DASHBOARD_LAYOUT,
  DASHBOARD_WIDGET_IDS,
  type DashboardLayout,
} from "@/lib/dashboard-layout";
import { Prisma } from "@/generated/prisma/client";
import { z } from "zod/v4";
import type { NextRequest } from "next/server";

// Single source of truth — every widget id rendered by the Settings →
// Dashboard UI (`src/components/settings/dashboard-layout-section.tsx`
// iterates the full layout from `DEFAULT_DASHBOARD_LAYOUT`). Missing
// one here makes the PUT 422 silently — the toast surfaces "Layout
// konnte nicht gespeichert werden" — and Marc's tile-toggle looks
// like it does nothing because the save round-trip never completes.
// v1.4.16 A5 root-cause: `achievements` was absent from this enum so
// every save attempted with the achievements widget present (i.e.
// every save against the default layout) was rejected. We now derive
// the enum from `DASHBOARD_WIDGET_IDS` so the two lists cannot drift.
const widgetIdEnum = z.enum(DASHBOARD_WIDGET_IDS);

const layoutSchema = z.object({
  version: z.literal(1),
  widgets: z
    .array(
      z.object({
        id: widgetIdEnum,
        visible: z.boolean(),
        // v1.4.15 Fix 5 — independent strip-tile visibility. Optional
        // for back-compat with v1.4.14 clients that haven't been
        // updated; the resolver mirrors `visible` when omitted.
        tileVisible: z.boolean().optional(),
        order: z.number().int().min(0).max(99),
      }),
    )
    .min(1)
    .max(20),
});

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();

  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { dashboardWidgetsJson: true },
  });

  const layout = resolveDashboardLayout(row?.dashboardWidgetsJson);
  return apiSuccess(layout);
});

export const PUT = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const { data: body, error: jsonError } = await safeJson(request);
  if (jsonError) return jsonError;

  const parsed = layoutSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.issues[0].message, 422);
  }

  const normalized = serializeDashboardLayout(parsed.data as DashboardLayout);

  await prisma.user.update({
    where: { id: user.id },
    data: {
      dashboardWidgetsJson: normalized as unknown as Prisma.InputJsonValue,
    },
  });

  annotate({
    action: { name: "dashboard.widgets.update" },
    meta: { visible_count: normalized.widgets.filter((w) => w.visible).length },
  });

  return apiSuccess(normalized);
});

export const DELETE = apiHandler(async () => {
  const { user } = await requireAuth();

  await prisma.user.update({
    where: { id: user.id },
    data: { dashboardWidgetsJson: Prisma.JsonNull },
  });

  annotate({ action: { name: "dashboard.widgets.reset" } });

  return apiSuccess(DEFAULT_DASHBOARD_LAYOUT);
});
