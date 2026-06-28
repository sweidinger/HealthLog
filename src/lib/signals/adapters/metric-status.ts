/**
 * Adapter: project the registry back to the `MetricStatusMeta` shape the
 * generic assessment path consumes today. The hand-written `REGISTRY` in
 * `metric-status-registry.ts` stays the live source for the assessment card
 * (untouched in this change); this projection exists so the registry-invariant
 * test can assert the two agree field-for-field and flag any future drift.
 */
import {
  METRIC_STATUS_IDS,
  type MetricStatusMeta,
  type MetricStatusMetricId,
} from "@/lib/insights/metric-status-registry";
import { getSignal } from "@/lib/signals/registry";

/** Build the `MetricStatusMeta` for one registered metric-status id. */
function metaFor(id: MetricStatusMetricId): MetricStatusMeta {
  const signal = getSignal(id);
  if (!signal || signal.kind === "biomarker") {
    throw new Error(`signal registry: no measurement signal for "${id}"`);
  }
  // Build field-by-field, omitting the optional keys when absent so the
  // projection matches the hand-written object shape exactly (deepEqual).
  const meta: MetricStatusMeta = {
    id,
    measurementType: signal.source.measurementType,
    displayName: signal.displayName,
    unit: signal.unit,
    direction: signal.direction,
    archetype: signal.archetype,
  };
  if (signal.normalRange !== undefined) meta.normalRange = signal.normalRange;
  if (signal.feverBandC !== undefined) meta.feverBandC = signal.feverBandC;
  return meta;
}

/** The full registry-derived metric-status table, keyed by metric-status id. */
export function deriveMetricStatusRegistry(): Record<
  MetricStatusMetricId,
  MetricStatusMeta
> {
  return Object.fromEntries(
    METRIC_STATUS_IDS.map((id) => [id, metaFor(id)]),
  ) as Record<MetricStatusMetricId, MetricStatusMeta>;
}
